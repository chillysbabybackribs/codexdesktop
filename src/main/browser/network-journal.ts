const maxRequests = 256
const maxWebSockets = 64
const maxStreamCaptureBytes = 20 * 1024 * 1024

export type NetworkStreamTransport = 'sse' | 'websocket'

export type NetworkStreamMessage = {
  sequence: number
  transport: NetworkStreamTransport
  requestId: string
  direction: 'received' | 'sent'
  recordedAt: string
  data: string
  bytes: number
  eventName: string | null
  eventId: string | null
  opcode: number | null
  encoding: 'utf8' | 'base64'
}

export type NetworkStreamCapture = {
  transport: NetworkStreamTransport
  requestId: string
  url: string
  status: number | null
  messages: NetworkStreamMessage[]
  messageCount: number
  bytes: number
  completedReason: 'idle' | 'limit' | 'bytes' | 'closed'
  startedAt: string
  completedAt: string
}

export type NetworkRequestSummary = {
  sequence: number
  requestId: string
  url: string
  method: string
  resourceType: string | null
  initiatorType: string | null
  status: number | null
  statusText: string | null
  mimeType: string | null
  protocol: string | null
  fromDiskCache: boolean
  fromServiceWorker: boolean
  encodedDataLength: number
  failed: boolean
  canceled: boolean
  errorText: string | null
  blockedReason: string | null
  startedAt: string
  completedAt: string | null
  durationMs: number | null
}

export type WebSocketSummary = {
  sequence: number
  requestId: string
  url: string
  status: number | null
  sentFrames: number
  receivedFrames: number
  sentBytes: number
  receivedBytes: number
  openedAt: string
  closedAt: string | null
}

export type NetworkJournalQuery = {
  limit?: number | null
  urlContains?: string | null
  method?: string | null
  resourceType?: string | null
  mimeType?: string | null
  statusMin?: number | null
  statusMax?: number | null
  failedOnly?: boolean | null
  completedOnly?: boolean | null
}

export type NetworkJournalPage = {
  active: boolean
  startedAt: string | null
  requests: NetworkRequestSummary[]
  webSockets: WebSocketSummary[]
  totalRequests: number
  totalWebSockets: number
  droppedRequests: number
  droppedWebSockets: number
  hasMoreMatching: boolean
}

type MutableRequest = NetworkRequestSummary & {
  startedTimestamp: number | null
}

type MutableWebSocket = WebSocketSummary

