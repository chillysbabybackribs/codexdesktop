import type { WebContents } from 'electron'

export type BrowserFlowNavigation = 'auto' | 'required' | 'none'

export type BrowserFlowStep =
  | { id?: string; type: 'fill'; selector: string; value: string }
  | { id?: string; type: 'click' | 'submit'; selector: string; navigation?: BrowserFlowNavigation }
  | { id?: string; type: 'wait'; selector?: string; urlContains?: string; stableMs?: number }
  | { id?: string; type: 'find'; selector: string; limit?: number; onMissing?: 'stop' | 'error' }

export type BrowserFlowFailureCode =
  | 'conditionNotMet'
  | 'conditionTimeout'
  | 'selectorNotFound'
  | 'invalidSelector'
  | 'pageScriptError'
  | 'targetChanged'
  | 'targetClosed'

export class BrowserFlowError extends Error {
  readonly code: BrowserFlowFailureCode
  readonly phase = 'browserFlow' as const

  constructor(code: BrowserFlowFailureCode, message: string) {
    super(message)
    this.name = 'BrowserFlowError'
    this.code = code
  }
}

export type BrowserFlowMatch = {
  tag: string
  text: string | null
  name: string | null
  href: string | null
  value: string | null
  checked: boolean | null
  disabled: boolean | null
}

export type BrowserFlowStepResult = {
  index: number
  id: string
  type: BrowserFlowStep['type']
  status: 'completed' | 'not_found'
  durationMs: number
  result?: unknown
}

export type BrowserFlowResult = {
  outcome: 'completed' | 'not_found'
  completedSteps: number
  stoppedAt?: { index: number; id: string }
  steps: BrowserFlowStepResult[]
  findings: Record<string, { count: number; matches: BrowserFlowMatch[] }>
  navigation: {
    started: number
    committed: number
    inPage: number
    lastUrl: string
  }
}

type NavigationState = BrowserFlowResult['navigation'] & {
  revision: number
  destroyed: boolean
}

type FlowOptions = {
  timeoutMs: number
}

const MAX_FLOW_STEPS = 24
const MAX_SELECTOR_CHARS = 2_000
const MAX_FILL_CHARS = 100_000
const DEFAULT_STABLE_MS = 90
const MAX_STABLE_MS = 2_000
const DEFAULT_FIND_LIMIT = 20
const MAX_FIND_LIMIT = 100

export async function runBrowserFlow(
  webContents: WebContents,
  rawSteps: unknown,
  options: FlowOptions
): Promise<BrowserFlowResult> {
  const steps = validateSteps(rawSteps)
  const deadline = Date.now() + Math.max(250, options.timeoutMs)
  const observer = observeNavigation(webContents)
  const results: BrowserFlowStepResult[] = []
  const findings: BrowserFlowResult['findings'] = {}

  try {
    for (let index = 0; index < steps.length; index += 1) {
      assertTargetOpen(webContents)
      const step = steps[index]
      const id = step.id ?? `step-${index + 1}`
      const startedAt = Date.now()

      if (step.type === 'wait') {
        const result = await waitForCondition(webContents, observer, step, deadline, id)
        results.push({ index, id, type: step.type, status: 'completed', durationMs: Date.now() - startedAt, result })
        continue
      }

      if (step.type === 'find') {
        const finding = await inspectOnce(webContents, step.selector, step.limit ?? DEFAULT_FIND_LIMIT)
        findings[id] = finding
        if (finding.count === 0) {
          if ((step.onMissing ?? 'stop') === 'error') {
            throw new BrowserFlowError('selectorNotFound', `browser_flow step "${id}" found no matches for ${step.selector}`)
          }
          results.push({
            index,
            id,
            type: step.type,
            status: 'not_found',
            durationMs: Date.now() - startedAt,
            result: finding
          })
          return {
            outcome: 'not_found',
            completedSteps: results.length,
            stoppedAt: { index, id },
            steps: results,
            findings,
            navigation: observer.snapshot()
          }
        }
        results.push({ index, id, type: step.type, status: 'completed', durationMs: Date.now() - startedAt, result: finding })
        continue
      }

      const beforeNavigation = observer.state()
      const navigation = step.type === 'fill' ? 'none' : (step.navigation ?? 'auto')
      let actionResult: unknown
      try {
        actionResult = await executeAction(webContents, step)
      } catch (error) {
        const contextChanged = isContextChangedError(error)
        const observed = observer.hasNavigationAfter(beforeNavigation)
          || (contextChanged && navigation !== 'none'
            ? await observer.waitForNavigationAfter(beforeNavigation, Math.min(500, remainingMs(deadline)))
            : false)
        if (!(contextChanged && navigation !== 'none' && observed)) throw normalizeActionError(error, id)
        actionResult = { contextReplaced: true }
      }

      if (navigation === 'required' && !observer.hasNavigationAfter(beforeNavigation)) {
        const observed = await observer.waitForNavigationAfter(beforeNavigation, remainingMs(deadline))
        if (!observed) {
          throw new BrowserFlowError('conditionTimeout', `browser_flow step "${id}" required navigation, but none was observed`)
        }
      }
      results.push({ index, id, type: step.type, status: 'completed', durationMs: Date.now() - startedAt, result: actionResult })
    }

    return {
      outcome: 'completed',
      completedSteps: results.length,
      steps: results,
      findings,
      navigation: observer.snapshot()
    }
  } finally {
    observer.dispose()
  }
}

