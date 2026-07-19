import type { WebContents } from 'electron';
import {
  NetworkJournal,
  type NetworkJournalPage,
  type NetworkJournalQuery,
  type NetworkRequestSummary,
} from './network-journal.js';
import {
  PERFORMANCE_TIMELINE_EVENT_TYPES,
  PerformanceDiagnostics,
  type PerformanceDiagnosticsPage,
} from './performance-diagnostics.js';

const maxBufferedEvents = 256;
const maxEventParamsChars = 8_000;
const maxEventPageChars = 16_000;
const performanceNavigationExpression = `(() => {
  const entries = performance.getEntriesByType('navigation');
  const entry = entries.length > 0 ? entries[entries.length - 1] : null;
  if (!entry) return null;
  const number = (key) => typeof entry[key] === 'number' && Number.isFinite(entry[key]) ? Math.round(entry[key] * 1000) / 1000 : null;
  return {
    timeOriginMs: Math.round(performance.timeOrigin * 1000) / 1000,
    pageAgeMs: Math.round(performance.now() * 1000) / 1000,
    type: typeof entry.type === 'string' ? entry.type : null,
    durationMs: number('duration'),
    redirectCount: number('redirectCount'),
    fetchStartMs: number('fetchStart'),
    requestStartMs: number('requestStart'),
    responseStartMs: number('responseStart'),
    responseEndMs: number('responseEnd'),
    domInteractiveMs: number('domInteractive'),
    domContentLoadedMs: number('domContentLoadedEventEnd'),
    loadEventMs: number('loadEventEnd'),
    transferSize: number('transferSize'),
    encodedBodySize: number('encodedBodySize'),
    decodedBodySize: number('decodedBodySize')
  };
})()`;
const installPerformanceObserverExpression = (includeLongTasks: boolean): string => `(() => {
  if (typeof PerformanceObserver !== 'function') return { collectionStartedAtPageMs: performance.now(), longTasks: false, interactions: false };
  const key = '__codexPerformanceDiagnosticsV1';
  const existing = globalThis[key];
  if (existing && Array.isArray(existing.observers)) {
    for (const observer of existing.observers) observer.disconnect();
  }
  try { delete globalThis[key]; } catch {}
  const supported = PerformanceObserver.supportedEntryTypes || [];
  const state = {
    collectionStartedAtPageMs: performance.now(),
    longTasks: [],
    interactions: [],
    observers: [],
    support: null
  };
  const support = {
    collectionStartedAtPageMs: state.collectionStartedAtPageMs,
    longTasks: ${includeLongTasks ? 'true' : 'false'} && supported.includes('longtask'),
    interactions: supported.includes('event')
  };
  state.support = support;
  if (support.longTasks) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration });
      }
      if (state.longTasks.length > 96) state.longTasks.splice(0, state.longTasks.length - 96);
    });
    observer.observe({ type: 'longtask', buffered: true });
    state.observers.push(observer);
  }
  if (support.interactions) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.interactionId) continue;
        state.interactions.push({
          interactionId: entry.interactionId,
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          processingStart: entry.processingStart,
          processingEnd: entry.processingEnd
        });
      }
      if (state.interactions.length > 96) state.interactions.splice(0, state.interactions.length - 96);
    });
    observer.observe({ type: 'event', buffered: true, durationThreshold: 16 });
    state.observers.push(observer);
  }
  Object.defineProperty(globalThis, key, { value: state, configurable: true });
  return support;
})()`;
const drainPerformanceObserverExpression = `(() => {
  const state = globalThis.__codexPerformanceDiagnosticsV1;
  if (!state) return { longTasks: [], interactions: [] };
  return {
    longTasks: Array.isArray(state.longTasks) ? state.longTasks.splice(0, state.longTasks.length) : [],
    interactions: Array.isArray(state.interactions) ? state.interactions.splice(0, state.interactions.length) : []
  };
})()`;
const stopPerformanceObserverExpression = `(() => {
  const key = '__codexPerformanceDiagnosticsV1';
  const state = globalThis[key];
  if (state && Array.isArray(state.observers)) {
    for (const observer of state.observers) observer.disconnect();
  }
  try { delete globalThis[key]; } catch {}
  return true;
})()`;

export type CdpDomainCapability = {
  name: string;
  version: string | null;
};

export type CdpCapabilities = {
  observedAt: string;
  product: string | null;
  protocolVersion: string | null;
  revision: string | null;
  userAgent: string | null;
  jsVersion: string | null;
  domains: CdpDomainCapability[];
  errors: string[];
};

export type CdpEventRecord = {
  sequence: number;
  timestamp: string;
  method: string;
  params: unknown;
  sessionId: string | null;
};

