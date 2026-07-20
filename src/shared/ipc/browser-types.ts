export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserTabState = {
  id: string
  title: string
  url: string
  favicon: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isAudible: boolean
  isMuted: boolean
  zoomPercent: number
}

export type BrowserFindResult = {
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

/**
 * Built-in VPN (Tor) status. `starting` covers binary launch through circuit
 * bootstrap; the proxy is applied to the browser session only once `on`.
 */
export type BrowserVpnStatus = {
  state: 'off' | 'starting' | 'on' | 'error'
  /** Tor bootstrap percentage, 0-100. Meaningful while `starting`. */
  bootstrapProgress: number
  /** Human-readable bootstrap phase or error message, if any. */
  detail: string | null
}

export type BrowserState = {
  tabs: BrowserTabState[]
  activeTabId: string | null
  vpn: BrowserVpnStatus
}

export type OmniboxSuggestion = {
  kind: 'navigate' | 'search' | 'history'
  /** Full URL this row navigates to when committed. */
  url: string
  /** Primary display text: page title, typed query, or the URL itself. */
  text: string
  /** Secondary display text: display URL for history rows, engine label for search. */
  detail: string
  /** Sanitized site identity captured by the browser tab, when available. */
  favicon: string | null
}

/** Dropdown anchor in window content coordinates: the omnibox rect's bottom edge. */
export type OmniboxAnchor = {
  x: number
  y: number
  width: number
}

/** Commands the browser overflow (kebab) menu can dispatch. */
export type BrowserMenuCommand =
  | 'find'
  | 'mute'
  | 'vpn'
  | 'zoom-out'
  | 'zoom-reset'
  | 'zoom-in'
  | 'fullscreen'

export type BrowserMenuItem =
  | {
      kind: 'action'
      command: Exclude<BrowserMenuCommand, 'zoom-out' | 'zoom-reset' | 'zoom-in'>
      label: string
      /** Icon key resolved by the popup document (it has its own svg set). */
      icon: 'find' | 'volume' | 'volume-muted' | 'shield' | 'fullscreen' | 'fullscreen-exit'
      disabled?: boolean
      checked?: boolean
    }
  | { kind: 'zoom'; percent: number; disabled?: boolean }
  | { kind: 'separator' }

/** Anchor in window content coordinates: the menu button rect's bottom-right corner. */
export type BrowserMenuAnchor = {
  x: number
  y: number
}

export type BrowserMenuRenderPayload = {
  items: BrowserMenuItem[]
}

export type OmniboxRenderPayload = {
  suggestions: OmniboxSuggestion[]
  selectedIndex: number
}

export type OmniboxQueryResult = {
  suggestions: OmniboxSuggestion[]
  /**
   * Full address-bar text to inline-autocomplete (typed prefix preserved), or
   * null when nothing should complete. The renderer shows the remainder as
   * selected text so the next keystroke replaces it.
   */
  inline: string | null
}
