import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { parseSavedBrowserState, sanitizeBrowserState } from './browser-state-sanitize.js'
import type { SavedBrowserState } from './browser-state-types.js'

export type { SavedBrowserState, SavedBrowserTab } from './browser-state-types.js'
export { MAX_SAVED_BROWSER_TABS } from './browser-state-types.js'

export class BrowserStateStore {
  private readonly filePath: string | (() => string)
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string | (() => string)) {
    this.filePath = filePath
  }

  async load(): Promise<SavedBrowserState | null> {
    try {
      const raw = await readFile(this.path(), 'utf8')
      return parseSavedBrowserState(raw)
    } catch {
      return null
    }
  }

  async save(state: SavedBrowserState): Promise<void> {
    const payload = sanitizeBrowserState(state)

    if (!payload) {
      return
    }

    const filePath = this.path()
    const serialized = `${JSON.stringify(payload)}\n`
    const operation = this.saveQueue.then(async () => {
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(temporaryPath, serialized, 'utf8')
      await rename(temporaryPath, filePath)
    })
    this.saveQueue = operation.catch(() => {})
    await operation
  }

  async flush(): Promise<void> {
    await this.saveQueue
  }

  private path(): string {
    return typeof this.filePath === 'function' ? this.filePath() : this.filePath
  }
}
