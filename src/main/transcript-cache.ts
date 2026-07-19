import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Append-only JSONL cache of each thread's render model, so a restarted app can
// paint transcripts instantly from disk and reconcile with the app-server
// resume in the background (Phase 3). Entries are opaque JSON values owned by
// the renderer; this store guarantees ordering, crash tolerance (a torn final
// line is skipped on read and trimmed by the next compaction), and a bounded
// on-disk footprint via newest-tail compaction.

const safeIdPattern = /^[a-z0-9_-]{1,128}$/i

export type TranscriptCacheLimits = {
  maxEntryBytes: number
  maxFileBytes: number
  compactTargetBytes: number
}

const defaultLimits: TranscriptCacheLimits = {
  maxEntryBytes: 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  compactTargetBytes: 4 * 1024 * 1024
}

export class TranscriptCache {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly root: string
  private readonly limits: TranscriptCacheLimits

  constructor(root: string, limits: Partial<TranscriptCacheLimits> = {}) {
    this.root = root
    this.limits = { ...defaultLimits, ...limits }
  }

  async append(threadId: string, entries: unknown[]): Promise<void> {
    if (!entries.length) return
    const lines = entries.map((entry) => {
      const line = JSON.stringify(entry)
      if (line === undefined) throw new Error('transcript cache entry is not serializable')
      if (Buffer.byteLength(line, 'utf8') > this.limits.maxEntryBytes) {
        throw new Error(`transcript cache entry exceeds ${this.limits.maxEntryBytes} bytes`)
      }
      return line
    })

    await this.enqueue(threadId, async () => {
      const path = this.pathFor(threadId)
      await mkdir(this.root, { recursive: true })
      // Leading-newline guard: if a prior append was interrupted mid-line, the
      // file has no trailing newline and a bare append would concatenate onto
      // the torn line and corrupt this batch too. The occasional resulting
      // blank line is filtered on read and dropped by compaction.
      let needsGuard = false
      try {
        needsGuard = (await stat(path)).size > 0
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await appendFile(path, `${needsGuard ? '\n' : ''}${lines.join('\n')}\n`, 'utf8')
      await this.compactIfOversized(threadId)
    })
  }

  async read(threadId: string): Promise<unknown[]> {
    validateThreadId(threadId)
    await this.queues.get(threadId)
    let content: string
    try {
      content = await readFile(this.pathFor(threadId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return parseLines(content)
  }

  // Atomic full rewrite — used when the background server reconcile finds the
  // cache stale (thread compacted/rewritten server-side).
  async replace(threadId: string, entries: unknown[]): Promise<void> {
    await this.enqueue(threadId, async () => {
      await mkdir(this.root, { recursive: true })
      await this.writeAtomic(threadId, entries.map((entry) => JSON.stringify(entry)))
    })
  }

  async remove(threadId: string): Promise<void> {
    await this.enqueue(threadId, async () => {
      await rm(this.pathFor(threadId), { force: true })
    })
  }

  private async compactIfOversized(threadId: string): Promise<void> {
    const path = this.pathFor(threadId)
    const info = await stat(path)
    if (info.size <= this.limits.maxFileBytes) return

    const content = await readFile(path, 'utf8')
    const lines = content.split('\n').filter((line) => line !== '' && isParsable(line))

    // Keep the newest whole lines that fit the post-compaction target.
    const kept: string[] = []
    let budget = this.limits.compactTargetBytes
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const cost = Buffer.byteLength(lines[index], 'utf8') + 1
      if (cost > budget) break
      kept.unshift(lines[index])
      budget -= cost
    }

    await this.writeAtomic(threadId, kept)
  }

  private async writeAtomic(threadId: string, lines: string[]): Promise<void> {
    const path = this.pathFor(threadId)
    const temporaryPath = `${path}.${process.pid}.tmp`
    await writeFile(temporaryPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
    await rename(temporaryPath, path)
  }

  private async enqueue(threadId: string, operation: () => Promise<void>): Promise<void> {
    validateThreadId(threadId)
    const previous = this.queues.get(threadId) ?? Promise.resolve()
    const chained = previous.then(operation)
    const queueTail = chained.catch(() => {})
    this.queues.set(threadId, queueTail)
    try {
      await chained
    } finally {
      if (this.queues.get(threadId) === queueTail) this.queues.delete(threadId)
    }
  }

  private pathFor(threadId: string): string {
    return join(this.root, `${threadId}.jsonl`)
  }
}

function validateThreadId(threadId: string): void {
  if (!safeIdPattern.test(threadId)) throw new Error('invalid transcript cache thread id')
}

function parseLines(content: string): unknown[] {
  const entries: unknown[] = []
  for (const line of content.split('\n')) {
    if (line === '') continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // A torn trailing line from an interrupted append is expected; skip it.
      // (Mid-file corruption is also skipped rather than poisoning the read —
      // the next compaction drops it permanently.)
    }
  }
  return entries
}

function isParsable(line: string): boolean {
  try {
    JSON.parse(line)
    return true
  } catch {
    return false
  }
}
