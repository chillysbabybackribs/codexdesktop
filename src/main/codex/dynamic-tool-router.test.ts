import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRequest, ResearchRunner } from '../browser/research-runner.js'
import type { DynamicToolCallParams } from '../../shared/codex-protocol/v2/DynamicToolCallParams.js'
import { routeDynamicToolCall } from './dynamic-tool-router.js'

function params(tool: string, args: DynamicToolCallParams['arguments'], namespace: string | null = null): DynamicToolCallParams {
  return { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', namespace, tool, arguments: args }
}

const unusedBrowser = {} as BrowserAgentController
const unusedResearch = {} as ResearchRunner

function textResult(response: Awaited<ReturnType<typeof routeDynamicToolCall>>): { ok: boolean; error?: string } {
  const item = response.contentItems[0]
  assert.equal(item?.type, 'inputText')
  if (item?.type !== 'inputText') assert.fail('expected inputText response')
  return JSON.parse(item.text) as { ok: boolean; error?: string }
}

test('dynamic tool router rejects provider namespaces', async () => {
  const response = await routeDynamicToolCall(params('browser_run', {}, 'provider'), {
    browserAgent: unusedBrowser,
    researchRunner: unusedResearch
  })

  assert.equal(response.success, false)
  assert.match(textResult(response).error ?? '', /unsupported dynamic tool namespace/)
})

test('dynamic tool router validates required browser_run code', async () => {
  const response = await routeDynamicToolCall(params('browser_run', { code: '   ' }), {
    browserAgent: unusedBrowser,
    researchRunner: unusedResearch
  })

  assert.equal(response.success, false)
  assert.match(textResult(response).error ?? '', /requires a string "code" argument/)
})

test('dynamic tool router normalizes research arguments and forwards the turn id', async () => {
  let request: ResearchRequest | null = null
  let runId: string | null = null
  const researchRunner = {
    run: async (next: ResearchRequest, nextRunId: string) => {
      request = next
      runId = nextRunId
      return { ok: true }
    }
  } as ResearchRunner
  const response = await routeDynamicToolCall(params('research_web', {
    queries: ['one', 2, 'two'],
    maxResults: 4,
    maxPages: 2,
    snippetChars: 1200
  }), { browserAgent: unusedBrowser, researchRunner })

  assert.equal(response.success, true)
  assert.deepEqual(request, { queries: ['one', 'two'], maxResults: 4, maxPages: 2, snippetChars: 1200 })
  assert.equal(runId, 'turn-1')
})
