import { FormEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { BrowserBounds, BrowserState, BrowserTabState, CodexEvent } from '../../shared/ipc'
import type { ServerNotification } from '../../shared/codex-protocol/ServerNotification'
import type { Thread } from '../../shared/codex-protocol/v2/Thread'
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem'

type SystemItem = {
  type: 'system'
  id: string
  level: 'info' | 'warning' | 'error'
  text: string
}

type ChatItem = ThreadItem | SystemItem

const minChatWidth = 280
const minBrowserWidth = 420
const dividerWidth = 8

export default function App(): JSX.Element {
  const [split, setSplit] = useState(() => {
    const stored = Number(window.localStorage.getItem('codexdesktop.split'))
    return Number.isFinite(stored) && stored > 20 && stored < 70 ? stored : 37
  })
  const [items, setItems] = useState<ChatItem[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [activeThreadTitle, setActiveThreadTitle] = useState('New Chat')
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [codexStatus, setCodexStatus] = useState('idle')
  const [threads, setThreads] = useState<Thread[]>([])
  const [isThreadMenuOpen, setIsThreadMenuOpen] = useState(false)
  const [browserState, setBrowserState] = useState<BrowserState>({ tabs: [], activeTabId: null })
  const [viewBounds, setViewBounds] = useState<BrowserBounds | null>(null)
  const appRef = useRef<HTMLDivElement | null>(null)
  const viewHostRef = useRef<HTMLDivElement | null>(null)
  const pendingBoundsRef = useRef<BrowserBounds | null>(null)
  const rafRef = useRef<number | null>(null)
  const isDraggingDividerRef = useRef(false)
  const splitRef = useRef(split)
  const activeThreadIdRef = useRef<string | null>(activeThreadId)

  useEffect(() => window.api.browser.onState(setBrowserState), [])

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId
  }, [activeThreadId])

  useEffect(() => {
    splitRef.current = split
  }, [split])

  useEffect(() => {
    const dispose = window.api.codex.onEvent((event) => {
      if (event.type === 'status') {
        setCodexStatus(event.status)

        if (event.status === 'exited' || event.status === 'error') {
          addSystemItem(event.message ?? 'Codex app-server is not available.', event.status === 'error' ? 'error' : 'warning')
        }

        return
      }

      handleCodexNotification(event.notification as ServerNotification)
    })

    void window.api.codex.getAuthStatus().catch((error: Error) => {
      addSystemItem(`Codex auth check failed: ${error.message}`, 'error')
    })
    void refreshThreads()

    return dispose
  }, [])

  const measureBrowserBounds = useCallback((): BrowserBounds | null => {
    const host = viewHostRef.current

    if (!host) {
      return null
    }

    const rect = host.getBoundingClientRect()

    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    }
  }, [])

  const updateBrowserBounds = useCallback((sendFinal = false) => {
    const bounds = measureBrowserBounds()

    if (!bounds) {
      return
    }

    setViewBounds(bounds)
    pendingBoundsRef.current = bounds

    if (sendFinal) {
      void window.api.browser.setBounds(bounds)
      return
    }

    if (rafRef.current !== null) {
      return
    }

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null

      if (!isDraggingDividerRef.current && pendingBoundsRef.current) {
        void window.api.browser.setBounds(pendingBoundsRef.current)
      }
    })
  }, [measureBrowserBounds])

  useEffect(() => {
    updateBrowserBounds(true)
  }, [split, updateBrowserBounds])

  useEffect(() => {
    const host = viewHostRef.current

    if (!host) {
      return
    }

    const observer = new ResizeObserver(() => updateBrowserBounds())
    const handleResize = (): void => updateBrowserBounds()

    observer.observe(host)
    window.addEventListener('resize', handleResize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [updateBrowserBounds])

  const activeTab = useMemo(
    () => browserState.tabs.find((tab) => tab.id === browserState.activeTabId) ?? null,
    [browserState]
  )

  const handleDividerPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const app = appRef.current

    if (!app) {
      return
    }

    isDraggingDividerRef.current = true
    void window.api.browser.beginDividerDrag()
    event.currentTarget.setPointerCapture(event.pointerId)

    const appRect = app.getBoundingClientRect()

    const handleMove = (moveEvent: globalThis.PointerEvent): void => {
      const rawChatWidth = moveEvent.clientX - appRect.left
      const maxChatWidth = appRect.width - minBrowserWidth - dividerWidth
      const clamped = Math.min(Math.max(rawChatWidth, minChatWidth), maxChatWidth)
      const nextSplit = (clamped / appRect.width) * 100
      splitRef.current = nextSplit
      setSplit(nextSplit)
    }

    const handleUp = (): void => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.localStorage.setItem('codexdesktop.split', String(splitRef.current))
      isDraggingDividerRef.current = false
      const latestBounds = measureBrowserBounds() ?? pendingBoundsRef.current

      if (latestBounds) {
        void window.api.browser.endDividerDrag(latestBounds)
      }
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp, { once: true })
  }

  const handleSend = async (text: string): Promise<void> => {
    const trimmed = text.trim()

    if (!trimmed || isSending || activeTurnId) {
      return
    }

    setIsSending(true)

    try {
      const response = await window.api.codex.sendMessage({
        threadId: activeThreadId,
        text: trimmed
      })
      setActiveThreadId(response.threadId)
      setActiveTurnId(response.turn.id)
      mergeItems(response.turn.items)
    } catch (error) {
      addSystemItem(`Codex turn failed to start: ${(error as Error).message}`, 'error')
    } finally {
      setIsSending(false)
    }
  }

  const handleStop = async (): Promise<void> => {
    if (!activeThreadId || !activeTurnId) {
      return
    }

    try {
      await window.api.codex.interruptTurn({ threadId: activeThreadId, turnId: activeTurnId })
    } catch (error) {
      addSystemItem(`Stop failed: ${(error as Error).message}`, 'error')
    }
  }

  const handleNewThread = (): void => {
    setIsThreadMenuOpen(false)
    setActiveThreadId(null)
    setActiveThreadTitle('New Chat')
    setActiveTurnId(null)
    setItems([])
  }

  const handleResumeThread = async (threadId: string): Promise<void> => {
    setIsThreadMenuOpen(false)

    try {
      const resumed = await window.api.codex.resumeThread(threadId)
      hydrateThread(resumed.thread)
      const read = await window.api.codex.readThread(threadId)
      hydrateThread(read.thread)
    } catch (error) {
      addSystemItem(`Thread resume failed: ${(error as Error).message}`, 'error')
    }
  }

  const hasThreadContent = items.length > 0

  function handleCodexNotification(notification: ServerNotification): void {
    const currentThreadId = activeThreadIdRef.current

    switch (notification.method) {
      case 'thread/started':
        setActiveThreadId(notification.params.thread.id)
        setActiveThreadTitle(threadTitle(notification.params.thread))
        return
      case 'thread/name/updated':
        if (notification.params.threadId === currentThreadId) {
          setActiveThreadTitle(notification.params.threadName || 'New Chat')
        }
        void refreshThreads()
        return
      case 'turn/started':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          setActiveThreadId(notification.params.threadId)
          setActiveTurnId(notification.params.turn.id)
          mergeItems(notification.params.turn.items)
        }
        return
      case 'turn/completed':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          mergeItems(notification.params.turn.items)
          setActiveTurnId(null)
        }
        void refreshThreads()
        return
      case 'item/started':
      case 'item/completed':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          upsertItem(notification.params.item)
        }
        return
      case 'item/agentMessage/delta':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          patchItemText(notification.params.itemId, notification.params.delta, 'agentMessage')
        }
        return
      case 'item/commandExecution/outputDelta':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          patchCommandOutput(notification.params.itemId, notification.params.delta)
        }
        return
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          patchReasoning(notification.params.itemId, notification.params.delta)
        }
        return
      case 'error':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          addSystemItem(notification.params.error.message, 'error')
          setActiveTurnId(null)
        }
        return
      case 'warning':
        if (!notification.params.threadId || isRelevantThread(notification.params.threadId, currentThreadId)) {
          addSystemItem(notification.params.message, 'warning')
        }
        return
      default:
        return
    }
  }

  function mergeItems(nextItems: ThreadItem[]): void {
    setItems((current) => upsertMany(current, nextItems))
  }

  async function refreshThreads(): Promise<void> {
    try {
      const response = await window.api.codex.listThreads()
      setThreads(response.data)
    } catch {
      // A failed history refresh should not block the active conversation.
    }
  }

  function hydrateThread(thread: Thread): void {
    setActiveThreadId(thread.id)
    setActiveThreadTitle(threadTitle(thread))
    setActiveTurnId(thread.turns.find((turn) => turn.status === 'inProgress')?.id ?? null)
    setItems(thread.turns.flatMap((turn) => turn.items))
  }

  function upsertItem(item: ThreadItem): void {
    setItems((current) => upsertMany(current, [item]))
  }

  function patchItemText(itemId: string, delta: string, fallbackType: 'agentMessage'): void {
    setItems((current) => {
      const index = current.findIndex((item) => item.id === itemId)

      if (index === -1) {
        return [...current, { type: fallbackType, id: itemId, text: delta, phase: null, memoryCitation: null }]
      }

      return current.map((item) => {
        if (item.id !== itemId || item.type !== 'agentMessage') {
          return item
        }

        return { ...item, text: `${item.text}${delta}` }
      })
    })
  }

  function patchCommandOutput(itemId: string, delta: string): void {
    setItems((current) =>
      current.map((item) => {
        if (item.id !== itemId || item.type !== 'commandExecution') {
          return item
        }

        return {
          ...item,
          aggregatedOutput: `${item.aggregatedOutput ?? ''}${delta}`
        }
      })
    )
  }

  function patchReasoning(itemId: string, delta: string): void {
    setItems((current) => {
      const index = current.findIndex((item) => item.id === itemId)

      if (index === -1) {
        return [...current, { type: 'reasoning', id: itemId, summary: [delta], content: [] }]
      }

      return current.map((item) => {
        if (item.id !== itemId || item.type !== 'reasoning') {
          return item
        }

        const summary = item.summary.length ? [...item.summary] : ['']
        summary[summary.length - 1] = `${summary[summary.length - 1]}${delta}`
        return { ...item, summary }
      })
    })
  }

  function addSystemItem(text: string, level: SystemItem['level'] = 'info'): void {
    setItems((current) => [...current, { type: 'system', id: crypto.randomUUID(), level, text }])
  }

  return (
    <div ref={appRef} className="app-shell">
      <TitleBar />
      <main className="workspace" style={{ gridTemplateColumns: `${split}% ${dividerWidth}px 1fr` }}>
        <ChatPane
          items={items}
          title={activeThreadTitle}
          status={codexStatus}
          threads={threads}
          activeThreadId={activeThreadId}
          isThreadMenuOpen={isThreadMenuOpen}
          hasThreadContent={hasThreadContent}
          isBusy={isSending || Boolean(activeTurnId)}
          onSend={handleSend}
          onStop={handleStop}
          onNewThread={handleNewThread}
          onToggleThreadMenu={() => setIsThreadMenuOpen((open) => !open)}
          onResumeThread={handleResumeThread}
        />
        <div className="split-divider" onPointerDown={handleDividerPointerDown} />
        <BrowserPane
          state={browserState}
          activeTab={activeTab}
          viewHostRef={viewHostRef}
          viewBounds={viewBounds}
        />
      </main>
    </div>
  )
}

