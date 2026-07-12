import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const RESEARCH_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const RESEARCH_MAX_BYTES = 250 * 1024 * 1024

export type ResearchArtifactPaths = {
  artifactPath: string
  htmlPath: string
}

export class ResearchMemoryCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: T }>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(ttlMs: number, maxEntries: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.now = now
  }

  get(key: string): T | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return null
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (typeof oldest !== 'string') break
      this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}

export async function writeResearchPageArtifacts(
  artifactDir: string,
  baseName: string,
  content: string,
  html: string,
  signal?: AbortSignal
): Promise<ResearchArtifactPaths> {
  await mkdir(artifactDir, { recursive: true })
  const artifactPath = join(artifactDir, `${baseName}.txt`)
  const htmlPath = join(artifactDir, `${baseName}.html`)
  await Promise.all([
    writeFile(artifactPath, content.endsWith('\n') ? content : `${content}\n`, { encoding: 'utf8', signal }),
    writeFile(htmlPath, html, { encoding: 'utf8', signal })
  ])
  return { artifactPath, htmlPath }
}

export class ResearchPruneGate {
  private lastStartedAt = Number.NEGATIVE_INFINITY
  private running: Promise<void> | null = null
  private readonly cooldownMs: number
  private readonly prune: (root: string) => Promise<void>
  private readonly now: () => number

  constructor(
    cooldownMs: number,
    prune: (root: string) => Promise<void> = pruneResearchArtifacts,
    now: () => number = Date.now
  ) {
    this.cooldownMs = cooldownMs
    this.prune = prune
    this.now = now
  }

  schedule(root: string): Promise<void> | null {
    if (this.running) return this.running
    const now = this.now()
    if (now - this.lastStartedAt < this.cooldownMs) return null
    this.lastStartedAt = now
    const running = this.prune(root).finally(() => {
      if (this.running === running) this.running = null
    })
    this.running = running
    return running
  }
}

export async function pruneResearchArtifacts(root: string): Promise<void> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const directories = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(root, entry.name)
        const info = await stat(path)
        const children = await readdir(path, { withFileTypes: true })
        const sizes = await Promise.all(children
          .filter((child) => child.isFile())
          .map(async (child) => (await stat(join(path, child.name))).size))
        return { path, modifiedAt: info.mtimeMs, size: sizes.reduce((sum, size) => sum + size, 0) }
      }))

    directories.sort((left, right) => right.modifiedAt - left.modifiedAt)
    let retainedBytes = 0
    const now = Date.now()

    for (const directory of directories) {
      retainedBytes += directory.size
      if (now - directory.modifiedAt > RESEARCH_MAX_AGE_MS || retainedBytes > RESEARCH_MAX_BYTES) {
        await rm(directory.path, { recursive: true, force: true })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
