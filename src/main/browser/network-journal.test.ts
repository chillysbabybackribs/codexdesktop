import assert from 'node:assert/strict'
import test from 'node:test'
import { NetworkJournal } from './network-journal.ts'

test('network journal correlates requests, responses, completion, and failures without headers', () => {
  const journal = new NetworkJournal()
  journal.start()
  journal.record('Network.requestWillBeSent', {
    requestId: 'one', timestamp: 10, wallTime: 1_700_000_000,
    type: 'Fetch', initiator: { type: 'script' },
    request: { url: 'https://example.com/api/items', method: 'POST', headers: { authorization: 'secret' }, postData: 'secret' }
  })
  journal.record('Network.responseReceived', {
    requestId: 'one', type: 'Fetch',
    response: { status: 201, statusText: 'Created', mimeType: 'application/json', protocol: 'h2' }
  })
  journal.record('Network.loadingFinished', { requestId: 'one', timestamp: 10.125, encodedDataLength: 512 })
  journal.record('Network.requestWillBeSent', {
    requestId: 'two', timestamp: 11,
    request: { url: 'https://example.com/missing.js', method: 'GET' }
  })
  journal.record('Network.loadingFailed', { requestId: 'two', timestamp: 11.05, errorText: 'net::ERR_FAILED' })

  const page = journal.page({ limit: 10 })
  assert.equal(page.active, true)
  assert.equal(page.requests.length, 2)
  assert.deepEqual(page.requests[0], {
    sequence: 1,
    requestId: 'one',
    url: 'https://example.com/api/items',
    method: 'POST',
    resourceType: 'Fetch',
    initiatorType: 'script',
    status: 201,
    statusText: 'Created',
    mimeType: 'application/json',
    protocol: 'h2',
    fromDiskCache: false,
    fromServiceWorker: false,
    encodedDataLength: 512,
    failed: false,
    canceled: false,
    errorText: null,
    blockedReason: null,
    startedAt: '2023-11-14T22:13:20.000Z',
    completedAt: page.requests[0].completedAt,
    durationMs: 125
  })
  assert.equal(JSON.stringify(page).includes('secret'), false)
  assert.equal(page.requests[1].failed, true)
})

test('network journal summarizes websocket traffic and supports focused request queries', () => {
  const journal = new NetworkJournal()
  journal.start()
  journal.record('Network.requestWillBeSent', { requestId: 'doc', type: 'Document', request: { url: 'https://example.com', method: 'GET' } })
  journal.record('Network.responseReceived', { requestId: 'doc', response: { status: 200 } })
  journal.record('Network.requestWillBeSent', { requestId: 'api', type: 'Fetch', request: { url: 'https://example.com/api/data', method: 'GET' } })
  journal.record('Network.responseReceived', { requestId: 'api', response: { status: 503 } })
  journal.record('Network.webSocketCreated', { requestId: 'ws', url: 'wss://example.com/live' })
  journal.record('Network.webSocketHandshakeResponseReceived', { requestId: 'ws', response: { status: 101 } })
  journal.record('Network.webSocketFrameSent', { requestId: 'ws', response: { payloadData: 'hello' } })
  journal.record('Network.webSocketFrameReceived', { requestId: 'ws', response: { payloadData: 'world!' } })
  journal.record('Network.webSocketClosed', { requestId: 'ws' })

  const page = journal.page({ urlContains: '/api/', statusMin: 500 })
  assert.deepEqual(page.requests.map(({ requestId }) => requestId), ['api'])
  assert.equal(page.webSockets[0].status, 101)
  assert.equal(page.webSockets[0].sentFrames, 1)
  assert.equal(page.webSockets[0].receivedBytes, 6)
  assert.equal(typeof page.webSockets[0].closedAt, 'string')
})

test('network journal remains bounded', () => {
  const journal = new NetworkJournal()
  journal.start()
  for (let index = 0; index < 270; index += 1) {
    journal.record('Network.requestWillBeSent', {
      requestId: String(index),
      request: { url: `https://example.com/${index}`, method: 'GET' }
    })
  }

  const page = journal.page({ limit: 100 })
  assert.equal(page.totalRequests, 256)
  assert.equal(page.droppedRequests, 14)
  assert.equal(page.requests.length, 100)
  assert.equal(page.hasMoreMatching, true)
  assert.equal(journal.request('0'), null)
})
