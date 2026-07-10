import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseSavedBrowserState, sanitizeBrowserState } from './browser-state-sanitize.js'
import type { SavedBrowserState } from './browser-state-types.js'

export type { SavedBrowserState, SavedBrowserTab } from './browser-state-types.js'
export { MAX_SAVED_BROWSER_TABS } from './browser-state-types.js'

export class BrowserStateStore {
  private readonly filePath: string
  private saveQueue: Promise<void> = Promise.resolve()

  constructor() {
    this.filePath = join(app.getPath('userData'), 'browser-state.json')
  }

  async load(): Promise<SavedBrowserState | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
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

    const serialized = `${JSON.stringify(payload)}\n`
    const operation = this.saveQueue.then(async () => {
      const temporaryPath = `${this.filePath}.tmp`
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(temporaryPath, serialized, 'utf8')
      await rename(temporaryPath, this.filePath)
    })
    this.saveQueue = operation.catch(() => {})
    await operation
  }

  saveSync(state: SavedBrowserState): void {
    const payload = sanitizeBrowserState(state)

    if (!payload) {
      return
    }

    const temporaryPath = `${this.filePath}.tmp`
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(temporaryPath, `${JSON.stringify(payload)}\n`, 'utf8')
    renameSync(temporaryPath, this.filePath)
  }
}
