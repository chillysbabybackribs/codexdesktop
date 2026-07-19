import type { WebContents, WebFrameMain } from 'electron'
import { BrowserFlowError } from './browser-flow.js'
import type { CdpFileArtifact } from './cdp-artifact-store.js'
import type { TabManager } from './tab-manager.js'

export type BrowserFailureCode =
  | 'cancelled'
  | 'noResult'
  | 'timeout'
  | 'targetClosed'
  | 'targetChanged'
  | 'frameDetached'
  | 'frameNotFound'
  | 'executionError'
  | 'pageScriptError'
  | 'conditionNotMet'
  | 'conditionTimeout'
  | 'selectorNotFound'
  | 'invalidSelector'
  | 'resultSerializationError'

export type BrowserFailurePhase =
  | 'pageScript'
  | 'targetLifecycle'
  | 'navigationReadiness'
  | 'snapshotVerification'
  | 'resultSerialization'
  | 'browserFlow'
  | 'controller'

export type BrowserFailure = {
  code: BrowserFailureCode
  phase: BrowserFailurePhase
  message: string
  name?: string
  stack?: string
}

export type BrowserFrameDescriptor = {
  frameId: string
  parentFrameId: string | null
  name: string
  url: string
  origin: string
  isMainFrame: boolean
}

export type BrowserSnapshotCompletion = {
  /** `complete` means the returned snapshot is sufficient to answer from directly. */
  status: 'complete' | 'incomplete'
  /** The next evidence operation, if any; this never removes browser capabilities. */
  nextAction: 'answer' | 'targeted-gap-fill'
  reason: string
  gaps: string[]
}

export type BrowserAgentResult = {
  ok: boolean
  result?: unknown
  error?: string
  tabId?: string
  url?: string
  title?: string
  durationMs?: number
  resultChars?: number
  truncated?: boolean
  errorCode?: BrowserFailureCode
  failure?: BrowserFailure
  artifact?: CdpFileArtifact
  targetState?: {
    frames?: BrowserFrameDescriptor[]
    targets?: ReturnType<TabManager['listTargets']>
  }
  /** Snapshot-specific execution hint derived from structured coverage, not model reasoning. */
  completion?: BrowserSnapshotCompletion
  /** Navigation selector state retained when a snapshot can still verify the requested evidence. */
  readiness?: {
    selector: string
    settleReason: string
    matched: boolean
  }
}

export type BrowserAgentSuccess = BrowserAgentResult & {
  ok: true
  result: unknown
  tabId: string
  url: string
  title: string
  durationMs: number
  resultChars: number
  truncated: boolean
}

export type BrowserAgentFailure = BrowserAgentResult & {
  ok: false
  error: string
}

export type BrowserTargetLease = {
  tabId: string
  webContents: WebContents
  epoch: number
}

/** Serializes work by key while allowing unrelated keys to run concurrently. */
export class KeyedOperationQueue {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, execute: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const operation = previous.then(execute)
    const tail = operation.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return operation
  }
}

export class BrowserOperationError extends Error {
  readonly failure: BrowserFailure

  constructor(failure: BrowserFailure) {
    super(failure.message)
    this.name = failure.name ?? 'BrowserOperationError'
    this.failure = failure
    if (failure.stack) this.stack = failure.stack
  }
}

export function operationError(
  code: BrowserFailureCode,
  phase: BrowserFailurePhase,
  message: string,
  details: Pick<BrowserFailure, 'name' | 'stack'> = {}
): BrowserOperationError {
  return new BrowserOperationError({ code, phase, message, ...details })
}

