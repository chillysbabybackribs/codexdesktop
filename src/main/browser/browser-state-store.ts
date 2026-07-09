import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseSavedBrowserState, sanitizeBrowserState } from './browser-state-sanitize.js'
import type { SavedBrowserState } from './browser-state-types.js'

export type { SavedBrowserState, SavedBrowserTab } from './browser-state-types.js'
export { MAX_SAVED_BROWSER_TABS } from './browser-state-types.js'

export class BrowserStateStore {
  private readonly filePath: string

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

    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(payload)}\n`, 'utf8')
  }

  saveSync(state: SavedBrowserState): void {
    const payload = sanitizeBrowserState(state)

    if (!payload) {
      return
    }

    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, `${JSON.stringify(payload)}\n`, 'utf8')
  }
}