type NetworkRequestWaiter = {
  query: NetworkJournalQuery
  resolve: (request: NetworkRequestSummary) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

type NetworkStreamWaiter = {
  transport: NetworkStreamTransport
  query: NetworkJournalQuery
  maxMessages: number
  idleMs: number
  requestId: string | null
  url: string | null
  status: number | null
  startedAt: string
  messages: NetworkStreamMessage[]
  bytes: number
  resolve: (capture: NetworkStreamCapture) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  idleTimer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

export class NetworkJournal {
  private active = false
  private startedAt: string | null = null
  private sequence = 0
  private droppedRequests = 0
  private droppedWebSockets = 0
  private streamSequence = 0
  private readonly requests: MutableRequest[] = []
  private readonly requestsById = new Map<string, MutableRequest>()
  private readonly webSockets: MutableWebSocket[] = []
  private readonly webSocketsById = new Map<string, MutableWebSocket>()
  private readonly requestWaiters = new Set<NetworkRequestWaiter>()
  private readonly streamWaiters = new Set<NetworkStreamWaiter>()

  start(): void {
    this.rejectRequestWaiters(new Error('network journal restarted while waiting for a request'))
    this.rejectStreamWaiters(new Error('network journal restarted while waiting for a stream'))
    this.active = true
    this.startedAt = new Date().toISOString()
    this.sequence = 0
    this.droppedRequests = 0
    this.droppedWebSockets = 0
    this.streamSequence = 0
    this.requests.length = 0
    this.requestsById.clear()
    this.webSockets.length = 0
    this.webSocketsById.clear()
  }

  stop(): void {
    this.active = false
    this.rejectRequestWaiters(new Error('network journal stopped while waiting for a request'))
    this.rejectStreamWaiters(new Error('network journal stopped while waiting for a stream'))
  }

  isActive(): boolean {
    return this.active
  }

  record(method: string, value: unknown): void {
    if (!this.active || !method.startsWith('Network.')) return
    const params = asRecord(value)
    const requestId = readString(params.requestId)
    if (!requestId) return

    if (method === 'Network.requestWillBeSent') {
      this.recordRequest(requestId, params)
      return
    }
    if (method === 'Network.responseReceived') {
      const request = this.requestsById.get(requestId)
      if (!request) return
      const response = asRecord(params.response)
      request.resourceType = readString(params.type) ?? request.resourceType
      request.status = readNumber(response.status)
      request.statusText = readString(response.statusText)
      request.mimeType = readString(response.mimeType)
      request.protocol = readString(response.protocol)
      request.fromDiskCache = response.fromDiskCache === true
      request.fromServiceWorker = response.fromServiceWorker === true
      this.resolveRequestWaiters(request)
      this.selectStreamWaiters('sse', request.requestId, request.url, request.status, request)
      return
    }
    if (method === 'Network.dataReceived') {
      const request = this.requestsById.get(requestId)
      if (request) request.encodedDataLength += readNumber(params.encodedDataLength) ?? 0
      return
    }
    if (method === 'Network.requestServedFromCache') {
      const request = this.requestsById.get(requestId)
      if (request) request.fromDiskCache = true
      return
    }
    if (method === 'Network.loadingFinished') {
      const request = this.requestsById.get(requestId)
      if (!request) return
      request.encodedDataLength = readNumber(params.encodedDataLength) ?? request.encodedDataLength
      this.completeRequest(request, params)
      this.resolveRequestWaiters(request)
      return
    }
    if (method === 'Network.loadingFailed') {
      const request = this.requestsById.get(requestId)
      if (!request) return
      request.failed = true
      request.canceled = params.canceled === true
      request.errorText = readString(params.errorText)
      request.blockedReason = readString(params.blockedReason)
      this.completeRequest(request, params)
      this.resolveRequestWaiters(request)
      return
    }
    if (method === 'Network.eventSourceMessageReceived') {
      const request = this.requestsById.get(requestId)
      if (!request) return
      this.selectStreamWaiters('sse', requestId, request.url, request.status, request)
      this.recordStreamMessage({
        transport: 'sse',
        requestId,
        direction: 'received',
        data: readString(params.data) ?? '',
        eventName: readString(params.eventName),
        eventId: readString(params.eventId),
        opcode: null,
        encoding: 'utf8'
      })
      return
    }
    if (method === 'Network.webSocketCreated') {
      this.recordWebSocket(requestId, params)
      return
    }

    const socket = this.webSocketsById.get(requestId)
    if (!socket) return
    if (method === 'Network.webSocketHandshakeResponseReceived') {
      socket.status = readNumber(asRecord(params.response).status)
      this.selectStreamWaiters('websocket', requestId, socket.url, socket.status)
      this.updateStreamWaiterStatus(requestId, socket.status)
    } else if (method === 'Network.webSocketFrameSent') {
      const frame = asRecord(params.response)
      socket.sentFrames += 1
      socket.sentBytes += frameBytes(frame)
      this.recordWebSocketFrame(requestId, 'sent', frame)
    } else if (method === 'Network.webSocketFrameReceived') {
      const frame = asRecord(params.response)
      socket.receivedFrames += 1
      socket.receivedBytes += frameBytes(frame)
      this.recordWebSocketFrame(requestId, 'received', frame)
    } else if (method === 'Network.webSocketClosed') {
      socket.closedAt = new Date().toISOString()
      this.closeStreamWaiters(requestId)
    }
  }

  page(query: NetworkJournalQuery = {}): NetworkJournalPage {
    const limit = clampInteger(query.limit, 50, 1, 100)
    const matching = this.requests.filter((request) => matchesRequest(request, query))
    const requests = matching.slice(-limit).map(publicRequest)
    const webSockets = this.webSockets.slice(-Math.min(limit, maxWebSockets)).map((socket) => ({ ...socket }))
    return {
      active: this.active,
      startedAt: this.startedAt,
      requests,
      webSockets,
      totalRequests: this.requests.length,
      totalWebSockets: this.webSockets.length,
      droppedRequests: this.droppedRequests,
      droppedWebSockets: this.droppedWebSockets,
      hasMoreMatching: matching.length > requests.length
    }
  }

  request(requestId: string): NetworkRequestSummary | null {
    const request = this.requestsById.get(requestId)
    return request ? publicRequest(request) : null
  }

  waitForRequest(
    query: NetworkJournalQuery,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<NetworkRequestSummary> {
    const existing = this.requests.find((request) => matchesRequest(request, query))
    if (existing) return Promise.resolve(publicRequest(existing))
    if (!this.active) return Promise.reject(new Error('network journal is not active'))

    return new Promise<NetworkRequestSummary>((resolve, reject) => {
      const waiter: NetworkRequestWaiter = {
        query,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.settleRequestWaiter(waiter)
          reject(new Error(`network request wait timed out after ${timeoutMs}ms${query.urlContains ? ` (url contains "${query.urlContains}")` : ''}`))
        }, timeoutMs),
        ...(signal ? { signal } : {})
      }
      if (signal) {
        waiter.onAbort = () => {
          this.settleRequestWaiter(waiter)
          reject(new Error('network request wait cancelled'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.requestWaiters.add(waiter)
      if (signal?.aborted) waiter.onAbort?.()
    })
  }

  waitForStream(
    transport: NetworkStreamTransport,
    query: NetworkJournalQuery,
    maxMessages: number,
    idleMs: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<NetworkStreamCapture> {
    if (!this.active) return Promise.reject(new Error('network journal is not active'))

    return new Promise<NetworkStreamCapture>((resolve, reject) => {
      const waiter: NetworkStreamWaiter = {
        transport,
        query,
        maxMessages: clampInteger(maxMessages, 50, 1, 1_000),
        idleMs: clampInteger(idleMs, 500, 50, 10_000),
        requestId: null,
        url: null,
        status: null,
        startedAt: new Date().toISOString(),
        messages: [],
        bytes: 0,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.settleStreamWaiter(waiter)
          reject(new Error(`network ${transport} stream wait timed out after ${timeoutMs}ms${query.urlContains ? ` (url contains "${query.urlContains}")` : ''}`))
        }, timeoutMs),
        ...(signal ? { signal } : {})
      }
      if (signal) {
        waiter.onAbort = () => {
          this.settleStreamWaiter(waiter)
          reject(new Error(`network ${transport} stream wait cancelled`))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.streamWaiters.add(waiter)
      if (transport === 'websocket') {
        const socket = this.webSockets.find((candidate) => matchesWebSocket(candidate.url, candidate.status, query))
        if (socket) this.selectStreamWaiter(waiter, socket.requestId, socket.url, socket.status)
      } else {
        const request = this.requests.find((candidate) => matchesRequest(candidate, { ...query, completedOnly: false }))
        if (request) this.selectStreamWaiter(waiter, request.requestId, request.url, request.status)
      }
      if (signal?.aborted) waiter.onAbort?.()
    })
  }

  private recordRequest(requestId: string, params: Record<string, unknown>): void {
    const existing = this.requestsById.get(requestId)
    if (existing) {
      const redirect = asRecord(params.redirectResponse)
      if (Object.keys(redirect).length > 0) {
        existing.status = readNumber(redirect.status)
        existing.statusText = readString(redirect.statusText)
        existing.mimeType = readString(redirect.mimeType)
        existing.protocol = readString(redirect.protocol)
        existing.fromDiskCache = redirect.fromDiskCache === true
        existing.fromServiceWorker = redirect.fromServiceWorker === true
        this.completeRequest(existing, params)
      }
      this.requestsById.delete(requestId)
    }
    const request = asRecord(params.request)
    const wallTime = readNumber(params.wallTime)
    const startedTimestamp = readNumber(params.timestamp)
    const entry: MutableRequest = {
      sequence: ++this.sequence,
      requestId,
      url: readString(request.url) ?? '',
      method: readString(request.method) ?? 'GET',
      resourceType: readString(params.type),
      initiatorType: readString(asRecord(params.initiator).type),
      status: null,
      statusText: null,
      mimeType: null,
      protocol: null,
      fromDiskCache: false,
      fromServiceWorker: false,
      encodedDataLength: 0,
      failed: false,
      canceled: false,
      errorText: null,
      blockedReason: null,
      startedAt: wallTime === null ? new Date().toISOString() : new Date(wallTime * 1000).toISOString(),
      completedAt: null,
      durationMs: null,
      startedTimestamp
    }
    this.requests.push(entry)
    this.requestsById.set(requestId, entry)
    if (this.requests.length > maxRequests) {
      const removed = this.requests.shift()!
      if (this.requestsById.get(removed.requestId) === removed) this.requestsById.delete(removed.requestId)
      this.droppedRequests += 1
    }
  }

  private completeRequest(request: MutableRequest, params: Record<string, unknown>): void {
    request.completedAt = new Date().toISOString()
    const completedTimestamp = readNumber(params.timestamp)
    if (request.startedTimestamp !== null && completedTimestamp !== null) {
      request.durationMs = Math.max(0, Math.round((completedTimestamp - request.startedTimestamp) * 1000))
    }
  }

  private recordWebSocket(requestId: string, params: Record<string, unknown>): void {
    const socket: MutableWebSocket = {
      sequence: ++this.sequence,
      requestId,
      url: readString(params.url) ?? '',
      status: null,
      sentFrames: 0,
      receivedFrames: 0,
      sentBytes: 0,
      receivedBytes: 0,
      openedAt: new Date().toISOString(),
      closedAt: null
    }
    this.webSockets.push(socket)
    this.webSocketsById.set(requestId, socket)
    this.selectStreamWaiters('websocket', requestId, socket.url, socket.status)
    if (this.webSockets.length > maxWebSockets) {
      const removed = this.webSockets.shift()!
      if (this.webSocketsById.get(removed.requestId) === removed) this.webSocketsById.delete(removed.requestId)
      this.droppedWebSockets += 1
    }
  }

  private resolveRequestWaiters(request: MutableRequest): void {
    for (const waiter of [...this.requestWaiters]) {
      if (!matchesRequest(request, waiter.query)) continue
      this.settleRequestWaiter(waiter)
      waiter.resolve(publicRequest(request))
    }
  }

  private rejectRequestWaiters(error: Error): void {
    for (const waiter of [...this.requestWaiters]) {
      this.settleRequestWaiter(waiter)
      waiter.reject(error)
    }
  }

  private settleRequestWaiter(waiter: NetworkRequestWaiter): void {
    clearTimeout(waiter.timer)
    this.requestWaiters.delete(waiter)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
  }

  private recordWebSocketFrame(requestId: string, direction: 'received' | 'sent', frame: Record<string, unknown>): void {
    const opcode = readNumber(frame.opcode)
    this.recordStreamMessage({
      transport: 'websocket',
      requestId,
      direction,
      data: readString(frame.payloadData) ?? '',
      eventName: null,
      eventId: null,
      opcode,
      encoding: opcode === 2 ? 'base64' : 'utf8'
    })
  }

  private recordStreamMessage(message: Omit<NetworkStreamMessage, 'sequence' | 'recordedAt' | 'bytes'>): void {
    const entry: NetworkStreamMessage = {
      sequence: ++this.streamSequence,
      recordedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(message.data, message.encoding === 'base64' ? 'base64' : 'utf8'),
      ...message
    }
    for (const waiter of [...this.streamWaiters]) {
      if (waiter.transport !== entry.transport || waiter.requestId !== entry.requestId) continue
      if (waiter.bytes + entry.bytes > maxStreamCaptureBytes) {
        this.resolveStreamWaiter(waiter, 'bytes')
        continue
      }
      waiter.messages.push(entry)
      waiter.bytes += entry.bytes
      if (waiter.idleTimer) clearTimeout(waiter.idleTimer)
      if (waiter.messages.length >= waiter.maxMessages) {
        this.resolveStreamWaiter(waiter, 'limit')
        continue
      }
      waiter.idleTimer = setTimeout(() => this.resolveStreamWaiter(waiter, 'idle'), waiter.idleMs)
    }
  }

  private selectStreamWaiters(
    transport: NetworkStreamTransport,
    requestId: string,
    url: string,
    status: number | null,
    request?: MutableRequest
  ): void {
    for (const waiter of this.streamWaiters) {
      if (waiter.transport !== transport || waiter.requestId) continue
      const matches = request
        ? matchesRequest(request, { ...waiter.query, completedOnly: false })
        : matchesWebSocket(url, status, waiter.query)
      if (matches) this.selectStreamWaiter(waiter, requestId, url, status)
    }
  }

  private selectStreamWaiter(waiter: NetworkStreamWaiter, requestId: string, url: string, status: number | null): void {
    waiter.requestId = requestId
    waiter.url = url
    waiter.status = status
  }

  private updateStreamWaiterStatus(requestId: string, status: number | null): void {
    for (const waiter of this.streamWaiters) {
      if (waiter.requestId === requestId) waiter.status = status
    }
  }

  private closeStreamWaiters(requestId: string): void {
    for (const waiter of [...this.streamWaiters]) {
      if (waiter.requestId === requestId) this.resolveStreamWaiter(waiter, 'closed')
    }
  }

  private resolveStreamWaiter(waiter: NetworkStreamWaiter, completedReason: NetworkStreamCapture['completedReason']): void {
    if (!waiter.requestId || !waiter.url) return
    const capture: NetworkStreamCapture = {
      transport: waiter.transport,
      requestId: waiter.requestId,
      url: waiter.url,
      status: waiter.status,
      messages: waiter.messages.map((message) => ({ ...message })),
      messageCount: waiter.messages.length,
      bytes: waiter.bytes,
      completedReason,
      startedAt: waiter.startedAt,
      completedAt: new Date().toISOString()
    }
    this.settleStreamWaiter(waiter)
    waiter.resolve(capture)
  }

  private rejectStreamWaiters(error: Error): void {
    for (const waiter of [...this.streamWaiters]) {
      this.settleStreamWaiter(waiter)
      waiter.reject(error)
    }
  }

  private settleStreamWaiter(waiter: NetworkStreamWaiter): void {
    clearTimeout(waiter.timer)
    if (waiter.idleTimer) clearTimeout(waiter.idleTimer)
    this.streamWaiters.delete(waiter)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
  }
}

function publicRequest(request: MutableRequest): NetworkRequestSummary {
  const { startedTimestamp: _startedTimestamp, ...result } = request
  return { ...result }
}

function matchesRequest(request: MutableRequest, query: NetworkJournalQuery): boolean {
  if (query.urlContains && !request.url.toLowerCase().includes(query.urlContains.toLowerCase())) return false
  if (query.method && request.method.toLowerCase() !== query.method.toLowerCase()) return false
  if (query.resourceType && request.resourceType?.toLowerCase() !== query.resourceType.toLowerCase()) return false
  if (query.mimeType && !request.mimeType?.toLowerCase().includes(query.mimeType.toLowerCase())) return false
  if (query.statusMin !== null && query.statusMin !== undefined && (request.status ?? -1) < query.statusMin) return false
  if (query.statusMax !== null && query.statusMax !== undefined && (request.status ?? Number.MAX_SAFE_INTEGER) > query.statusMax) return false
  if (query.failedOnly && !request.failed && (request.status === null || request.status < 400)) return false
  if (query.completedOnly && request.completedAt === null) return false
  return true
}

function matchesWebSocket(url: string, status: number | null, query: NetworkJournalQuery): boolean {
  if (query.urlContains && !url.toLowerCase().includes(query.urlContains.toLowerCase())) return false
  if (query.statusMin !== null && query.statusMin !== undefined && (status ?? -1) < query.statusMin) return false
  if (query.statusMax !== null && query.statusMax !== undefined && (status ?? Number.MAX_SAFE_INTEGER) > query.statusMax) return false
  return true
}

function frameBytes(frame: Record<string, unknown>): number {
  const payload = readString(frame.payloadData) ?? ''
  return Buffer.byteLength(payload, 'utf8')
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampInteger(value: number | null | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value!)))
}