export function browserFailureFor(
  error: unknown,
  fallbackCode: BrowserFailureCode = 'executionError',
  fallbackPhase: BrowserFailurePhase = 'controller'
): BrowserFailure {
  if (error instanceof BrowserOperationError) return error.failure
  if (error instanceof BrowserFlowError) {
    return {
      code: error.code,
      phase: error.phase,
      message: error.message,
      name: error.name,
      ...(error.stack ? { stack: error.stack.slice(0, 4_000) } : {})
    }
  }
  const message = errorMessage(error)
  const name = error instanceof Error && error.name ? error.name.slice(0, 120) : undefined
  const stack = error instanceof Error && error.stack ? error.stack.slice(0, 4_000) : undefined
  if (/browser operation timed out|navigation timed out|CDP event wait timed out/i.test(message)) {
    return {
      code: 'timeout',
      phase: 'controller',
      message,
      ...(name ? { name } : {}),
      ...(stack ? { stack } : {})
    }
  }
  if (/no live frame with id/i.test(message)) {
    return {
      code: 'frameNotFound',
      phase: 'targetLifecycle',
      message,
      ...(name ? { name } : {}),
      ...(stack ? { stack } : {})
    }
  }
  if (/frame.*(?:disposed|detached|destroyed)|render frame was disposed/i.test(message)) {
    return {
      code: 'frameDetached',
      phase: 'targetLifecycle',
      message,
      ...(name ? { name } : {}),
      ...(stack ? { stack } : {})
    }
  }
  if (/execution context was destroyed|cannot find context|cannot execute JavaScript in this frame|target changed/i.test(message)) {
    return {
      code: 'targetChanged',
      phase: 'targetLifecycle',
      message,
      ...(name ? { name } : {}),
      ...(stack ? { stack } : {})
    }
  }
  if (/target.*(?:closed|destroyed)|webcontents.*destroyed|page was closed/i.test(message)) {
    return {
      code: 'targetClosed',
      phase: 'targetLifecycle',
      message,
      ...(name ? { name } : {}),
      ...(stack ? { stack } : {})
    }
  }
  if (/not JSON serializable|could not be cloned|object could not be cloned|serialize/i.test(message)) {
    return {
      code: 'resultSerializationError',
      phase: 'resultSerialization',
      message,
      ...(name ? { name } : {}),
      ...(stack ? { stack } : {})
    }
  }
  return {
    code: fallbackCode,
    phase: fallbackPhase,
    message,
    ...(name ? { name } : {}),
    ...(stack ? { stack } : {})
  }
}

export function browserFailureFields(
  error: unknown,
  fallbackCode: BrowserFailureCode = 'executionError',
  fallbackPhase: BrowserFailurePhase = 'controller'
): Pick<BrowserAgentFailure, 'error' | 'errorCode' | 'failure'> {
  const failure = browserFailureFor(error, fallbackCode, fallbackPhase)
  return { error: failure.message, errorCode: failure.code, failure }
}

export function isLifecycleFailure(code: BrowserFailureCode | undefined): boolean {
  return (
    code === 'timeout' ||
    code === 'targetClosed' ||
    code === 'targetChanged' ||
    code === 'frameDetached' ||
    code === 'frameNotFound'
  )
}

export function liveFrames(mainFrame: WebFrameMain): WebFrameMain[] {
  try {
    return mainFrame.framesInSubtree.filter((frame) => !frame.isDestroyed() && !frame.detached)
  } catch {
    return mainFrame.isDestroyed() || mainFrame.detached ? [] : [mainFrame]
  }
}

export function describeFrame(
  frame: WebFrameMain,
  mainFrame: WebFrameMain
): BrowserFrameDescriptor {
  return {
    frameId: String(frame.frameTreeNodeId),
    parentFrameId: frame.parent ? String(frame.parent.frameTreeNodeId) : null,
    name: frame.name,
    url: frame.url,
    origin: frame.origin,
    isMainFrame: frame === mainFrame
  }
}

