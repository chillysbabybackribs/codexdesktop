import assert from 'node:assert/strict'
import test from 'node:test'
import { AppServerRpc, type JsonRpcMessage, type JsonRpcRequestMessage } from './app-server-rpc.js'

function createRpc(overrides: Partial<ConstructorParameters<typeof AppServerRpc>[0]> = {}) {
  const writes: JsonRpcMessage[] = []
  const notifications: JsonRpcMessage[] = []
  const requests: JsonRpcRequestMessage[] = []
  const invalidLines: string[] = []
  const rpc = new AppServerRpc({
    write: (message) => writes.push(message),
    onNotification: (message) => notifications.push(message),
    onRequest: (message) => requests.push(message),
    onInvalidLine: (line) => invalidLines.push(line),
    ...overrides
  })
  return { rpc, writes, notifications, requests, invalidLines }
}

test('app-server RPC correlates a response with its request', async () => {
  const { rpc, writes } = createRpc()
  const resultPromise = rpc.request<{ ready: boolean }>('initialize', { client: 'desktop' })

  assert.deepEqual(writes[0], {
    jsonrpc: '2.0',
    id: 'codexdesktop-1',
    method: 'initialize',
    params: { client: 'desktop' }
  })

  rpc.handleLine('{"jsonrpc":"2.0","id":"codexdesktop-1","result":{"ready":true}}')
  assert.deepEqual(await resultPromise, { ready: true })
})

test('app-server RPC routes requests, notifications, and outbound responses', () => {
  const { rpc, writes, notifications, requests } = createRpc()

  rpc.handleLine('{"jsonrpc":"2.0","id":7,"method":"currentTime/read","params":{}}')
  rpc.handleLine('{"jsonrpc":"2.0","method":"thread/started","params":{"threadId":"thread-1"}}')
  rpc.respond(7, { currentTimeAt: 123 })
  rpc.respondError(8, -32601, 'Unsupported request')
  rpc.notify('initialized')

  assert.equal(requests[0]?.method, 'currentTime/read')
  assert.equal(notifications[0]?.method, 'thread/started')
  assert.deepEqual(writes, [
    { jsonrpc: '2.0', id: 7, result: { currentTimeAt: 123 } },
    { jsonrpc: '2.0', id: 8, error: { code: -32601, message: 'Unsupported request' } },
    { jsonrpc: '2.0', method: 'initialized', params: undefined }
  ])
})

test('app-server RPC rejects remote errors and all pending work on shutdown', async () => {
  const { rpc } = createRpc()
  const remoteError = rpc.request('first')
  const stopped = rpc.request('second')

  rpc.handleLine('{"jsonrpc":"2.0","id":"codexdesktop-1","error":{"code":-1,"message":"failed"}}')
  rpc.rejectPending(new Error('stopped'))

  await assert.rejects(remoteError, /failed/)
  await assert.rejects(stopped, /stopped/)
})

test('app-server RPC ignores blank, malformed, and non-object lines', () => {
  const { rpc, invalidLines, notifications, requests } = createRpc()

  rpc.handleLine('   ')
  rpc.handleLine('not json')
  rpc.handleLine('null')

  assert.deepEqual(invalidLines, ['not json', 'null'])
  assert.deepEqual(notifications, [])
  assert.deepEqual(requests, [])
})

test('app-server RPC reassembles a JSON response split across stdout lines', async () => {
  const { rpc } = createRpc()
  const response = rpc.request<{ description: string }>('plugin/list')

  rpc.handleLine('{"id":"codexdesktop-1","result":{"description":"First part')
  rpc.handleLine('\\n\\nSecond part"}}')

  assert.deepEqual(await response, { description: 'First part\n\nSecond part' })
})

test('app-server RPC resynchronizes after a malformed partial line before a valid response', async () => {
  const { rpc, invalidLines } = createRpc()
  const response = rpc.request<{ ready: boolean }>('initialize')

  rpc.handleLine('{"jsonrpc":"2.0","method":"thread/started","params":')
  rpc.handleLine('{"jsonrpc":"2.0","id":"codexdesktop-1","result":{"ready":true}}')

  assert.deepEqual(await response, { ready: true })
  assert.equal(invalidLines.length, 1)
  assert.match(invalidLines[0] ?? '', /thread\/started/)
})

test('app-server RPC resynchronizes notifications after a malformed partial line', () => {
  const { rpc, invalidLines, notifications } = createRpc()

  rpc.handleLine('{"jsonrpc":"2.0","method":"thread/started","params":')
  rpc.handleLine('{"jsonrpc":"2.0","method":"thread/started","params":{"threadId":"thread-2"}}')

  assert.equal(invalidLines.length, 1)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0]?.method, 'thread/started')
})

test('app-server RPC discards a partial message when its transport stops', () => {
  const { rpc, notifications } = createRpc()

  rpc.handleLine('{"jsonrpc":"2.0","method":"thread/started","params":')
  rpc.rejectPending(new Error('app-server stopped'))
  rpc.handleLine('{"jsonrpc":"2.0","method":"thread/started","params":{"threadId":"thread-2"}}')

  assert.equal(notifications.length, 1)
  assert.equal(notifications[0]?.method, 'thread/started')
})

test('app-server RPC clears a pending request when writing fails', async () => {
  const rpc = new AppServerRpc({
    write: () => { throw new Error('pipe closed') },
    onNotification: () => {},
    onRequest: () => {}
  })

  await assert.rejects(rpc.request('initialize'), /pipe closed/)
  rpc.rejectPending(new Error('should have no pending work'))
})

test('app-server RPC times out unanswered requests', async () => {
  const { rpc } = createRpc({ requestTimeoutMs: 1 })

  await assert.rejects(rpc.request('slow/request'), /Codex request timed out: slow\/request/)
})