function validateSteps(value: unknown): BrowserFlowStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BrowserFlowError('conditionNotMet', 'browser_flow requires a non-empty steps array')
  }
  if (value.length > MAX_FLOW_STEPS) {
    throw new BrowserFlowError('conditionNotMet', `browser_flow supports at most ${MAX_FLOW_STEPS} steps`)
  }

  const ids = new Set<string>()
  return value.map((raw, index) => {
    const record = asRecord(raw)
    const type = readString(record.type)
    const id = readString(record.id)
    if (id && ids.has(id)) throw new BrowserFlowError('conditionNotMet', `browser_flow step id "${id}" is duplicated`)
    if (id) ids.add(id)
    const base = id ? { id } : {}

    if (type === 'fill') {
      const selector = requiredSelector(record.selector, index)
      if (typeof record.value !== 'string') throw invalidStep(index, 'fill requires a string value')
      if (record.value.length > MAX_FILL_CHARS) throw invalidStep(index, `fill value exceeds ${MAX_FILL_CHARS} characters`)
      return { ...base, type, selector, value: record.value }
    }
    if (type === 'click' || type === 'submit') {
      const selector = requiredSelector(record.selector, index)
      const navigation = record.navigation === 'required' || record.navigation === 'none' || record.navigation === 'auto'
        ? record.navigation
        : undefined
      return { ...base, type, selector, ...(navigation ? { navigation } : {}) }
    }
    if (type === 'wait') {
      const selector = readString(record.selector)
      const urlContains = readString(record.urlContains)
      if (Boolean(selector) === Boolean(urlContains)) {
        throw invalidStep(index, 'wait requires exactly one of selector or urlContains')
      }
      if (selector && selector.length > MAX_SELECTOR_CHARS) throw invalidStep(index, 'selector is too long')
      const stableMs = typeof record.stableMs === 'number' && Number.isFinite(record.stableMs)
        ? Math.max(0, Math.min(MAX_STABLE_MS, Math.round(record.stableMs)))
        : undefined
      return { ...base, type, ...(selector ? { selector } : { urlContains: urlContains as string }), ...(stableMs === undefined ? {} : { stableMs }) }
    }
    if (type === 'find') {
      const selector = requiredSelector(record.selector, index)
      const limit = typeof record.limit === 'number' && Number.isFinite(record.limit)
        ? Math.max(1, Math.min(MAX_FIND_LIMIT, Math.round(record.limit)))
        : undefined
      const onMissing = record.onMissing === 'error' || record.onMissing === 'stop' ? record.onMissing : undefined
      return { ...base, type, selector, ...(limit === undefined ? {} : { limit }), ...(onMissing ? { onMissing } : {}) }
    }
    throw invalidStep(index, `unsupported type ${JSON.stringify(type ?? '')}`)
  })
}

