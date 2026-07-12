import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import type {
  BrowserBounds,
  BrowserState,
  BrowserTabState,
  OmniboxAnchor,
  OmniboxSuggestion
} from '../../shared/ipc'

export function BrowserPane({
  state,
  activeTab,
  viewHostRef,
  viewBounds
}: {
  state: BrowserState
  activeTab: BrowserTabState | null
  viewHostRef: RefObject<HTMLDivElement | null>
  viewBounds: BrowserBounds | null
}): React.JSX.Element {
  return (
    <section className="browser-pane">
      <div className="browser-shell">
        <TabStrip state={state} />
        <BrowserToolbar activeTab={activeTab} />
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
            ×
          </span>
        </button>
      ))}
      <button type="button" className="new-tab-button" aria-label="New tab" onClick={() => void window.api.browser.newTab()}>+</button>
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

function BrowserToolbar({ activeTab }: { activeTab: BrowserTabState | null }): React.JSX.Element {
  const [input, setInput] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [suggestions, setSuggestions] = useState<OmniboxSuggestion[]>([])
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [findResult, setFindResult] = useState({ activeMatchOrdinal: 0, matches: 0 })
  const findInputRef = useRef<HTMLInputElement>(null)
  const omniboxRef = useRef<HTMLInputElement>(null)
  const typedTextRef = useRef('')
  const justFocusedRef = useRef(false)
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); setFindOpen(true) }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); omniboxRef.current?.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
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
      <button type="button" className="browser-nav-button" aria-label="Back" disabled={!activeTab?.canGoBack} onClick={() => activeTab && void window.api.browser.back(activeTab.id)}>‹</button>
      <button type="button" className="browser-nav-button" aria-label="Forward" disabled={!activeTab?.canGoForward} onClick={() => activeTab && void window.api.browser.forward(activeTab.id)}>›</button>
      <button type="button" className="browser-nav-button" aria-label="Reload" disabled={!activeTab} onClick={() => activeTab && void window.api.browser.reload(activeTab.id)}>↻</button>
      <input
        ref={omniboxRef}
        className="omnibox"
        value={input}
        spellCheck={false}
        autoComplete="off"
        aria-label="Address"
        onFocus={(event) => { setIsEditing(true); typedTextRef.current = event.target.value; justFocusedRef.current = true; event.target.select(); runQuery('') }}
        onMouseUp={(event) => { if (justFocusedRef.current) { event.preventDefault(); justFocusedRef.current = false } }}
        onBlur={() => { setIsEditing(false); closePopup() }}
        onChange={(event) => {
          const text = event.target.value
          setInput(text)
          typedTextRef.current = text
          runQuery(text, ((event.nativeEvent as InputEvent).inputType ?? '').startsWith('insert'))
        }}
        onKeyDown={handleOmniboxKeyDown}
      />
      <button type="button" className="browser-nav-button" aria-label="Find in page" title="Find in page" onClick={() => setFindOpen(true)}>⌕</button>
      <button type="button" className={`browser-nav-button ${activeTab?.isMuted ? 'is-active' : ''}`} aria-label={activeTab?.isMuted ? 'Unmute tab' : 'Mute tab'} title={activeTab?.isMuted ? 'Unmute tab' : 'Mute tab'} disabled={!activeTab || (!activeTab.isAudible && !activeTab.isMuted)} onClick={() => activeTab && void window.api.browser.toggleMute(activeTab.id)}>{activeTab?.isMuted ? '⊘' : '♪'}</button>
      <div className="browser-zoom" aria-label="Page zoom">
        <button type="button" aria-label="Zoom out" onClick={() => activeTab && void window.api.browser.zoom(activeTab.id, 'out')}>−</button>
        <button type="button" className="zoom-value" aria-label="Reset zoom" onClick={() => activeTab && void window.api.browser.zoom(activeTab.id, 'reset')}>{activeTab?.zoomPercent ?? 100}%</button>
        <button type="button" aria-label="Zoom in" onClick={() => activeTab && void window.api.browser.zoom(activeTab.id, 'in')}>+</button>
      </div>
      {findOpen ? (
        <div className="browser-find" role="search">
          <input ref={findInputRef} value={findText} placeholder="Find in page" aria-label="Find in page" onChange={(event) => { setFindText(event.target.value); if (event.target.value && activeTab) void window.api.browser.find(activeTab.id, event.target.value, true).then(setFindResult) }} onKeyDown={(event) => { if (event.key === 'Escape') closeFind(); if (event.key === 'Enter') { event.preventDefault(); void runFind(!event.shiftKey) } }} />
          <span aria-live="polite">{findText ? `${findResult.activeMatchOrdinal}/${findResult.matches}` : '0/0'}</span>
          <button type="button" aria-label="Previous match" onClick={() => void runFind(false)}>↑</button>
          <button type="button" aria-label="Next match" onClick={() => void runFind(true)}>↓</button>
          <button type="button" aria-label="Close find" onClick={closeFind}>×</button>
        </div>
      ) : null}
    </form>
  )
}
