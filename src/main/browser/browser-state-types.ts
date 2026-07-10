import type { NavigationEntry } from 'electron'

export type SavedBrowserTab = {
  title: string
  url: string
  favicon?: string | null
  entries: NavigationEntry[]
  activeIndex: number
}

export type SavedBrowserState = {
  version: 1
  activeTabIndex: number
  tabs: SavedBrowserTab[]
}

export const MAX_SAVED_BROWSER_TABS = 20