function requiredSelector(value: unknown, index: number): string {
  const selector = readString(value)
  if (!selector) throw invalidStep(index, 'requires a selector')
  if (selector.length > MAX_SELECTOR_CHARS) throw invalidStep(index, 'selector is too long')
  return selector
}

function invalidStep(index: number, message: string): BrowserFlowError {
  return new BrowserFlowError('conditionNotMet', `browser_flow step ${index + 1} ${message}`)
}

async function executeAction(
  webContents: WebContents,
  step: Extract<BrowserFlowStep, { type: 'fill' | 'click' | 'submit' }>
): Promise<unknown> {
  const program = buildActionProgram(step)
  const raw = await webContents.executeJavaScript(program, true)
  const result = asRecord(raw)
  if (result.ok === true) return result.result
  const code = result.code === 'invalidSelector' ? 'invalidSelector'
    : result.code === 'selectorNotFound' ? 'selectorNotFound'
      : 'pageScriptError'
  throw new BrowserFlowError(code, typeof result.error === 'string' ? result.error : `browser_flow ${step.type} failed`)
}

function buildActionProgram(step: Extract<BrowserFlowStep, { type: 'fill' | 'click' | 'submit' }>): string {
  return `(async () => {
    const step = ${JSON.stringify(step)};
    const queryDeep = (selector) => {
      const roots = [document];
      for (let index = 0; index < roots.length; index += 1) {
        const root = roots[index];
        let match;
        try { match = root.querySelector(selector); }
        catch (error) { return { error: 'invalid selector: ' + (error?.message || String(error)) }; }
        if (match) return { match };
        for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
      }
      return { match: null };
    };
    const selected = queryDeep(step.selector);
    if (selected.error) return { ok: false, code: 'invalidSelector', error: selected.error };
    const element = selected.match;
    if (!element) return { ok: false, code: 'selectorNotFound', error: 'selector not found: ' + step.selector };
    if (step.type === 'fill') {
      if (element.isContentEditable) {
        element.textContent = step.value;
      } else {
        const prototypes = [HTMLInputElement.prototype, HTMLTextAreaElement.prototype, HTMLSelectElement.prototype];
        const prototype = prototypes.find((candidate) => candidate.isPrototypeOf(element));
        const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(element, step.value);
        else if ('value' in element) element.value = step.value;
        else return { ok: false, code: 'pageScriptError', error: 'element cannot be filled: ' + step.selector };
      }
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return { ok: true, result: { tag: element.tagName.toLowerCase(), value: 'value' in element ? String(element.value) : element.textContent } };
    }
    if (step.type === 'submit') {
      const form = element instanceof HTMLFormElement ? element : element.closest('form');
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      else if (typeof element.click === 'function') element.click();
      else return { ok: false, code: 'pageScriptError', error: 'element cannot be submitted: ' + step.selector };
      return { ok: true, result: { tag: element.tagName.toLowerCase(), submitted: true } };
    }
    if (typeof element.click !== 'function') return { ok: false, code: 'pageScriptError', error: 'element cannot be clicked: ' + step.selector };
    element.click();
    return { ok: true, result: { tag: element.tagName.toLowerCase(), clicked: true } };
  })()`
}

