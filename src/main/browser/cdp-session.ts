import type { WebContents } from 'electron'

const maxBufferedEvents = 256
const maxEventParamsChars = 8_000
const maxEventPageChars = 16_000

export type CdpDomainCapability = {
  name: string
  version: string | null
}

export type CdpCapabilities = {
  observedAt: string
  product: string | null
  protocolVersion: string | null
  revision: string | null
  userAgent: string | null
  jsVersion: string | null
  domains: CdpDomainCapability[]
  errors: string[]
}

export type CdpEventRecord = {
  sequence: number
  timestamp: string
  method: string
  params: unknown
  sessionId: string | null
}

export type CdpEventQuery = {
  method?: string | null
  afterSequence?: number | null
  filter?: Record<string, unknown> | null
  contains?: Record<string, string> | null
  limit?: number | null
}

export type CdpEventPage = {
  events: CdpEventRecord[]
  latestSequence: number
  oldestSequence: number | null
  droppedEvents: number
  hasMoreMatching: boolean
}

type EventWaiter = {
  query: CdpEventQuery
  resolve: (event: CdpEventRecord) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const sessions = new WeakMap<WebContents, CdpSession>()

export class CdpSession {
  private attached = false
  private readonly webContents: WebContents
  private capabilitiesPromise: Promise<CdpCapabilities> | null = null
  private readonly events: CdpEventRecord[] = []
  private readonly waiters = new Set<EventWaiter>()
  private eventSequence = 0
  private droppedEvents = 0

  constructor(webContents: WebContents) {
    this.webContents = webContents
    webContents.debugger.on('message', (_event, method, params, sessionId) => {
      this.recordEvent(method, params, sessionId)
    })
    webContents.debugger.on('detach', () => {
      this.attached = false
      this.capabilitiesPromise = null
      this.rejectWaiters(new Error('CDP debugger detached while waiting for an event'))
    })
    webContents.once('destroyed', () => {
      this.attached = false
      this.capabilitiesPromise = null
      this.rejectWaiters(new Error('CDP target was destroyed while waiting for an event'))
    })
  }

  async send(method: string, params: object = {}): Promise<unknown> {
    this.ensureAttached()
    await this.ensureCapabilities()
    return this.webContents.debugger.sendCommand(method, params)
  }

  async capabilities(): Promise<CdpCapabilities> {
    this.ensureAttached()
    return this.ensureCapabilities()
  }

  eventPage(query: CdpEventQuery = {}): CdpEventPage {
    const limit = clampInteger(query.limit, 30, 1, 100)
    const matching = this.events.filter((event) => matchesEvent(event, query))
    const candidates = matching.slice(-limit)
    const events = boundedEventPage(candidates)

    return {
      events,
      latestSequence: this.eventSequence,
      oldestSequence: this.events[0]?.sequence ?? null,
      droppedEvents: this.droppedEvents,
      hasMoreMatching: events.length < candidates.length || matching.length > candidates.length
    }
  }

  async waitForEvent(query: CdpEventQuery, timeoutMs: number): Promise<CdpEventRecord> {
    this.ensureAttached()
    await this.ensureCapabilities()
    const existing = this.events.find((event) => matchesEvent(event, query))
    if (existing) return existing

    return new Promise<CdpEventRecord>((resolve, reject) => {
      const waiter: EventWaiter = {
        query,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          reject(new Error(`CDP event wait timed out after ${timeoutMs}ms${query.method ? ` (${query.method})` : ''}`))
        }, timeoutMs)
      }
      this.waiters.add(waiter)
    })
  }

  async prepareForEvent(method: string): Promise<void> {
    const domain = method.split('.', 1)[0]
    if (domain === 'Page') {
      await this.send('Page.enable')
      if (method === 'Page.lifecycleEvent') {
        await this.send('Page.setLifecycleEventsEnabled', { enabled: true })
      }
      return
    }
    if (domain === 'Network') {
      await this.send('Network.enable')
      return
    }
    if (domain === 'Runtime') {
      await this.send('Runtime.enable')
      return
    }
    if (domain === 'Log') {
      await this.send('Log.enable')
    }
  }

  async terminateExecution(): Promise<void> {
    if (this.webContents.isDestroyed()) return

    try {
      this.ensureAttached()
      await this.webContents.debugger.sendCommand('Runtime.terminateExecution')
    } catch {
      // The target may already have navigated, detached, or completed.
    }
  }

  detach(): void {
    if (!this.webContents.isDestroyed() && this.webContents.debugger.isAttached()) {
      try {
        this.webContents.debugger.detach()
      } catch {
        // Best-effort cleanup while a tab is closing.
      }
    }
    this.attached = false
    this.capabilitiesPromise = null
    this.rejectWaiters(new Error('CDP debugger detached'))
  }

  private ensureAttached(): void {
    if (this.webContents.isDestroyed()) {
      throw new Error('CDP target is no longer available')
    }

    if (!this.webContents.debugger.isAttached()) {
      this.webContents.debugger.attach()
      this.capabilitiesPromise = null
    }
    this.attached = true
  }

  private ensureCapabilities(): Promise<CdpCapabilities> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.readCapabilities()
    }
    return this.capabilitiesPromise
  }

  private async readCapabilities(): Promise<CdpCapabilities> {
    const errors: string[] = []
    let version: Record<string, unknown> = {}
    let domains: CdpDomainCapability[] = []

    try {
      version = asRecord(await this.webContents.debugger.sendCommand('Browser.getVersion'))
    } catch (error) {
      errors.push(`Browser.getVersion: ${errorMessage(error)}`)
    }

    try {
      const result = asRecord(await this.webContents.debugger.sendCommand('Schema.getDomains'))
      domains = Array.isArray(result.domains)
        ? result.domains.flatMap((domain) => {
            const record = asRecord(domain)
            return typeof record.name === 'string'
              ? [{ name: record.name, version: typeof record.version === 'string' ? record.version : null }]
              : []
          })
        : []
    } catch (error) {
      errors.push(`Schema.getDomains: ${errorMessage(error)}`)
    }

    return {
      observedAt: new Date().toISOString(),
      product: readString(version.product),
      protocolVersion: readString(version.protocolVersion),
      revision: readString(version.revision),
      userAgent: readString(version.userAgent),
      jsVersion: readString(version.jsVersion),
      domains,
      errors
    }
  }

  private recordEvent(method: string, params: unknown, sessionId?: string): void {
    const event: CdpEventRecord = {
      sequence: ++this.eventSequence,
      timestamp: new Date().toISOString(),
      method,
      params: boundEventParams(params),
      sessionId: sessionId ?? null
    }
    this.events.push(event)
    if (this.events.length > maxBufferedEvents) {
      this.events.shift()
      this.droppedEvents += 1
    }

    for (const waiter of [...this.waiters]) {
      if (!matchesEvent(event, waiter.query)) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.resolve(event)
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.waiters.clear()
  }
}

