import { join } from 'node:path'
import { buildPageExtractionProgram } from '../browser/browser-agent.js'
import {
  runStaticExtraction,
  staticArtifactChars,
  type StaticExtractOutcome
} from './static-extract.js'

// Runs static-lane HTML extraction in a utilityProcess when Electron is
// available, falling back to the identical in-process implementation when it
// is not (node tests) or when the worker fails/times out. Callers never see
// the difference; the fallback simply pays the main-thread cost the worker
// exists to avoid.

const jobTimeoutMs = 15_000

type UtilityProcessLike = {
  postMessage: (message: unknown) => void
  once: (event: string, listener: (...args: unknown[]) => void) => void
  on: (event: string, listener: (...args: unknown[]) => void) => void
  kill: () => void
}

type WorkerResult = { type: 'result'; id: number } & StaticExtractOutcome

let extractionProgram: string | null = null
let worker: UtilityProcessLike | null = null
let workerBroken = false
let nextJobId = 1
const pending = new Map<number, (outcome: StaticExtractOutcome | null) => void>()

function program(): string {
  if (extractionProgram === null) extractionProgram = buildPageExtractionProgram(staticArtifactChars)
  return extractionProgram
}

function failAllPending(): void {
  for (const resolve of pending.values()) resolve(null)
  pending.clear()
}

async function ensureWorker(): Promise<UtilityProcessLike | null> {
  if (worker) return worker
  if (workerBroken) return null
  try {
    const { utilityProcess } = await import('electron')
    const spawned = utilityProcess.fork(join(__dirname, 'static-extract-worker.js'), [], {
      serviceName: 'codexdesktop-static-extract'
    }) as unknown as UtilityProcessLike
    spawned.on('message', (message: unknown) => {
      const result = message as WorkerResult
      if (result?.type !== 'result') return
      const resolve = pending.get(result.id)
      if (!resolve) return
      pending.delete(result.id)
      resolve(result.ok ? { ok: true, page: result.page } : { ok: false, reason: result.reason })
    })
    spawned.once('exit', () => {
      // Crash or shutdown: current jobs fall back inline; the next call
      // attempts a fresh worker.
      failAllPending()
      worker = null
    })
    spawned.postMessage({ type: 'init', program: program() })
    worker = spawned
    return worker
  } catch {
    // Not running under Electron (unit tests) or utilityProcess unavailable.
    workerBroken = true
    return null
  }
}

export async function extractStaticPage(html: string, url: string): Promise<StaticExtractOutcome> {
  const active = await ensureWorker()
  if (!active) return runStaticExtraction(program(), html, url)

  const outcome = await new Promise<StaticExtractOutcome | null>((resolve) => {
    const id = nextJobId++
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve(null)
    }, jobTimeoutMs)
    pending.set(id, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    try {
      active.postMessage({ type: 'extract', id, html, url })
    } catch {
      clearTimeout(timer)
      pending.delete(id)
      resolve(null)
    }
  })

  // Worker unavailable/timed out: do the work inline rather than dropping the
  // page — slower but never silently degraded.
  return outcome ?? runStaticExtraction(program(), html, url)
}