async function waitForCondition(
  webContents: WebContents,
  observer: ReturnType<typeof observeNavigation>,
  step: Extract<BrowserFlowStep, { type: 'wait' }>,
  deadline: number,
  id: string
): Promise<{ url: string; count: number; stableMs: number }> {
  const stableMs = step.stableMs ?? DEFAULT_STABLE_MS
  let stableSince = 0
  let stableSignature = ''
  let lastProbe = { url: safeUrl(webContents), count: 0 }

  while (Date.now() < deadline) {
    assertTargetOpen(webContents)
    try {
      const probe = await probeCondition(webContents, step)
      lastProbe = probe
      const matched = step.selector ? probe.count > 0 : probe.url.includes(step.urlContains as string)
      const signature = `${probe.url}\n${probe.count}`
      if (matched) {
        if (signature !== stableSignature) {
          stableSignature = signature
          stableSince = Date.now()
        }
        if (Date.now() - stableSince >= stableMs) {
          return { ...probe, stableMs: Date.now() - stableSince }
        }
      } else {
        stableSignature = ''
        stableSince = 0
      }
    } catch (error) {
      if (!isContextChangedError(error)) throw normalizeActionError(error, id)
    }
    const revision = observer.state().revision
    await observer.waitForChange(revision, Math.min(50, remainingMs(deadline)))
  }

  const condition = step.selector ? `selector ${step.selector}` : `URL containing ${step.urlContains}`
  throw new BrowserFlowError(
    'conditionTimeout',
    `browser_flow step "${id}" timed out waiting for ${condition}; last URL ${lastProbe.url}`
  )
}

async function probeCondition(
  webContents: WebContents,
  step: Extract<BrowserFlowStep, { type: 'wait' }>
): Promise<{ url: string; count: number }> {
  if (!step.selector) return { url: safeUrl(webContents), count: 0 }
  const raw = await webContents.executeJavaScript(buildFindProgram(step.selector, 1, true), true)
  const result = asRecord(raw)
  if (result.code === 'invalidSelector') {
    throw new BrowserFlowError('invalidSelector', typeof result.error === 'string' ? result.error : `invalid selector: ${step.selector}`)
  }
  return {
    url: typeof result.url === 'string' ? result.url : safeUrl(webContents),
    count: typeof result.count === 'number' ? result.count : 0
  }
}

async function inspectOnce(webContents: WebContents, selector: string, limit: number): Promise<{ count: number; matches: BrowserFlowMatch[] }> {
  assertTargetOpen(webContents)
  let raw: unknown
  try {
    raw = await webContents.executeJavaScript(buildFindProgram(selector, limit, false), true)
  } catch (error) {
    throw normalizeActionError(error, 'find')
  }
  const result = asRecord(raw)
  if (result.code === 'invalidSelector') {
    throw new BrowserFlowError('invalidSelector', typeof result.error === 'string' ? result.error : `invalid selector: ${selector}`)
  }
  return {
    count: typeof result.count === 'number' ? result.count : 0,
    matches: Array.isArray(result.matches) ? result.matches as BrowserFlowMatch[] : []
  }
}