export type CdpEventQuery = {
  method?: string | null;
  afterSequence?: number | null;
  filter?: Record<string, unknown> | null;
  contains?: Record<string, string> | null;
  limit?: number | null;
};

export type CdpEventPage = {
  events: CdpEventRecord[];
  latestSequence: number;
  oldestSequence: number | null;
  droppedEvents: number;
  hasMoreMatching: boolean;
};

type EventWaiter = {
  query: CdpEventQuery;
  resolve: (event: CdpEventRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const sessions = new WeakMap<WebContents, CdpSession>();

export class CdpSession {
  private disposed = false;
  private readonly webContents: WebContents;
  private capabilitiesPromise: Promise<CdpCapabilities> | null = null;
  private readonly events: CdpEventRecord[] = [];
  private readonly waiters = new Set<EventWaiter>();
  private eventSequence = 0;
  private droppedEvents = 0;
  private readonly networkJournal = new NetworkJournal();
  private readonly performanceDiagnostics = new PerformanceDiagnostics();
  private readonly onMessage = (
    _event: Electron.Event,
    method: string,
    params: unknown,
    sessionId?: string,
  ): void => {
    this.recordEvent(method, params, sessionId);
  };
  private readonly onDetach = (): void => {
    this.capabilitiesPromise = null;
    this.rejectWaiters(new Error('CDP debugger detached while waiting for an event'));
  };
  private readonly onDestroyed = (): void => {
    this.capabilitiesPromise = null;
    this.rejectWaiters(new Error('CDP target was destroyed while waiting for an event'));
    this.releaseListeners();
    sessions.delete(this.webContents);
  };

  constructor(webContents: WebContents) {
    this.webContents = webContents;
    webContents.debugger.on('message', this.onMessage);
    webContents.debugger.on('detach', this.onDetach);
    webContents.once('destroyed', this.onDestroyed);
  }

  async send(method: string, params: object = {}): Promise<unknown> {
    this.ensureAttached();
    return this.webContents.debugger.sendCommand(method, params);
  }

  async capabilities(): Promise<CdpCapabilities> {
    this.ensureAttached();
    return this.ensureCapabilities();
  }

  eventPage(query: CdpEventQuery = {}): CdpEventPage {
    const limit = clampInteger(query.limit, 30, 1, 100);
    const matching = this.events.filter((event) => matchesEvent(event, query));
    const candidates = matching.slice(-limit);
    const events = boundedEventPage(candidates);

    return {
      events,
      latestSequence: this.eventSequence,
      oldestSequence: this.events[0]?.sequence ?? null,
      droppedEvents: this.droppedEvents,
      hasMoreMatching: events.length < candidates.length || matching.length > candidates.length,
    };
  }

  async waitForEvent(query: CdpEventQuery, timeoutMs: number): Promise<CdpEventRecord> {
    this.ensureAttached();
    const existing = this.events.find((event) => matchesEvent(event, query));
    if (existing) return existing;

    return new Promise<CdpEventRecord>((resolve, reject) => {
      const waiter: EventWaiter = {
        query,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            new Error(
              `CDP event wait timed out after ${timeoutMs}ms${query.method ? ` (${query.method})` : ''}`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  async prepareForEvent(method: string): Promise<void> {
    const domain = method.split('.', 1)[0];
    if (domain === 'Page') {
      await this.send('Page.enable');
      if (method === 'Page.lifecycleEvent') {
        await this.send('Page.setLifecycleEventsEnabled', { enabled: true });
      }
      return;
    }
    if (domain === 'Network') {
      await this.send('Network.enable');
      return;
    }
    if (domain === 'Runtime') {
      await this.send('Runtime.enable');
      return;
    }
    if (domain === 'Log') {
      await this.send('Log.enable');
    }
  }

  async startNetworkJournal(): Promise<void> {
    this.networkJournal.start();
    try {
      await this.send('Network.enable');
    } catch (error) {
      this.networkJournal.stop();
      throw error;
    }
  }

  stopNetworkJournal(): NetworkJournalPage {
    this.networkJournal.stop();
    return this.networkJournal.page();
  }

  networkJournalPage(query: NetworkJournalQuery = {}): NetworkJournalPage {
    return this.networkJournal.page(query);
  }

  networkRequest(requestId: string): NetworkRequestSummary | null {
    return this.networkJournal.request(requestId);
  }

  async startPerformanceDiagnostics(): Promise<PerformanceDiagnosticsPage> {
    this.performanceDiagnostics.start();
    try {
      await this.send('Performance.enable', { timeDomain: 'timeTicks' });
      await this.send('Page.enable');
      await this.send('Page.setLifecycleEventsEnabled', { enabled: true });
    } catch (error) {
      this.performanceDiagnostics.stop();
      throw error;
    }

    const preferredTypes = [...PERFORMANCE_TIMELINE_EVENT_TYPES];
    let longTaskTimelineError: string | null = null;
    try {
      await this.send('PerformanceTimeline.enable', { eventTypes: preferredTypes });
      this.performanceDiagnostics.setTimelineSupport(preferredTypes);
    } catch (error) {
      longTaskTimelineError = errorMessage(error);
      const fallbackTypes = preferredTypes.filter((type) => type !== 'longtask');
      try {
        await this.send('PerformanceTimeline.enable', { eventTypes: fallbackTypes });
        this.performanceDiagnostics.setTimelineSupport(fallbackTypes);
      } catch (fallbackError) {
        this.performanceDiagnostics.addWarning(
          `performance timeline unavailable: ${errorMessage(fallbackError)}`,
        );
      }
    }

    try {
      const evaluated = asRecord(
        await this.send('Runtime.evaluate', {
          expression: installPerformanceObserverExpression(longTaskTimelineError !== null),
          returnByValue: true,
        }),
      );
      const support = asRecord(evaluated.result).value;
      this.performanceDiagnostics.setObserverSupport(support);
      const supportRecord = asRecord(support);
      if (longTaskTimelineError && supportRecord.longTasks === true) {
        this.performanceDiagnostics.addWarning(
          'CDP long-task timeline unavailable; using page PerformanceObserver',
        );
      } else if (longTaskTimelineError) {
        this.performanceDiagnostics.addWarning(
          `long-task diagnostics unavailable: ${longTaskTimelineError}`,
        );
      }
      if (supportRecord.interactions !== true) {
        this.performanceDiagnostics.addWarning(
          'Event Timing observer unavailable; local INP cannot be measured',
        );
      }
    } catch (error) {
      this.performanceDiagnostics.addWarning(
        `page performance observers unavailable: ${errorMessage(error)}`,
      );
    }

    return this.readPerformanceDiagnostics();
  }

  async readPerformanceDiagnostics(): Promise<PerformanceDiagnosticsPage> {
    const metrics = await this.send('Performance.getMetrics');
    try {
      const evaluated = asRecord(
        await this.send('Runtime.evaluate', {
          expression: drainPerformanceObserverExpression,
          returnByValue: true,
        }),
      );
      this.performanceDiagnostics.recordObservedData(asRecord(evaluated.result).value);
    } catch {
      // The observer is an optional fallback and can disappear after navigation.
    }
    let navigation: Record<string, unknown> | null = null;
    try {
      const evaluated = asRecord(
        await this.send('Runtime.evaluate', {
          expression: performanceNavigationExpression,
          returnByValue: true,
          awaitPromise: false,
        }),
      );
      const result = asRecord(evaluated.result);
      navigation = asNullableRecord(result.value);
      if (evaluated.exceptionDetails) {
        this.performanceDiagnostics.addWarning('navigation timing evaluation failed');
      }
    } catch (error) {
      this.performanceDiagnostics.addWarning(
        `navigation timing unavailable: ${errorMessage(error)}`,
      );
    }
    return this.performanceDiagnostics.page(metrics, navigation);
  }

  async stopPerformanceDiagnostics(): Promise<PerformanceDiagnosticsPage> {
    const page = await this.readPerformanceDiagnostics();
    this.performanceDiagnostics.stop();
    try {
      await this.send('Performance.disable');
    } catch {
      // Best-effort cleanup; the target may already be navigating or closing.
    }
    try {
      await this.send('PerformanceTimeline.enable', { eventTypes: [] });
    } catch {
      // PerformanceTimeline is experimental and may not exist on this Chromium build.
    }
    try {
      await this.send('Runtime.evaluate', {
        expression: stopPerformanceObserverExpression,
        returnByValue: true,
      });
    } catch {
      // The page may have navigated since the observer was installed.
    }
    return { ...page, active: false };
  }

  async terminateExecution(): Promise<void> {
    if (this.webContents.isDestroyed()) return;

    try {
      this.ensureAttached();
      await this.webContents.debugger.sendCommand('Runtime.terminateExecution');
    } catch {
      // The target may already have navigated, detached, or completed.
    }
  }

  detach(): void {
    if (!this.webContents.isDestroyed() && this.webContents.debugger.isAttached()) {
      try {
        this.webContents.debugger.detach();
      } catch {
        // Best-effort cleanup while a tab is closing.
      }
    }
    this.capabilitiesPromise = null;
    this.rejectWaiters(new Error('CDP debugger detached'));
  }

  /**
   * Terminal cleanup for a tab closing or a window shutting down. Unlike
   * detach(), this also releases listeners and transient diagnostics so the
   * session cannot retain a closing native surface.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.networkJournal.stop();
    this.performanceDiagnostics.stop();
    this.detach();
    this.releaseListeners();
  }

  private ensureAttached(): void {
    if (this.disposed) {
      throw new Error('CDP session has been disposed');
    }
    if (this.webContents.isDestroyed()) {
      throw new Error('CDP target is no longer available');
    }

    if (!this.webContents.debugger.isAttached()) {
      this.webContents.debugger.attach();
      this.capabilitiesPromise = null;
    }
  }

  private ensureCapabilities(): Promise<CdpCapabilities> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.readCapabilities();
    }
    return this.capabilitiesPromise;
  }

  private async readCapabilities(): Promise<CdpCapabilities> {
    const errors: string[] = [];
    let version: Record<string, unknown> = {};
    let domains: CdpDomainCapability[] = [];

    try {
      version = asRecord(await this.webContents.debugger.sendCommand('Browser.getVersion'));
    } catch (error) {
      errors.push(`Browser.getVersion: ${errorMessage(error)}`);
    }

    try {
      const result = asRecord(await this.webContents.debugger.sendCommand('Schema.getDomains'));
      domains = Array.isArray(result.domains)
        ? result.domains.flatMap((domain) => {
            const record = asRecord(domain);
            return typeof record.name === 'string'
              ? [
                  {
                    name: record.name,
                    version: typeof record.version === 'string' ? record.version : null,
                  },
                ]
              : [];
          })
        : [];
    } catch (error) {
      errors.push(`Schema.getDomains: ${errorMessage(error)}`);
    }

    return {
      observedAt: new Date().toISOString(),
      product: readString(version.product),
      protocolVersion: readString(version.protocolVersion),
      revision: readString(version.revision),
      userAgent: readString(version.userAgent),
      jsVersion: readString(version.jsVersion),
      domains,
      errors,
    };
  }

  private recordEvent(method: string, params: unknown, sessionId?: string): void {
    this.networkJournal.record(method, params);
    this.performanceDiagnostics.record(method, params);
    const event: CdpEventRecord = {
      sequence: ++this.eventSequence,
      timestamp: new Date().toISOString(),
      method,
      params: boundEventParams(params),
      sessionId: sessionId ?? null,
    };
    this.events.push(event);
    if (this.events.length > maxBufferedEvents) {
      this.events.shift();
      this.droppedEvents += 1;
    }

    for (const waiter of [...this.waiters]) {
      if (!matchesEvent(event, waiter.query)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(event);
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private releaseListeners(): void {
    this.webContents.debugger.off('message', this.onMessage);
    this.webContents.debugger.off('detach', this.onDetach);
    this.webContents.off('destroyed', this.onDestroyed);
  }
}

export function cdpSessionFor(webContents: WebContents): CdpSession {
  let session = sessions.get(webContents);
  if (!session) {
    session = new CdpSession(webContents);
    sessions.set(webContents, session);
  }
  return session;
}

/** Explicit terminal cleanup for a closed WebContentsView. */
export function disposeCdpSession(webContents: WebContents): void {
  const session = sessions.get(webContents);
  if (!session) return;
  sessions.delete(webContents);
  session.dispose();
}

function matchesEvent(event: CdpEventRecord, query: CdpEventQuery): boolean {
  if (query.method && event.method !== query.method) return false;
  if (
    query.afterSequence !== null &&
    query.afterSequence !== undefined &&
    event.sequence <= query.afterSequence
  )
    return false;
  if (query.filter && !matchesPartial(event.params, query.filter)) return false;

  for (const [path, expected] of Object.entries(query.contains ?? {})) {
    const actual = valueAtPath(event.params, path);
    if (typeof actual !== 'string' || !actual.includes(expected)) return false;
  }
  return true;
}

function matchesPartial(value: unknown, expected: Record<string, unknown>): boolean {
  const actual = asRecord(value);
  return Object.entries(expected).every(([key, expectedValue]) => {
    const actualValue = actual[key];
    if (isRecord(expectedValue)) return matchesPartial(actualValue, expectedValue);
    return Object.is(actualValue, expectedValue);
  });
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => asRecord(current)[key], value);
}

function boundEventParams(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value) ?? 'null';
    if (serialized.length <= maxEventParamsChars) return value;
    return {
      truncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, maxEventParamsChars),
    };
  } catch (error) {
    return { serializationError: errorMessage(error) };
  }
}

function boundedEventPage(events: CdpEventRecord[]): CdpEventRecord[] {
  const result: CdpEventRecord[] = [];
  let chars = 0;

  for (const event of [...events].reverse()) {
    const eventChars = JSON.stringify(event).length;
    if (result.length > 0 && chars + eventChars > maxEventPageChars) break;
    result.push(event);
    chars += eventChars;
  }

  return result.reverse();
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asNullableRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampInteger(
  value: number | null | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value!)));
}
