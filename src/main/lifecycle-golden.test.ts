import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import type { WebContents } from 'electron'
import type { BrowserAgentController } from './browser/browser-agent.ts'
import { BrowserAgentController as BrowserAgent } from './browser/browser-agent.ts'
import type { TabManager } from './browser/tab-manager.ts'
import { BrowserTargetRegistry } from './browser/browser-target-registry.ts'
import { cdpSessionFor, disposeCdpSession } from './browser/cdp-session.ts'
import { AppServerProcess } from './codex/app-server-process.ts'
import { AppServerRpc } from './codex/app-server-rpc.ts'
import { routeDynamicToolCall } from './codex/dynamic-tool-router.ts'
import type { DynamicToolCallParams } from '../shared/codex-protocol/v2/DynamicToolCallParams.ts'
import type { ResearchRunner } from './browser/research-runner.ts'

type FakeChild = Omit<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr'> & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  emit: EventEmitter['emit']
}

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill() {
      this.killed = true
      return true
    }
  }) as unknown as FakeChild
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function dynamicParams(): DynamicToolCallParams {
  return {
    threadId: 'thread-golden',
    turnId: 'turn-golden',
    callId: 'call-golden',
    namespace: null,
    tool: 'browser_run',
    arguments: { code: 'return document.title' }
  }
}

test('golden restart: a crashed app-server rejects stale work and the replacement process resumes cleanly', async () => {
  const first = fakeChild()
  const replacement = fakeChild()
  const children = [first, replacement]
  let rpc!: AppServerRpc
  const process = new AppServerProcess({
    spawnProcess: () => children.shift()!,
    onLine: (line) => rpc.handleLine(line),
    onStopped: (error) => rpc.rejectPending(error),
    onStatus: () => {}
  })
  rpc = new AppServerRpc({
    write: (message) => process.write(message),
    onNotification: () => {},
    onRequest: () => {},
    requestIdPrefix: 'golden'
  })

  await process.ensureStarted(async () => {})
  const staleRequest = rpc.request('thread/resume', { threadId: 'thread-golden' })
  // This is a valid-looking but incomplete response from the process that is
  // about to exit. A replacement must never inherit this parser state.
  first.stdout.write('{"jsonrpc":"2.0","id":"golden-1"\n')
  await nextImmediate()
  first.emit('exit', 1, null)
  await assert.rejects(staleRequest, /exited \(1\)/)

  await process.ensureStarted(async () => {})
  const resumed = rpc.request<{ resumed: boolean }>('thread/resume', { threadId: 'thread-golden' })
  replacement.stdout.write('{"jsonrpc":"2.0","id":"golden-2","result":{"resumed":true}}\n')

  assert.deepEqual(await resumed, { resumed: true })
  process.dispose()
})

test('golden cancellation: a turn-owned browser call is dropped while queued behind a shared-tab operation', async () => {
  let releaseFirst!: () => void
  let executions = 0
  const webContents = {
    executeJavaScript: async () => {
      executions += 1
      if (executions === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve })
      }
      return { title: 'Golden page' }
    },
    getURL: () => 'https://example.test/golden',
    getTitle: () => 'Golden page',
    isDestroyed: () => false
  }
  const tabs = {
    getActiveTabId: () => 'tab-golden',
    resolveWebContents: () => webContents,
    listTabs: () => [],
    listTargets: () => []
  } as unknown as TabManager
  const browserAgent = new BrowserAgent(() => tabs)

  const foreground = browserAgent.run('return "foreground"')
  await nextImmediate()
  const routed = routeDynamicToolCall(dynamicParams(), {
    browserAgent,
    researchRunner: {} as ResearchRunner
  })
  await nextImmediate()

  browserAgent.cancelTurn('thread-golden', 'turn-golden')
  releaseFirst()

  await foreground
  const response = await routed
  const item = response.contentItems[0]
  assert.equal(item?.type, 'inputText')
  if (item?.type !== 'inputText') assert.fail('expected the routed browser response')
  const result = JSON.parse(item.text) as { ok: boolean; errorCode?: string }
  assert.equal(response.success, false)
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'cancelled')
  assert.equal(executions, 1, 'the cancelled turn never reached the shared browser target')
})