function buildFindProgram(selector: string, limit: number, countOnly: boolean): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const limit = ${Math.max(1, Math.min(MAX_FIND_LIMIT, Math.round(limit)))};
    const roots = [document];
    const matches = [];
    let count = 0;
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      let selected;
      try { selected = root.querySelectorAll(selector); }
      catch (error) { return { code: 'invalidSelector', error: 'invalid selector: ' + (error?.message || String(error)), url: location.href, count: 0, matches: [] }; }
      for (const element of selected) {
        count += 1;
        if (!${countOnly ? 'true' : 'false'} && matches.length < limit) {
          matches.push({
            tag: element.tagName.toLowerCase(),
            text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500) || null,
            name: (element.getAttribute('aria-label') || element.getAttribute('title') || '').trim().slice(0, 300) || null,
            href: typeof element.href === 'string' ? element.href : element.getAttribute('href'),
            value: 'value' in element ? String(element.value).slice(0, 1000) : null,
            checked: 'checked' in element ? Boolean(element.checked) : null,
            disabled: 'disabled' in element ? Boolean(element.disabled) : null
          });
        }
      }
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
    }
    return { url: location.href, count, matches };
  })()`
}

function observeNavigation(webContents: WebContents): {
  state: () => NavigationState
  snapshot: () => BrowserFlowResult['navigation']
  hasNavigationAfter: (before: NavigationState) => boolean
  waitForNavigationAfter: (before: NavigationState, timeoutMs: number) => Promise<boolean>
  waitForChange: (revision: number, timeoutMs: number) => Promise<boolean>
  dispose: () => void
} {
  const state: NavigationState = {
    started: 0,
    committed: 0,
    inPage: 0,
    lastUrl: safeUrl(webContents),
    revision: 0,
    destroyed: false
  }
  const waiters = new Set<() => void>()
  const changed = (): void => {
    state.revision += 1
    for (const waiter of [...waiters]) waiter()
    waiters.clear()
  }
  const onStarted = (_event: Electron.Event, url: string, _isInPlace: boolean, isMainFrame: boolean): void => {
    if (!isMainFrame) return
    state.started += 1
    state.lastUrl = url || state.lastUrl
    changed()
  }
  const onCommitted = (_event: Electron.Event, url: string): void => {
    state.committed += 1
    state.lastUrl = url || safeUrl(webContents)
    changed()
  }
  const onInPage = (_event: Electron.Event, url: string, isMainFrame: boolean): void => {
    if (!isMainFrame) return
    state.inPage += 1
    state.lastUrl = url || safeUrl(webContents)
    changed()
  }
  const onReady = (): void => {
    state.lastUrl = safeUrl(webContents) || state.lastUrl
    changed()
  }
  const onDestroyed = (): void => {
    state.destroyed = true
    changed()
  }
  webContents.on('did-start-navigation', onStarted)
  webContents.on('did-navigate', onCommitted)
  webContents.on('did-navigate-in-page', onInPage)
  webContents.on('dom-ready', onReady)
  webContents.on('destroyed', onDestroyed)

  const waitForChange = async (revision: number, timeoutMs: number): Promise<boolean> => {
    if (state.revision !== revision) return true
    if (timeoutMs <= 0) return false
    return new Promise<boolean>((resolve) => {
      let finished = false
      const finish = (changedState: boolean): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        waiters.delete(onChange)
        resolve(changedState)
      }
      const onChange = (): void => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      waiters.add(onChange)
    })
  }

  const hasNavigationAfter = (before: NavigationState): boolean =>
    state.started > before.started || state.committed > before.committed || state.inPage > before.inPage

  return {
    state: () => ({ ...state }),
    snapshot: () => ({ started: state.started, committed: state.committed, inPage: state.inPage, lastUrl: safeUrl(webContents) || state.lastUrl }),
    hasNavigationAfter,
    waitForNavigationAfter: async (before, timeoutMs) => {
      const deadline = Date.now() + Math.max(0, timeoutMs)
      while (!hasNavigationAfter(before) && Date.now() < deadline && !state.destroyed) {
        await waitForChange(state.revision, Math.min(50, deadline - Date.now()))
      }
      return hasNavigationAfter(before)
    },
    waitForChange,
    dispose: () => {
      webContents.removeListener('did-start-navigation', onStarted)
      webContents.removeListener('did-navigate', onCommitted)
      webContents.removeListener('did-navigate-in-page', onInPage)
      webContents.removeListener('dom-ready', onReady)
      webContents.removeListener('destroyed', onDestroyed)
      for (const waiter of [...waiters]) waiter()
      waiters.clear()
    }
  }
}

function normalizeActionError(error: unknown, id: string): BrowserFlowError {
  if (error instanceof BrowserFlowError) return error
  if (isContextChangedError(error)) {
    return new BrowserFlowError('targetChanged', `browser_flow step "${id}" lost its page context: ${errorMessage(error)}`)
  }
  if (/target.*(?:closed|destroyed)|webcontents.*destroyed|page was closed/i.test(errorMessage(error))) {
    return new BrowserFlowError('targetClosed', `browser_flow step "${id}" lost its target: ${errorMessage(error)}`)
  }
  return new BrowserFlowError('pageScriptError', `browser_flow step "${id}" failed: ${errorMessage(error)}`)
}

function isContextChangedError(error: unknown): boolean {
  return /execution context was destroyed|cannot find context|cannot execute JavaScript in this frame|target changed/i.test(errorMessage(error))
}

function assertTargetOpen(webContents: WebContents): void {
  if (webContents.isDestroyed()) throw new BrowserFlowError('targetClosed', 'browser_flow target was closed')
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

function safeUrl(webContents: WebContents): string {
  try {
    return webContents.isDestroyed() ? '' : webContents.getURL()
  } catch {
    return ''
  }
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unknown browser flow error'
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