export function frameInventory(webContents: WebContents): BrowserFrameDescriptor[] {
  try {
    const mainFrame = webContents.mainFrame
    return liveFrames(mainFrame).map((frame) => describeFrame(frame, mainFrame))
  } catch {
    return []
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void | Promise<void>,
  signal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let abortHandler: (() => void) | null = null
  let settled = false
  const cancel = (reject: (reason?: unknown) => void, error: Error): void => {
    if (settled) return
    settled = true
    void Promise.resolve(onTimeout?.()).finally(() => reject(error))
  }
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      cancel(
        reject,
        operationError('timeout', 'controller', `browser operation timed out after ${timeoutMs}ms`)
      )
    }, timeoutMs)
    if (signal) {
      abortHandler = () => {
        cancel(
          reject,
          operationError('cancelled', 'controller', 'browser operation cancelled with its owning turn')
        )
      }
      signal.addEventListener('abort', abortHandler, { once: true })
      if (signal.aborted) abortHandler()
    }
  })

  return Promise.race([promise, timeout]).finally(() => {
    settled = true
    if (timer) clearTimeout(timer)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
  })
}

export function cancelledResult(): BrowserAgentFailure {
  const failure = browserFailureFor(
    operationError('cancelled', 'controller', 'browser operation cancelled with its owning turn')
  )
  return { ok: false, error: failure.message, errorCode: failure.code, failure }
}

export function boundResult(
  value: unknown,
  maxChars: number
): { value: unknown; chars: number; truncated: boolean } {
  let serialized: string

  try {
    serialized = JSON.stringify(value) ?? 'null'
  } catch (error) {
    throw operationError(
      'resultSerializationError',
      'resultSerialization',
      `browser result is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (serialized.length <= maxChars) {
    return { value, chars: serialized.length, truncated: false }
  }

  return {
    value: structuredPreview(serialized, maxChars),
    chars: serialized.length,
    truncated: true
  }
}

export function captureTargetLease(tabs: TabManager, tabId: string): BrowserTargetLease | null {
  const webContents = tabs.resolveWebContents(tabId)
  if (!webContents) return null
  // Test doubles and the legacy socket adapter may not expose epochs yet; the
  // WebContents identity still protects target close/replacement in that path.
  const epochReader = (tabs as Partial<Pick<TabManager, 'getTargetEpoch'>>).getTargetEpoch
  return { tabId, webContents, epoch: epochReader?.call(tabs, tabId) ?? 0 }
}

export function assertTargetLeaseCurrent(tabs: TabManager, lease: BrowserTargetLease): void {
  const current = tabs.resolveWebContents(lease.tabId)
  if (!current) {
    throw operationError(
      'targetClosed',
      'targetLifecycle',
      `browser target ${lease.tabId} closed during operation`
    )
  }
  const epochReader = (tabs as Partial<Pick<TabManager, 'getTargetEpoch'>>).getTargetEpoch
  const epoch = epochReader?.call(tabs, lease.tabId)
  if (
    current !== lease.webContents ||
    (epoch !== undefined && epoch !== null && epoch !== lease.epoch)
  ) {
    throw operationError(
      'targetChanged',
      'targetLifecycle',
      `browser target ${lease.tabId} changed during operation`
    )
  }
}

export function safeUrl(webContents: WebContents): string {
  try {
    return webContents.getURL()
  } catch {
    return ''
  }
}

export function safeTitle(webContents: WebContents): string {
  try {
    return webContents.getTitle()
  } catch {
    return ''
  }
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unknown browser error'
  }
}

function structuredPreview(
  serialized: string,
  maxChars: number
): { truncated: true; originalChars: number; preview: string } {
  const originalChars = serialized.length
  const empty = { truncated: true as const, originalChars, preview: '' }
  const overhead = JSON.stringify(empty).length
  let preview = serialized.slice(0, Math.max(0, maxChars - overhead - 4))
  let value = { ...empty, preview }
  while (preview.length > 0 && JSON.stringify(value).length > maxChars) {
    const excess = JSON.stringify(value).length - maxChars
    preview = preview.slice(0, Math.max(0, preview.length - Math.max(1, excess)))
    value = { ...empty, preview }
  }
  return value
}
