import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import type {
  BrowserBounds,
  BrowserMenuItem,
  BrowserState,
  BrowserTabState,
  BrowserVpnStatus,
  OmniboxAnchor,
  OmniboxSuggestion
} from '../../shared/ipc'

export function BrowserPane({
  state,
  activeTab,
  viewHostRef,
  viewBounds,
  isFullscreen,
  onToggleFullscreen
}: {
  state: BrowserState
  activeTab: BrowserTabState | null
  viewHostRef: RefObject<HTMLDivElement | null>
  viewBounds: BrowserBounds | null
  isFullscreen: boolean
  onToggleFullscreen: () => void
}): React.JSX.Element {
  return (
    <section className="browser-pane">
      <div className="browser-shell">
        <TabStrip state={state} />
        <BrowserToolbar
          activeTab={activeTab}
          vpn={state.vpn}
          isFullscreen={isFullscreen}
          onToggleFullscreen={onToggleFullscreen}
        />
        <div className="browser-frame">
          <div ref={viewHostRef} className="browser-view-host" data-ready={viewBounds ? 'true' : 'false'} />
        </div>
      </div>
    </section>
  )
}

function TabStrip({ state }: { state: BrowserState }): React.JSX.Element {
  return (
    <div className="tab-strip" role="tablist" aria-label="Open tabs">
      {/* Own flex track so tabs compress/clip here and the + button (a sibling
          with flex:0 0) can never be pushed off the strip. */}
      <div className="tab-list">
        {state.tabs.map((tab) => {
          const active = tab.id === state.activeTabId
          const label = tab.title || 'New Tab'
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              title={label}
              className={`tab ${active ? 'is-active' : ''}`}
              onClick={() => void window.api.browser.activateTab(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  void window.api.browser.activateTab(tab.id)
                }
              }}
              onAuxClick={(event) => {
                // Middle-click closes, as in every mainstream browser.
                if (event.button === 1) {
                  event.preventDefault()
                  void window.api.browser.closeTab(tab.id)
                }
              }}
            >
              <TabFavicon favicon={tab.favicon} isLoading={tab.isLoading} />
              <span className="tab-title">{label}</span>
              {/* A real <button>, not a role-span inside a button — valid
                  interactive nesting and native keyboard/AT behavior. */}
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${label}`}
                onClick={(event) => { event.stopPropagation(); void window.api.browser.closeTab(tab.id) }}
              >
                <CloseIcon />
              </button>
            </div>
          )
        })}
      </div>
      <button type="button" className="new-tab-button" aria-label="New tab" onClick={() => void window.api.browser.newTab()}><PlusIcon /></button>
    </div>
  )
}

// Unfocused address readout: lead with the security posture and the site
// identity (hostname), demote the path. Raw URLs are for editing, not reading.
function omniboxIdentity(
  rawUrl: string
): { kind: 'web' | 'file' | 'other'; secure: boolean; host: string; rest: string } | null {
  if (!rawUrl) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    const host = url.hostname.replace(/^www\./, '')
    const rest = (url.pathname === '/' ? '' : url.pathname) + url.search + url.hash
    return { kind: 'web', secure: url.protocol === 'https:', host, rest }
  }
  if (url.protocol === 'file:') {
    return { kind: 'file', secure: false, host: 'Local file', rest: url.pathname }
  }
  return { kind: 'other', secure: false, host: rawUrl, rest: '' }
}

function TabFavicon({ favicon, isLoading }: { favicon: string | null; isLoading: boolean }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [favicon])
  if (isLoading) return <span className="tab-favicon tab-favicon-spinner" aria-hidden="true" />
  if (favicon && !failed) return <img className="tab-favicon" src={favicon} alt="" aria-hidden="true" onError={() => setFailed(true)} />
  return <GlobeIcon />
}

function GlobeIcon(): React.JSX.Element {
  return (
    <svg className="tab-favicon tab-favicon-fallback" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 1.75c1.9 0 3.25 2.8 3.25 6.25S9.9 14.25 8 14.25 4.75 11.45 4.75 8 6.1 1.75 8 1.75Z" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 8h12M2.6 5.5h10.8M2.6 10.5h10.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function vpnMenuLabel(vpn: BrowserVpnStatus): string {
  switch (vpn.state) {
    case 'on':
      return 'VPN on (Tor)'
    case 'starting':
      return `Connecting VPN… ${vpn.bootstrapProgress}%`
    case 'error':
      return 'VPN error — retry'
    default:
      return 'Enable VPN (Tor)'
  }
}

function buildMenuItems(
  activeTab: BrowserTabState | null,
  vpn: BrowserVpnStatus,
  isFullscreen: boolean
): BrowserMenuItem[] {
  return [
    { kind: 'action', command: 'find', label: 'Find in page', icon: 'find', disabled: !activeTab },
    {
      kind: 'action',
      command: 'mute',
      label: activeTab?.isMuted ? 'Unmute tab' : 'Mute tab',
      icon: activeTab?.isMuted ? 'volume-muted' : 'volume',
      disabled: !activeTab || (!activeTab.isAudible && !activeTab.isMuted)
    },
    { kind: 'action', command: 'vpn', label: vpnMenuLabel(vpn), icon: 'shield', checked: vpn.state === 'on' },
    { kind: 'separator' },
    { kind: 'zoom', percent: activeTab?.zoomPercent ?? 100, disabled: !activeTab },
    { kind: 'separator' },
    {
      kind: 'action',
      command: 'fullscreen',
      label: isFullscreen ? 'Exit full screen' : 'Full screen',
      icon: isFullscreen ? 'fullscreen-exit' : 'fullscreen',
      checked: isFullscreen
    }
  ]
}

function BrowserToolbar({
  activeTab,
  vpn,
  isFullscreen,
  onToggleFullscreen
}: {
  activeTab: BrowserTabState | null
  vpn: BrowserVpnStatus
  isFullscreen: boolean
  onToggleFullscreen: () => void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [suggestions, setSuggestions] = useState<OmniboxSuggestion[]>([])
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [findResult, setFindResult] = useState({ activeMatchOrdinal: 0, matches: 0 })
  const [menuOpen, setMenuOpen] = useState(false)
  const findInputRef = useRef<HTMLInputElement>(null)
  const omniboxRef = useRef<HTMLInputElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const typedTextRef = useRef('')
  const focusingOmniboxFromPointerRef = useRef(false)
  const querySeqRef = useRef(0)
  const pendingInlineRef = useRef<{ start: number; end: number } | null>(null)

  useEffect(() => {
    if (!isEditing) setInput(activeTab?.url ?? '')
  }, [activeTab?.url, isEditing])

  useLayoutEffect(() => {
    const range = pendingInlineRef.current
    if (range && omniboxRef.current) omniboxRef.current.setSelectionRange(range.start, range.end)
    pendingInlineRef.current = null
  }, [input])

  useEffect(() => {
    setIsEditing(false)
    closePopup()
    void window.api.browser.menuClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id])
  useEffect(() => window.api.browser.onFindRequested(() => setFindOpen(true)), [])
  // The menu is a native overlay view; main owns its visibility (it also hides
  // it on window blur and after non-sticky commands). Mirror that state here.
  useEffect(() => window.api.browser.onMenuClosed(() => setMenuOpen(false)), [])
  // Live-refresh the open menu when the state it reflects changes (zoom
  // percent after a zoom command, mute/vpn/fullscreen toggles).
  useEffect(() => {
    if (menuOpen) void window.api.browser.menuUpdate(buildMenuItems(activeTab, vpn, isFullscreen))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    menuOpen,
    activeTab?.id,
    activeTab?.isMuted,
    activeTab?.isAudible,
    activeTab?.zoomPercent,
    vpn.state,
    vpn.bootstrapProgress,
    isFullscreen
  ])
  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void window.api.browser.menuClose()
      }
    }
    // Dismiss when clicking anywhere else in the chrome. Clicks on the page or
    // on the popup itself never reach this document — those are covered by the
    // window-blur fallback below and by main hiding after commands.
    const onPointerDown = (event: PointerEvent): void => {
      if (menuButtonRef.current?.contains(event.target as Node)) return
      void window.api.browser.menuClose()
    }
    // Clicking the page (a native view) moves focus out of this document
    // without any pointer event here. Close after a grace period — sticky menu
    // commands (zoom) refocus the chrome immediately, cancelling the timer.
    let blurTimer: number | null = null
    const onWindowBlur = (): void => {
      blurTimer = window.setTimeout(() => void window.api.browser.menuClose(), 160)
    }
    const onWindowFocus = (): void => {
      if (blurTimer !== null) {
        window.clearTimeout(blurTimer)
        blurTimer = null
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
      if (blurTimer !== null) window.clearTimeout(blurTimer)
    }
  }, [menuOpen])
  useEffect(() => window.api.browser.onFocusOmnibox(() => {
    const input = omniboxRef.current
    input?.focus()
    input?.select()
  }), [])
  useEffect(() => window.api.browser.onHistoryRemoved((url) => {
    setSuggestions((current) => current.filter(
      (suggestion) => suggestion.kind !== 'history' || suggestion.url !== url
    ))
    setSelectedIndex(-1)
    setInput(typedTextRef.current)
  }), [])
  // Guest pages forward F11 through the main process (focus lives in the
  // native view); this subscription handles it alongside chrome-focused F11.
  useEffect(
    () => window.api.browser.onFullscreenToggleRequested(onToggleFullscreen),
    [onToggleFullscreen]
  )
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); setFindOpen(true) }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        omniboxRef.current?.focus()
        omniboxRef.current?.select()
      }
      if (event.key === 'F11') { event.preventDefault(); onToggleFullscreen() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onToggleFullscreen])
  useEffect(() => {
    const onResize = (): void => {
      if (document.activeElement === omniboxRef.current) omniboxRef.current?.blur()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    if (findOpen) requestAnimationFrame(() => findInputRef.current?.focus())
  }, [findOpen])

  const measureAnchor = (): OmniboxAnchor | null => {
    const rect = omniboxRef.current?.getBoundingClientRect()
    return rect ? { x: rect.left - 2, y: rect.bottom + 4, width: rect.width + 4 } : null
  }
  const runQuery = (text: string, allowInline = false): void => {
    const anchor = measureAnchor()
    if (!anchor) return
    const seq = ++querySeqRef.current
    void window.api.browser.omniboxQuery(text, anchor).then((result) => {
      if (seq !== querySeqRef.current) return
      setSuggestions(result.suggestions)
      setSelectedIndex(-1)
      if (allowInline && result.inline && text === typedTextRef.current && result.inline.length > text.length && result.inline.toLowerCase().startsWith(text.toLowerCase())) {
        pendingInlineRef.current = { start: text.length, end: result.inline.length }
        setInput(result.inline)
      }
    })
  }
  const closePopup = (): void => {
    querySeqRef.current += 1
    setSuggestions([])
    setSelectedIndex(-1)
    void window.api.browser.omniboxClose()
  }
  const moveSelection = (delta: 1 | -1): void => {
    if (!suggestions.length) return
    let next = selectedIndex + delta
    if (next >= suggestions.length) next = -1
    if (next < -1) next = suggestions.length - 1
    setSelectedIndex(next)
    void window.api.browser.omniboxSelect(next)
    setInput(next === -1 ? typedTextRef.current : suggestions[next].kind === 'search' ? suggestions[next].text : suggestions[next].url)
  }
  const handleOmniboxKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(event.key === 'ArrowDown' ? 1 : -1); return }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (suggestions.length) { closePopup(); setInput(typedTextRef.current) }
      else { setInput(activeTab?.url ?? ''); omniboxRef.current?.blur() }
    }
  }
  const runFind = async (forward: boolean): Promise<void> => {
    if (activeTab && findText) setFindResult(await window.api.browser.find(activeTab.id, findText, forward))
  }
  const closeFind = (): void => {
    if (activeTab) void window.api.browser.stopFind(activeTab.id, 'clearSelection')
    setFindOpen(false)
    setFindResult({ activeMatchOrdinal: 0, matches: 0 })
  }
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const selected = selectedIndex >= 0 ? suggestions[selectedIndex] : null
    const target = selected ? selected.url : input
    if (activeTab && target.trim()) void window.api.browser.navigate(activeTab.id, target)
    closePopup()
    omniboxRef.current?.blur()
  }

  // Only read as identity when the field is idle; while editing, show raw text.
  const identity = isEditing ? null : omniboxIdentity(activeTab?.url ?? '')

  return (
    <form className={`browser-toolbar ${findOpen ? 'has-find' : ''}`} onSubmit={handleSubmit}>
      <button type="button" className="browser-nav-button" aria-label="Back" disabled={!activeTab?.canGoBack} onClick={() => activeTab && void window.api.browser.back(activeTab.id)}><ChevronIcon direction="left" /></button>
      <button type="button" className="browser-nav-button" aria-label="Forward" disabled={!activeTab?.canGoForward} onClick={() => activeTab && void window.api.browser.forward(activeTab.id)}><ChevronIcon direction="right" /></button>
      <button type="button" className="browser-nav-button" aria-label="Reload" disabled={!activeTab} onClick={() => activeTab && void window.api.browser.reload(activeTab.id)}><ReloadIcon /></button>
      <div className="omnibox-field">
        <input
          ref={omniboxRef}
          className="omnibox"
          value={input}
          spellCheck={false}
          autoComplete="off"
          aria-label="Address"
          onFocus={(event) => {
            const input = event.currentTarget
            setIsEditing(true)
            typedTextRef.current = input.value
            if (!focusingOmniboxFromPointerRef.current) input.select()
            // Let the focus gesture finish before a native suggestion surface
            // is raised above the page.
            window.requestAnimationFrame(() => {
              if (document.activeElement === input) runQuery('')
            })
          }}
          onMouseDown={(event) => {
            // Claim the first pointer focus synchronously. Waiting for mouseup
            // is fragile because a native WebContentsView can consume it.
            if (document.activeElement === event.currentTarget) return
            event.preventDefault()
            focusingOmniboxFromPointerRef.current = true
            try {
              event.currentTarget.focus()
              event.currentTarget.select()
            } finally {
              focusingOmniboxFromPointerRef.current = false
            }
          }}
          onBlur={() => { setIsEditing(false); closePopup() }}
          onChange={(event) => {
            const text = event.target.value
            setInput(text)
            typedTextRef.current = text
            runQuery(text, ((event.nativeEvent as InputEvent).inputType ?? '').startsWith('insert'))
          }}
          onKeyDown={handleOmniboxKeyDown}
        />
        {/* Opaque, click-through overlay: hides the raw URL while unfocused and
            shows a legible identity. pointer-events:none → a click still lands
            on the input beneath, focuses it, and this unmounts. */}
        {identity ? (
          <div className="omnibox-identity" aria-hidden="true">
            {identity.kind === 'web' ? (
              identity.secure ? (
                <LockIcon />
              ) : (
                <span className="oi-insecure">Not secure</span>
              )
            ) : null}
            <span className="oi-host">{identity.host}</span>
            {identity.rest ? <span className="oi-rest">{identity.rest}</span> : null}
          </div>
        ) : null}
      </div>
      <button
        ref={menuButtonRef}
        type="button"
        className={`browser-nav-button browser-menu-button ${menuOpen ? 'is-active' : ''}`}
        data-vpn={vpn.state}
        aria-label="Browser menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Browser menu"
        onClick={() => {
          if (menuOpen) {
            void window.api.browser.menuClose()
            return
          }
          const rect = menuButtonRef.current?.getBoundingClientRect()
          if (!rect) return
          setMenuOpen(true)
          void window.api.browser.menuOpen({ x: rect.right + 2, y: rect.bottom + 4 }, buildMenuItems(activeTab, vpn, isFullscreen))
        }}
      ><KebabIcon /></button>
      {findOpen ? (
        <div className="browser-find" role="search">
          <input ref={findInputRef} value={findText} placeholder="Find in page" aria-label="Find in page" onChange={(event) => { setFindText(event.target.value); if (event.target.value && activeTab) void window.api.browser.find(activeTab.id, event.target.value, true).then(setFindResult) }} onKeyDown={(event) => { if (event.key === 'Escape') closeFind(); if (event.key === 'Enter') { event.preventDefault(); void runFind(!event.shiftKey) } }} />
          <span aria-live="polite">{findText ? `${findResult.activeMatchOrdinal}/${findResult.matches}` : '0/0'}</span>
          <button type="button" aria-label="Previous match" onClick={() => void runFind(false)}><ChevronIcon direction="up" /></button>
          <button type="button" aria-label="Next match" onClick={() => void runFind(true)}><ChevronIcon direction="down" /></button>
          <button type="button" aria-label="Close find" onClick={closeFind}><CloseIcon /></button>
        </div>
      ) : null}
    </form>
  )
}

function ChevronIcon({ direction }: { direction: 'up' | 'down' | 'left' | 'right' }): React.JSX.Element {
  const paths = {
    up: 'm6 14 6-6 6 6',
    down: 'm6 10 6 6 6-6',
    left: 'm14 6-6 6 6 6',
    right: 'm10 6 6 6-6 6'
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={paths[direction]} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ReloadIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M19.2 8.8A7.7 7.7 0 1 0 20 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M19.2 4.8v4h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function KebabIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="5.6" r="1.55" fill="currentColor" />
      <circle cx="12" cy="12" r="1.55" fill="currentColor" />
      <circle cx="12" cy="18.4" r="1.55" fill="currentColor" />
    </svg>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5.5v13M5.5 12h13" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  )
}

function LockIcon(): React.JSX.Element {
  return (
    <svg className="oi-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8 10.5V7.9a4 4 0 0 1 8 0v2.6" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  )
}