export function cdpSessionFor(webContents: WebContents): CdpSession {
  let session = sessions.get(webContents)
  if (!session) {
    session = new CdpSession(webContents)
    sessions.set(webContents, session)
  }
  return session
}

function matchesEvent(event: CdpEventRecord, query: CdpEventQuery): boolean {
  if (query.method && event.method !== query.method) return false
  if (query.afterSequence !== null && query.afterSequence !== undefined && event.sequence <= query.afterSequence) return false
  if (query.filter && !matchesPartial(event.params, query.filter)) return false

  for (const [path, expected] of Object.entries(query.contains ?? {})) {
    const actual = valueAtPath(event.params, path)
    if (typeof actual !== 'string' || !actual.includes(expected)) return false
  }
  return true
}

function matchesPartial(value: unknown, expected: Record<string, unknown>): boolean {
  const actual = asRecord(value)
  return Object.entries(expected).every(([key, expectedValue]) => {
    const actualValue = actual[key]
    if (isRecord(expectedValue)) return matchesPartial(actualValue, expectedValue)
    return Object.is(actualValue, expectedValue)
  })
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => asRecord(current)[key], value)
}

function boundEventParams(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value) ?? 'null'
    if (serialized.length <= maxEventParamsChars) return value
    return {
      truncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, maxEventParamsChars)
    }
  } catch (error) {
    return { serializationError: errorMessage(error) }
  }
}

function boundedEventPage(events: CdpEventRecord[]): CdpEventRecord[] {
  const result: CdpEventRecord[] = []
  let chars = 0

  for (const event of [...events].reverse()) {
    const eventChars = JSON.stringify(event).length
    if (result.length > 0 && chars + eventChars > maxEventPageChars) break
    result.push(event)
    chars += eventChars
  }

  return result.reverse()
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clampInteger(value: number | null | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value!)))
}