test('golden browser ownership: a closed target ends browser work for that turn instead of reusing another active tab', async () => {
  let activeTabId = 'tab-closed'
  let fallbackExecutions = 0
  const fallbackContents = {
    executeJavaScript: async () => {
      fallbackExecutions += 1
      return { outcome: 'not_found' }
    },
    getURL: () => 'https://example.test/fallback',
    getTitle: () => 'Fallback tab',
    isDestroyed: () => false
  }
  const tabs = {
    getActiveTabId: () => activeTabId,
    resolveWebContents: (tabId: string) => tabId === 'tab-fallback' ? fallbackContents : null,
    listTabs: () => [],
    listTargets: () => []
  } as unknown as TabManager
  const browserAgent = new BrowserAgent(() => tabs)
  const first = await routeDynamicToolCall({
    ...dynamicParams(),
    tool: 'browser_flow',
    arguments: { steps: [{ type: 'wait', selector: '#phase5-never-exists' }] }
  }, { browserAgent, researchRunner: {} as ResearchRunner })
  const firstResult = JSON.parse((first.contentItems[0] as { type: 'inputText'; text: string }).text) as { errorCode?: string }
  assert.equal(firstResult.errorCode, 'targetClosed')

  activeTabId = 'tab-fallback'
  const second = await routeDynamicToolCall({
    ...dynamicParams(),
    callId: 'call-after-close',
    tool: 'browser_flow',
    arguments: { steps: [{ type: 'wait', selector: '#phase5-never-exists' }] }
  }, { browserAgent, researchRunner: {} as ResearchRunner })
  const secondResult = JSON.parse((second.contentItems[0] as { type: 'inputText'; text: string }).text) as { error?: string; errorCode?: string }
  assert.equal(second.success, false)
  assert.equal(secondResult.errorCode, 'targetClosed')
  assert.match(secondResult.error ?? '', /start a new user request/i)
  assert.equal(fallbackExecutions, 0, 'the newly active tab is never reused by the failed turn')

  browserAgent.completeTurn('thread-golden', 'turn-golden')
  const nextTurn = await routeDynamicToolCall({
    ...dynamicParams(),
    turnId: 'turn-next',
    callId: 'call-next',
    tool: 'browser_flow',
    arguments: { steps: [{ type: 'wait', selector: '#phase5-never-exists' }] }
  }, { browserAgent, researchRunner: {} as ResearchRunner })
  assert.equal(nextTurn.success, true)
  assert.equal(fallbackExecutions, 1, 'a new user turn may intentionally use the active tab')
})

class FakeDebugger extends EventEmitter {
  attached = false
  detachCalls = 0

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  detach(): void {
    this.detachCalls += 1
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }

  async sendCommand(method: string): Promise<unknown> {
    return { method }
  }
}

class FakeBrowserContents extends EventEmitter {
  readonly id = 99
  readonly debugger = new FakeDebugger()
  destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  getURL(): string {
    return 'https://example.test/popup'
  }

  getTitle(): string {
    return 'Golden popup'
  }

  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('destroyed')
  }
}

test('golden browser ownership: closing a popup releases its CDP session and target registration exactly once', async () => {
  const contents = new FakeBrowserContents()
  const targets = new BrowserTargetRegistry()
  targets.registerPopup(contents as unknown as WebContents, 'tab-golden')
  const session = cdpSessionFor(contents as unknown as WebContents)
  await session.send('Page.enable')

  assert.equal(targets.resolvePopup('popup-99'), contents)
  assert.equal(contents.debugger.isAttached(), true)
  disposeCdpSession(contents as unknown as WebContents)
  disposeCdpSession(contents as unknown as WebContents)
  contents.close()

  assert.equal(contents.debugger.detachCalls, 1)
  assert.equal(contents.debugger.listenerCount('message'), 0)
  assert.equal(contents.debugger.listenerCount('detach'), 0)
  assert.equal(targets.resolvePopup('popup-99'), null)
})
