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
    <div className="tab-strip">
      {state.tabs.map((tab) => (
        <button type="button" key={tab.id} className={`tab ${tab.id === state.activeTabId ? 'is-active' : ''}`} onClick={() => void window.api.browser.activateTab(tab.id)}>
          <TabFavicon favicon={tab.favicon} isLoading={tab.isLoading} />
          <span className="tab-title">{tab.title || 'New Tab'}</span>
          <span
            role="button"
            tabIndex={0}
            className="tab-close"
            aria-label={`Close ${tab.title || 'tab'}`}
            onClick={(event) => { event.stopPropagation(); void window.api.browser.closeTab(tab.id) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation()
                void window.api.browser.closeTab(tab.id)
              }
            }}
          >
            <CloseIcon />
          </span>
        </button>
      ))}
      <button type="button" className="new-tab-button" aria-label="New tab" onClick={() => void window.api.browser.newTab()}><PlusIcon /></button>
    </div>
  )
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
  const justFocusedRef = useRef(false)
  const focusFromMouseRef = useRef(false)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id])
  useEffect(() => window.api.browser.onFindRequested(() => setFindOpen(true)), [])
  useEffect(() => window.api.browser.onFocusOmnibox(() => omniboxRef.current?.focus()), [])
  // Guest pages forward F11 through the main process (focus lives in the
  // native view); this subscription handles it alongside chrome-focused F11.
  useEffect(
    () => window.api.browser.onFullscreenToggleRequested(onToggleFullscreen),
    [onToggleFullscreen]
  )
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); setFindOpen(true) }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); omniboxRef.current?.focus() }
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

  return (
    <form className={`browser-toolbar ${findOpen ? 'has-find' : ''}`} onSubmit={handleSubmit}>
      <button type="button" className="browser-nav-button" aria-label="Back" disabled={!activeTab?.canGoBack} onClick={() => activeTab && void window.api.browser.back(activeTab.id)}><ChevronIcon direction="left" /></button>
      <button type="button" className="browser-nav-button" aria-label="Forward" disabled={!activeTab?.canGoForward} onClick={() => activeTab && void window.api.browser.forward(activeTab.id)}><ChevronIcon direction="right" /></button>
      <button type="button" className="browser-nav-button" aria-label="Reload" disabled={!activeTab} onClick={() => activeTab && void window.api.browser.reload(activeTab.id)}><ReloadIcon /></button>
      <input
        ref={omniboxRef}
        className="omnibox"
        value={input}
        spellCheck={false}
        autoComplete="off"
        aria-label="Address"
        onFocus={(event) => { setIsEditing(true); typedTextRef.current = event.target.value; if (!focusFromMouseRef.current) event.target.select(); runQuery('') }}
        onMouseDown={(event) => { justFocusedRef.current = document.activeElement !== event.currentTarget; focusFromMouseRef.current = true }}
        onMouseUp={(event) => {
          focusFromMouseRef.current = false
          // First click focuses the field: select the whole URL so a keystroke
          // replaces it. Any later click (already focused) leaves the caret the
          // browser just placed, so you can edit character-by-character.
          if (justFocusedRef.current) { justFocusedRef.current = false; event.currentTarget.select() }
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
      <button type="button" className="browser-nav-button" aria-label="Find in page" title="Find in page" onClick={() => setFindOpen(true)}><SearchIcon /></button>
      <button type="button" className={`browser-nav-button ${activeTab?.isMuted ? 'is-active' : ''}`} aria-label={activeTab?.isMuted ? 'Unmute tab' : 'Mute tab'} title={activeTab?.isMuted ? 'Unmute tab' : 'Mute tab'} disabled={!activeTab || (!activeTab.isAudible && !activeTab.isMuted)} onClick={() => activeTab && void window.api.browser.toggleMute(activeTab.id)}><VolumeIcon muted={Boolean(activeTab?.isMuted)} /></button>
      <button
        type="button"
        className={`browser-nav-button vpn-toggle ${vpn.state === 'on' ? 'is-active' : ''} ${vpn.state === 'starting' ? 'is-connecting' : ''} ${vpn.state === 'error' ? 'is-error' : ''}`}
        aria-label={vpn.state === 'on' || vpn.state === 'starting' ? 'Disable VPN' : 'Enable VPN'}
        aria-pressed={vpn.state === 'on'}
        title={vpnLabel(vpn)}
        onClick={() => void window.api.browser.toggleVpn()}
      ><ShieldIcon active={vpn.state === 'on'} /></button>
      <div className="browser-zoom" aria-label="Page zoom">
        <button type="button" aria-label="Zoom out" onClick={() => activeTab && void window.api.browser.zoom(activeTab.id, 'out')}><MinusIcon /></button>
        <button type="button" className="zoom-value" aria-label="Reset zoom" onClick={() => activeTab && void window.api.browser.zoom(activeTab.id, 'reset')}>{activeTab?.zoomPercent ?? 100}%</button>
        <button type="button" aria-label="Zoom in" onClick={() => activeTab && void window.api.browser.zoom(activeTab.id, 'in')}><PlusIcon /></button>
      </div>
      <button
        type="button"
        className={`browser-nav-button ${isFullscreen ? 'is-active' : ''}`}
        aria-label={isFullscreen ? 'Exit full screen browser' : 'Full screen browser'}
        aria-pressed={isFullscreen}
        title={isFullscreen ? 'Exit full screen browser (F11)' : 'Full screen browser (F11)'}
        onClick={onToggleFullscreen}
      ><FullscreenIcon active={isFullscreen} /></button>
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

function SearchIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="10.8" cy="10.8" r="5.8" stroke="currentColor" strokeWidth="1.8" />
      <path d="m15.2 15.2 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function VolumeIcon({ muted }: { muted: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 10h3.2L12 6.5v11l-4.3-3.5H4.5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      {muted ? (
        <path d="m15.5 10.2 4 4m0-4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      ) : (
        <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.7a7.4 7.4 0 0 1 0 10.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      )}
    </svg>
  )
}

function FullscreenIcon({ active }: { active: boolean }): React.JSX.Element {
  return active ? (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9.5 5v4.5H5M14.5 5v4.5H19M9.5 19v-4.5H5M14.5 19v-4.5H19" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 9.5V5h4.5M19 9.5V5h-4.5M5 14.5V19h4.5M19 14.5V19h-4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ShieldIcon({ active }: { active: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.4 5.6 5.9v5.4c0 4 2.6 6.9 6.4 8.7 3.8-1.8 6.4-4.7 6.4-8.7V5.9L12 3.4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      {active ? (
        <path d="m9.2 11.9 2 2 3.7-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
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

function MinusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5.5 12h13" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
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
