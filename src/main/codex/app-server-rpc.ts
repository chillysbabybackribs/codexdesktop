export type JsonRpcId = string | number

export type JsonRpcMessage = {
  jsonrpc?: '2.0'
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type JsonRpcRequestMessage = JsonRpcMessage & {
  id: JsonRpcId
  method: string
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type AppServerRpcOptions = {
  write: (message: JsonRpcMessage) => void
  onNotification: (message: JsonRpcMessage & { method: string }) => void
  onRequest: (message: JsonRpcRequestMessage) => void
  onInvalidLine?: (line: string, error: unknown) => void
  requestTimeoutMs?: number
  requestIdPrefix?: string
}

const defaultRequestTimeoutMs = 30_000
const maxBufferedMessageChars = 16_000_000

export class AppServerRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(
    message: string,
    code: number,
    data?: unknown
  ) {
    super(message)
    this.name = 'AppServerRpcError'
    this.code = code
    this.data = data
  }
}

export class AppServerRpc {
  private readonly writeMessage: AppServerRpcOptions['write']
  private readonly onNotification: AppServerRpcOptions['onNotification']
  private readonly onRequest: AppServerRpcOptions['onRequest']
  private readonly onInvalidLine: NonNullable<AppServerRpcOptions['onInvalidLine']>
  private readonly requestTimeoutMs: number
  private readonly requestIdPrefix: string
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private requestCounter = 0
  private partialMessage = ''

  constructor(options: AppServerRpcOptions) {
    this.writeMessage = options.write
    this.onNotification = options.onNotification
    this.onRequest = options.onRequest
    this.onInvalidLine = options.onInvalidLine ?? ((line, error) => {
      console.warn('Ignoring non-JSON app-server line', { line, error })
    })
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs
    this.requestIdPrefix = options.requestIdPrefix ?? 'codexdesktop'
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = `${this.requestIdPrefix}-${++this.requestCounter}`

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return

        this.pending.delete(id)
        pending.reject(new Error(`Codex request timed out: ${method}`))
      }, this.requestTimeoutMs)

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })

      try {
        this.writeMessage({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.writeMessage({ jsonrpc: '2.0', method, params })
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.writeMessage({ jsonrpc: '2.0', id, result })
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.writeMessage({ jsonrpc: '2.0', id, error: { code, message } })
  }

  handleLine(line: string): void {
    if (!line.trim()) return

    let message: JsonRpcMessage
    const candidate = this.partialMessage ? `${this.partialMessage}${line}` : line

    try {
      const parsed = JSON.parse(candidate) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Expected a JSON-RPC object')
      }
      message = parsed as JsonRpcMessage
    } catch (error) {
      // Remote plugin catalogs can contain multi-line descriptions. Some
      // app-server versions stream those very large JSON responses across
      // physical stdout lines, so retain an object-shaped prefix until the
      // complete response arrives. Concatenate without a newline: the next
      // fragment begins with the JSON string's escaped newline sequence.
      if ((this.partialMessage || line.trimStart().startsWith('{')) && candidate.length < maxBufferedMessageChars) {
        this.partialMessage = candidate
        return
      }
      this.partialMessage = ''
      this.onInvalidLine(line, error)
      return
    }

    this.partialMessage = ''

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      this.handleResponse(message)
      return
    }

    if (message.id !== undefined && message.method) {
      this.onRequest(message as JsonRpcRequestMessage)
      return
    }

    if (message.method) {
      this.onNotification(message as JsonRpcMessage & { method: string })
    }
  }

  rejectPending(error: Error): void {
    // A partial stdout fragment is meaningful only for the current child
    // process. Retaining it across a crash/restart makes the first valid line
    // from the replacement process look like a continuation and can silently
    // swallow all following RPC traffic.
    this.partialMessage = ''

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }

    this.pending.clear()
  }

  private handleResponse(message: JsonRpcMessage): void {
    const pending = this.pending.get(message.id!)
    if (!pending) return

    this.pending.delete(message.id!)
    clearTimeout(pending.timer)

    if (message.error) {
      pending.reject(new AppServerRpcError(message.error.message, message.error.code, message.error.data))
    } else {
      pending.resolve(message.result)
    }
  }
}
