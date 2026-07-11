import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { CodexConnectionStatus } from '../../shared/ipc.js'
import { AppServerProcess } from './app-server-process.js'

type FakeChild = Omit<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr'> & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  emit: EventEmitter['emit']
}

function createChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill() {
      this.killed = true
      return true
    }
  })
  return child as unknown as FakeChild
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('app-server process deduplicates startup and forwards lines and writes', async () => {
  const child = createChild()
  const statuses: CodexConnectionStatus[] = []
  const lines: string[] = []
  const writes: string[] = []
  let initializeCount = 0
  let finishInitialization!: () => void
  const initialization = new Promise<void>((resolve) => { finishInitialization = resolve })
  child.stdin.on('data', (chunk) => writes.push(String(chunk)))
  const process = new AppServerProcess({
    spawnProcess: () => child,
    onLine: (line) => lines.push(line),
    onStopped: () => {},
    onStatus: (status) => statuses.push(status)
  })
  const initialize = () => {
    initializeCount += 1
    return initialization
  }

  const firstStart = process.ensureStarted(initialize)
  const secondStart = process.ensureStarted(initialize)
  child.stdout.write('{"method":"initialized"}\n')
  await nextImmediate()

  assert.equal(initializeCount, 1)
  assert.deepEqual(lines, ['{"method":"initialized"}'])
  process.write({ jsonrpc: '2.0', method: 'ping' })
  assert.deepEqual(writes, ['{"jsonrpc":"2.0","method":"ping"}\n'])

  finishInitialization()
  await Promise.all([firstStart, secondStart])
  await process.ensureStarted(initialize)
  assert.deepEqual(statuses, ['starting', 'ready', 'ready'])
  assert.equal(initializeCount, 1)
  process.dispose()
})

test('app-server process reports exits and rejects further writes', async () => {
  const child = createChild()
  const statuses: Array<{ status: CodexConnectionStatus; message?: string }> = []
  const stopped: Error[] = []
  const process = new AppServerProcess({
    spawnProcess: () => child,
    onLine: () => {},
    onStopped: (error) => stopped.push(error),
    onStatus: (status, message) => statuses.push({ status, message })
  })

  await process.ensureStarted(async () => {})
  child.emit('exit', 12, null)

  assert.equal(statuses.at(-1)?.status, 'exited')
  assert.match(statuses.at(-1)?.message ?? '', /exited \(12\)/)
  assert.match(stopped[0]?.message ?? '', /exited \(12\)/)
  assert.throws(() => process.write({ method: 'ping' }), /not running/)
})

test('app-server process cleans up a failed initialization and can retry', async () => {
  const firstChild = createChild()
  const secondChild = createChild()
  const children = [firstChild, secondChild]
  const process = new AppServerProcess({
    spawnProcess: () => children.shift()!,
    onLine: () => {},
    onStopped: () => {},
    onStatus: () => {}
  })

  await assert.rejects(process.ensureStarted(async () => {
    throw new Error('initialization failed')
  }), /initialization failed/)
  assert.equal(firstChild.killed, true)

  await process.ensureStarted(async () => {})
  process.write({ method: 'ready' })
  process.dispose()
  assert.equal(secondChild.killed, true)
})