function TitleBar(): JSX.Element {
  return (
    <header className="titlebar">
      <div className="titlebar-title">Chat</div>
      <div className="window-controls">
        <button type="button" aria-label="Minimize" onClick={() => void window.api.window.minimize()}>
          -
        </button>
        <button type="button" aria-label="Maximize" onClick={() => void window.api.window.toggleMaximize()}>
          □
        </button>
        <button type="button" aria-label="Close" onClick={() => void window.api.window.close()}>
          ×
        </button>
      </div>
    </header>
  )
}

function ChatPane({
  items,
  title,
  status,
  threads,
  activeThreadId,
  isThreadMenuOpen,
  hasThreadContent,
  isBusy,
  onSend,
  onStop,
  onNewThread,
  onToggleThreadMenu,
  onResumeThread
}: {
  items: ChatItem[]
  title: string
  status: string
  threads: Thread[]
  activeThreadId: string | null
  isThreadMenuOpen: boolean
  hasThreadContent: boolean
  isBusy: boolean
  onSend: (text: string) => Promise<void>
  onStop: () => Promise<void>
  onNewThread: () => void
  onToggleThreadMenu: () => void
  onResumeThread: (threadId: string) => Promise<void>
}): JSX.Element {
  return (
    <section className={`chat-pane ${hasThreadContent ? 'is-thread' : 'is-empty'}`}>
      <div className="chat-toolbar">
        <button type="button" className="icon-button" aria-label="Toggle sidebar">
          <span className="icon-sidebar" />
        </button>
        <button type="button" className="thread-select" aria-label="Open thread menu" onClick={onToggleThreadMenu}>
          <span className="spin-arrow">↻</span>
          <span className="thread-title">{title}</span>
          <span className="chevron">⌄</span>
        </button>
        {isThreadMenuOpen ? (
          <div className="thread-menu">
            <button type="button" className="thread-menu-item new-thread-item" onClick={onNewThread}>
              New Chat
            </button>
            {threads.slice(0, 12).map((thread) => (
              <button
                type="button"
                key={thread.id}
                className={`thread-menu-item ${thread.id === activeThreadId ? 'is-active' : ''}`}
                onClick={() => void onResumeThread(thread.id)}
              >
                <span>{threadTitle(thread)}</span>
                <time>{formatThreadTime(thread.recencyAt ?? thread.updatedAt)}</time>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="thread-scroll">
        {items.map((item) => (
          <ChatItemView key={item.id} item={item} />
        ))}
      </div>

      <Composer docked={hasThreadContent} isBusy={isBusy} status={status} onSend={onSend} onStop={onStop} />
    </section>
  )
}

function ChatItemView({ item }: { item: ChatItem }): JSX.Element {
  if (item.type === 'system') {
    return <article className={`message message-system message-system-${item.level}`}>{item.text}</article>
  }

  if (item.type === 'userMessage') {
    return (
      <article className="message message-user">
        <p>{item.content.map((content) => (content.type === 'text' ? content.text : `[${content.type}]`)).join('\n')}</p>
      </article>
    )
  }

  if (item.type === 'agentMessage') {
    return (
      <article className="message message-assistant">
        <ReactMarkdown>{item.text || ' '}</ReactMarkdown>
      </article>
    )
  }

  if (item.type === 'reasoning') {
    const text = [...item.summary, ...item.content].filter(Boolean).join('\n\n')

    return (
      <details className="message message-reasoning">
        <summary>Reasoning</summary>
        <p>{text || 'Thinking...'}</p>
      </details>
    )
  }

  if (item.type === 'commandExecution') {
    return (
      <article className="message message-command">
        <div className="command-header">
          <span>$</span>
          <code>{item.command}</code>
          <span className={`status-pill status-${item.status}`}>{item.status}</span>
        </div>
        {item.aggregatedOutput ? <pre>{tailLines(item.aggregatedOutput, 140)}</pre> : null}
      </article>
    )
  }

  if (item.type === 'fileChange') {
    return (
      <article className="message message-tool">
        <strong>File change</strong>
        <span className={`status-pill status-${item.status}`}>{item.status}</span>
      </article>
    )
  }

  return (
    <article className="message message-tool">
      <strong>{item.type}</strong>
    </article>
  )
}

function Composer({
  docked,
  isBusy,
  status,
  onSend,
  onStop
}: {
  docked: boolean
  isBusy: boolean
  status: string
  onSend: (text: string) => Promise<void>
  onStop: () => Promise<void>
}): JSX.Element {
  const [value, setValue] = useState('')

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    if (isBusy) {
      void onStop()
      return
    }

    const text = value
    setValue('')
    void onSend(text)
  }

  return (
    <form className={`composer ${docked ? 'is-docked' : 'is-centered'}`} onSubmit={handleSubmit}>
      <textarea
        value={value}
        rows={3}
        placeholder={docked ? 'Reply...' : 'Plan, Build, / for commands, @ for context'}
        disabled={isBusy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <div className="composer-footer">
        <span className="composer-status">{status}</span>
        <button type="submit" className="send-button" aria-label={isBusy ? 'Stop turn' : 'Send message'} disabled={!isBusy && !value.trim()}>
          {isBusy ? '■' : '↑'}
        </button>
      </div>
    </form>
  )
}

function BrowserPane({
  state,
  activeTab,
  viewHostRef,
  viewBounds
}: {
  state: BrowserState
  activeTab: BrowserTabState | null
  viewHostRef: React.RefObject<HTMLDivElement | null>
  viewBounds: BrowserBounds | null
}): JSX.Element {
  return (
    <section className="browser-pane">
      <TabStrip state={state} />
      <BrowserToolbar activeTab={activeTab} />
      <div className="browser-frame">
        <div ref={viewHostRef} className="browser-view-host" data-ready={viewBounds ? 'true' : 'false'} />
      </div>
    </section>
  )
}

function TabStrip({ state }: { state: BrowserState }): JSX.Element {
  return (
    <div className="tab-strip">
      {state.tabs.map((tab) => (
        <button
          type="button"
          key={tab.id}
          className={`tab ${tab.id === state.activeTabId ? 'is-active' : ''}`}
          onClick={() => void window.api.browser.activateTab(tab.id)}
        >
          <span className="tab-dot">●</span>
          <span className="tab-title">{tab.title || 'New Tab'}</span>
          <span
            role="button"
            tabIndex={0}
            className="tab-close"
            aria-label={`Close ${tab.title || 'tab'}`}
            onClick={(event) => {
              event.stopPropagation()
              void window.api.browser.closeTab(tab.id)
            }}
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
      <button type="button" className="new-tab-button" aria-label="New tab" onClick={() => void window.api.browser.newTab()}>
        +
      </button>
    </div>
  )
}

function BrowserToolbar({ activeTab }: { activeTab: BrowserTabState | null }): JSX.Element {
  const [input, setInput] = useState('')

  useEffect(() => {
    setInput(activeTab?.url ?? '')
  }, [activeTab?.url])

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    if (activeTab) {
      void window.api.browser.navigate(activeTab.id, input)
    }
  }

  return (
    <form className="browser-toolbar" onSubmit={handleSubmit}>
      <button
        type="button"
        className="browser-nav-button"
        aria-label="Back"
        disabled={!activeTab?.canGoBack}
        onClick={() => activeTab && void window.api.browser.back(activeTab.id)}
      >
        ‹
      </button>
      <button
        type="button"
        className="browser-nav-button"
        aria-label="Forward"
        disabled={!activeTab?.canGoForward}
        onClick={() => activeTab && void window.api.browser.forward(activeTab.id)}
      >
        ›
      </button>
      <button
        type="button"
        className="browser-nav-button"
        aria-label="Reload"
        disabled={!activeTab}
        onClick={() => activeTab && void window.api.browser.reload(activeTab.id)}
      >
        ↻
      </button>
      <input
        className="omnibox"
        value={input}
        spellCheck={false}
        aria-label="Address"
        onChange={(event) => setInput(event.target.value)}
      />
      <button type="button" className="browser-nav-button close-ghost" aria-label="Clear address" onClick={() => setInput('')}>
        ×
      </button>
    </form>
  )
}

function upsertMany(current: ChatItem[], nextItems: ThreadItem[]): ChatItem[] {
  const next = [...current]

  for (const item of nextItems) {
    const index = next.findIndex((currentItem) => currentItem.id === item.id)

    if (index === -1) {
      next.push(item)
    } else {
      next[index] = item
    }
  }

  return next
}

function isRelevantThread(incomingThreadId: string, activeThreadId: string | null): boolean {
  return !activeThreadId || incomingThreadId === activeThreadId
}

function threadTitle(thread: Thread): string {
  return thread.name || thread.preview || 'New Chat'
}

function formatThreadTime(seconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(seconds * 1000))
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/)
  return lines.length > maxLines ? lines.slice(-maxLines).join('\n') : text
}
