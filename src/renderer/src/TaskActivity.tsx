import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { CommandAction } from '../../shared/session-protocol'
import type { ThreadItem } from '../../shared/session-protocol'
import type { WebSearchAction } from '../../shared/session-protocol'
import { cleanCommand, commandDescriptionOf, narrateCommand } from './command-narrate'
import { parseUnifiedDiff, type DiffLine, type DiffSegment } from './diff'
import { langForPath, useLineTokens, type ThemedToken } from './highlight'
import type { TurnMeta, TurnTokenTelemetry } from './turn-telemetry'
import { latestItemProgress, type ItemMeta, type TurnPlanItem, type WorkItem } from './activity-model'
import { browserLinkComponents } from './MarkdownContent'

export type { TurnMeta, TurnMetaStatus } from './turn-telemetry'
export { workItemTypes } from './activity-model'
export type { ItemMeta, TurnPlanItem, WorkItem } from './activity-model'

type CommandExecutionItem = Extract<ThreadItem, { type: 'commandExecution' }>
type FileChangeItem = Extract<ThreadItem, { type: 'fileChange' }>
type McpToolCallItem = Extract<ThreadItem, { type: 'mcpToolCall' }>
type DynamicToolCallItem = Extract<ThreadItem, { type: 'dynamicToolCall' }>
type ReasoningItem = Extract<ThreadItem, { type: 'reasoning' }>
type PlanItem = Extract<ThreadItem, { type: 'plan' }>
type WebSearchItem = Extract<ThreadItem, { type: 'webSearch' }>

export type CdpScreenshotArtifact = {
  artifactPath: string
  fileName: string
  mediaType: string
  bytes: number
  width: number | null
  height: number | null
}

type CdpFileArtifact = {
  artifactPath: string
  fileName: string
  mediaType: string
  kind: 'pdf' | 'trace' | 'snapshot' | 'response-body'
  bytes: number
}

// ---------------------------------------------------------------------------
// File review context — the Keep/Undo flow (Cursor-style post-hoc review).
// Provided by ChatPane; consumed by DiffCard so every settled diff card offers
// a per-file Undo without threading callbacks through the memoized layers.
// ---------------------------------------------------------------------------

export type FileReviewActions = {
  canUndo: (turnId: string | null | undefined) => boolean
  isUndone: (turnId: string | null | undefined, path: string) => boolean
  undoFile: (turnId: string, path: string) => void
}

export const FileReviewContext = createContext<FileReviewActions>({
  canUndo: () => false,
  isUndone: () => false,
  undoFile: () => {}
})

// ---------------------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------------------

// 1 Hz clock for live elapsed labels; inert (and effect-free re-renders) when idle.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) {
      return
    }
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])

  return now
}

// A viewport that stays pinned to its bottom edge as content streams in.
// The caller controls whether it is visually scrollable. Resize/mutation
// observation catches Markdown, terminal output, and live diffs that grow
// after React's first layout pass without scheduling unbounded follow frames.
export function AutoFollow({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    const content = contentRef.current

    if (!el || !content) {
      return
    }

    let frame: number | null = null
    let settleFrame: number | null = null
    let disposed = false

    const cancel = (): void => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
        frame = null
      }
      if (settleFrame !== null) {
        window.cancelAnimationFrame(settleFrame)
        settleFrame = null
      }
    }

    const follow = (): void => {
      if (disposed || frame !== null) {
        return
      }

      frame = window.requestAnimationFrame(() => {
        frame = null
        if (disposed) {
          return
        }
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)

        if (settleFrame === null) {
          settleFrame = window.requestAnimationFrame(() => {
            settleFrame = null
            if (!disposed) {
              el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
            }
          })
        }
      })
    }

    // Observe the inner content box, which grows as streamed text is appended —
    // the scroll container's own border box does not. This catches growth with
    // a coalesced resize callback instead of a subtree characterData
    // MutationObserver firing once per streamed character.
    const resizeObserver = new ResizeObserver(follow)
    resizeObserver.observe(content)

    follow()

    return () => {
      disposed = true
      cancel()
      resizeObserver.disconnect()
    }
  }, [])

  return (
    <div ref={ref} className={`auto-follow ${className ?? ''}`}>
      <div ref={contentRef}>{children}</div>
    </div>
  )
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function fmtTokens(count: number): string {
  if (count < 1000) {
    return String(count)
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  return `${(count / 1_000_000).toFixed(2)}M`
}

function basename(path: string): string {
  const clean = path.replace(/\/+$/, '')
  return clean.split('/').pop() || clean
}

function dirOf(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const index = clean.lastIndexOf('/')
  return index > 0 ? clean.slice(0, index) : ''
}

// Directory label for file cards: relative to the workspace when inside it
// (Cursor-style), absolute otherwise. Empty at the workspace root.
function displayDir(path: string, workspace: string | null): string {
  const dir = dirOf(path)
  if (!dir || !workspace) {
    return dir
  }
  const root = workspace.replace(/\/+$/, '')
  if (dir === root) {
    return ''
  }
  if (dir.startsWith(`${root}/`)) {
    return dir.slice(root.length + 1)
  }
  return dir
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches ANSI escape sequences to strip them
const ansiPattern = /\[[0-9;?]*[ -/]*[@-~]/g

function stripAnsi(text: string): string {
  return text.replace(ansiPattern, '')
}

function previewJson(value: unknown, max: number): string | null {
  if (value === null || value === undefined) {
    return null
  }
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (!text || text === '{}' || text === 'null') {
      return null
    }
    return truncate(text, max)
  } catch {
    return null
  }
}

function itemDurationMs(item: WorkItem, meta: ItemMeta | undefined): number | null {
  if ('durationMs' in item && typeof item.durationMs === 'number') {
    return item.durationMs
  }
  if (meta?.startedAtMs && meta?.completedAtMs) {
    return Math.max(0, meta.completedAtMs - meta.startedAtMs)
  }
  return null
}

// Effective display status: items abandoned by an interrupted/failed turn keep
// status "inProgress" forever — once the turn is no longer live they render as
// stopped, not running.
type BlockStatus = 'running' | 'done' | 'failed' | 'declined' | 'stopped'

function blockStatus(item: WorkItem, live: boolean): BlockStatus {
  const raw =
    item.type === 'commandExecution' ||
    item.type === 'fileChange' ||
    item.type === 'mcpToolCall' ||
    item.type === 'dynamicToolCall'
      ? item.status
      : null

  if (raw === 'failed') {
    return 'failed'
  }
  if (raw === 'declined') {
    return 'declined'
  }
  if (raw === 'inProgress') {
    return live ? 'running' : 'stopped'
  }
  return 'done'
}

// ---------------------------------------------------------------------------
// Icons — quiet 15px strokes matching the app's existing inline icon style
// ---------------------------------------------------------------------------

function Icon({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const TerminalIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M5 8l4 4-4 4" />
    <path d="M12 17h7" />
  </Icon>
)

const FilePenIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M13 4H7a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9.5L13 4Z" />
    <path d="M13 4v5.5h5.5" />
  </Icon>
)

const FileReadIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M13 4H7a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9.5L13 4Z" />
    <path d="M9 13h6M9 16.2h4" />
  </Icon>
)

const FolderListIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h3.6a1.5 1.5 0 0 1 1.1.44l1 1.06h7.8A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5L3.5 7Z" />
  </Icon>
)

const SearchGlassIcon = (): React.JSX.Element => (
  <Icon>
    <circle cx="11" cy="11" r="6.2" />
    <path d="m19.6 19.6-3.4-3.4" />
  </Icon>
)

const GlobeIcon = (): React.JSX.Element => (
  <Icon>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M3.8 12h16.4M12 3.8c2.4 2.2 3.6 5 3.6 8.2s-1.2 6-3.6 8.2c-2.4-2.2-3.6-5-3.6-8.2s1.2-6 3.6-8.2Z" />
  </Icon>
)

const PlugIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M9 3.8v4.4M15 3.8v4.4" />
    <path d="M6.5 8.2h11v3.2a5.5 5.5 0 0 1-11 0V8.2Z" />
    <path d="M12 16.9v3.3" />
  </Icon>
)

const ListChecksIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M4 6.5l1.4 1.4L8 5.3" />
    <path d="M4 13l1.4 1.4L8 11.8" />
    <path d="M11.5 7h8M11.5 13.5h8M4.5 19.5h15" />
  </Icon>
)

const BotIcon = (): React.JSX.Element => (
  <Icon>
    <rect x="5" y="8" width="14" height="10" rx="2.5" />
    <path d="M12 8V4.5M9.5 13h.01M14.5 13h.01" />
  </Icon>
)

const ImageIcon = (): React.JSX.Element => (
  <Icon>
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.4" />
    <path d="m5.5 17 4.5-4.5 3 3 2.5-2.5 3 4" />
  </Icon>
)

const ClockIcon = (): React.JSX.Element => (
  <Icon>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
)

const ChevronDownIcon = ({ className }: { className?: string }): React.JSX.Element => (
  <Icon className={className}>
    <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
  </Icon>
)

function Spinner(): React.JSX.Element {
  return <span className="work-spinner" />
}

// ---------------------------------------------------------------------------
// Row + card primitives
// ---------------------------------------------------------------------------

function ToolRow({
  icon,
  status,
  verb,
  detail,
  detailTitle,
  meta,
  sub
}: {
  icon: React.JSX.Element
  status: BlockStatus
  verb: string
  detail?: string | null
  detailTitle?: string
  meta?: string | null
  sub?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`tool-row status-${status}`}>
      <span className="tool-row-icon">{status === 'running' ? <Spinner /> : icon}</span>
      <div className="tool-row-main">
        <div className="tool-row-line">
          <span className="tool-row-verb">{verb}</span>
          {detail ? (
            <code className="tool-row-detail" title={detailTitle ?? detail}>
              {detail}
            </code>
          ) : null}
          {meta ? <span className="tool-row-meta">{meta}</span> : null}
        </div>
        {sub}
      </div>
    </div>
  )
}

function StatusChip({ status, exitCode }: { status: BlockStatus; exitCode?: number | null }): React.JSX.Element | null {
  if (status === 'failed') {
    return <span className="work-chip chip-fail">{typeof exitCode === 'number' ? `exit ${exitCode}` : 'failed'}</span>
  }
  if (status === 'declined') {
    return <span className="work-chip chip-muted">declined</span>
  }
  if (status === 'stopped') {
    return <span className="work-chip chip-muted">stopped</span>
  }
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return <span className="work-chip chip-fail">exit {exitCode}</span>
  }
  return null
}

// ---------------------------------------------------------------------------
// Thought (reasoning) — the streamed model narration
// ---------------------------------------------------------------------------

function reasoningText(item: ReasoningItem): string {
  const summary = item.summary.map((part) => part.trim()).filter(Boolean)
  if (summary.length) return summary.join('\n\n')
  // Older threads and providers without a reasoning summary remain readable;
  // the full reasoning content is otherwise intentionally kept in Trace.
  return item.content.map((part) => part.trim()).filter(Boolean).join('\n\n')
}

// Cursor-style collapsed thinking: a "Thought for Xs" disclosure header with a
// hover chevron. While streaming, the header shimmers with a live elapsed
// label; expanding works mid-stream (the body auto-follows its own growth).
function ThoughtBlock({
  item,
  meta,
  streaming
}: {
  item: ReasoningItem
  meta: ItemMeta | undefined
  streaming: boolean
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const now = useNow(streaming)
  const text = reasoningText(item)

  if (!text && !streaming) {
    return null
  }

  const elapsedMs = streaming && meta?.startedAtMs ? Math.max(0, now - meta.startedAtMs) : null
  const durationMs =
    !streaming && meta?.startedAtMs && meta?.completedAtMs ? Math.max(0, meta.completedAtMs - meta.startedAtMs) : null
  const label = streaming
    ? elapsedMs !== null && elapsedMs >= 3000
      ? `Thinking · ${fmtDuration(elapsedMs)}`
      : 'Thinking'
    : durationMs !== null
      ? `Thought for ${fmtDuration(durationMs)}`
      : 'Thought'

  const body = (
    <div className="thought-text">
      <ReactMarkdown components={browserLinkComponents}>{text}</ReactMarkdown>
    </div>
  )

  return (
    <div
      className={`thought-block ${streaming ? 'is-streaming' : ''}${expanded ? ' is-expanded' : ''}`}
    >
      <button
        type="button"
        className="thought-toggle"
        aria-expanded={expanded}
        disabled={!text}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`thought-label${streaming ? ' shimmer-text' : ''}`}>{label}</span>
        <ChevronDownIcon className="thought-chevron" />
      </button>
      {expanded && text ? (streaming ? <AutoFollow className="thought-stream">{body}</AutoFollow> : body) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Command execution — compact Cursor-style rows for read/list/search, a real
// terminal card for everything else
// ---------------------------------------------------------------------------

function isBrowseAction(action: CommandAction): boolean {
  return action.type === 'read' || action.type === 'listFiles' || action.type === 'search'
}

function CompactActionRows({
  item,
  status,
  duration
}: {
  item: CommandExecutionItem
  status: BlockStatus
  duration: number | null
}): React.JSX.Element {
  const meta = duration && duration >= 100 ? fmtDuration(duration) : null

  return (
    <>
      {item.commandActions.map((action, index) => {
        const rowMeta = index === item.commandActions.length - 1 ? meta : null
        if (action.type === 'read') {
          return (
            <ToolRow
              key={`${item.id}-${index}`}
              icon={<FileReadIcon />}
              status={status}
              verb="Read"
              detail={action.name}
              detailTitle={action.path}
              meta={rowMeta}
            />
          )
        }
        if (action.type === 'listFiles') {
          return (
            <ToolRow
              key={`${item.id}-${index}`}
              icon={<FolderListIcon />}
              status={status}
              verb="Listed"
              detail={action.path ? basename(action.path) : 'files'}
              detailTitle={action.path ?? undefined}
              meta={rowMeta}
            />
          )
        }
        const search = action.type === 'search' ? action : null
        return (
          <ToolRow
            key={`${item.id}-${index}`}
            icon={<SearchGlassIcon />}
            status={status}
            verb="Searched"
            detail={search?.query ? `"${truncate(search.query, 70)}"${search.path ? ` in ${basename(search.path)}` : ''}` : truncate(action.command, 80)}
            detailTitle={action.command}
            meta={rowMeta}
          />
        )
      })}
    </>
  )
}

const collapsedOutputLines = 12

function TerminalCard({
  item,
  meta,
  status,
  duration,
  liveNow
}: {
  item: CommandExecutionItem
  meta: ItemMeta | undefined
  status: BlockStatus
  duration: number | null
  liveNow: number
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  // Cursor-style step row: settled commands collapse to their header line
  // (failures stay open — the error is the payload). Live commands always
  // stream their output.
  const [open, setOpen] = useState<boolean | null>(null)
  const running = status === 'running'
  const output = useMemo(() => stripAnsi(item.aggregatedOutput ?? '').replace(/\n+$/, ''), [item.aggregatedOutput])
  const lines = useMemo(() => (output ? output.split('\n') : []), [output])

  const expanded = running || (open ?? status === 'failed')
  const hiddenCount = !running && !showAll ? Math.max(0, lines.length - collapsedOutputLines) : 0
  const shownLines = hiddenCount > 0 ? lines.slice(hiddenCount) : lines

  const elapsedMs = running && meta?.startedAtMs ? Math.max(0, liveNow - meta.startedAtMs) : null
  const elapsed = elapsedMs !== null && elapsedMs >= 2500 ? fmtDuration(elapsedMs) : null

  // Prose headline when the command classifies; the raw command stays one
  // hover (title) or one click (expanded echo line) away.
  const narration = useMemo(
    () => narrateCommand(item.command, item.commandActions, commandDescriptionOf(item)),
    [item]
  )
  const cleaned = useMemo(() => cleanCommand(item.command), [item.command])

  return (
    <div className={`term-card status-${status} ${expanded ? 'is-open' : 'is-collapsed'}`}>
      <button
        type="button"
        className="term-head"
        aria-expanded={expanded}
        disabled={running}
        onClick={() => {
          if (!running) setOpen(!expanded)
        }}
      >
        <span className="term-icon">{running ? <Spinner /> : <TerminalIcon />}</span>
        {narration.natural ? (
          <span className={`term-summary${running ? ' shimmer-text' : ''}`} title={cleaned}>
            {running ? narration.running : narration.done}
          </span>
        ) : (
          <code className="term-command" title={cleaned}>
            {narration.done}
          </code>
        )}
        <span className="term-meta">
          {!expanded && lines.length > 0 ? (
            <span className="term-line-count">{lines.length === 1 ? '1 line' : `${lines.length} lines`}</span>
          ) : null}
          {running && elapsed ? <span className="term-elapsed">{elapsed}</span> : null}
          {!running && duration ? <span className="term-elapsed">{fmtDuration(duration)}</span> : null}
          <StatusChip status={status} exitCode={item.exitCode} />
          {!running ? <ChevronDownIcon className={`term-chevron ${expanded ? 'is-open' : ''}`} /> : null}
        </span>
      </button>
      {expanded && !running && narration.natural ? (
        <div className="term-cmdline">
          <code>$ {cleaned}</code>
        </div>
      ) : null}
      {expanded && lines.length > 0 ? (
        running ? (
          <AutoFollow className="term-output is-live">
            <pre>{output}</pre>
          </AutoFollow>
        ) : (
          <div className="term-output">
            {hiddenCount > 0 ? (
              <button type="button" className="output-expand" onClick={() => setShowAll(true)}>
                ⋯ show {hiddenCount} earlier {hiddenCount === 1 ? 'line' : 'lines'}
              </button>
            ) : null}
            <pre>{shownLines.join('\n')}</pre>
            {showAll && lines.length > collapsedOutputLines ? (
              <button type="button" className="output-expand" onClick={() => setShowAll(false)}>
                collapse output
              </button>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  )
}

function CommandBlock({
  item,
  meta,
  live
}: {
  item: CommandExecutionItem
  meta: ItemMeta | undefined
  live: boolean
}): React.JSX.Element {
  const status = blockStatus(item, live)
  const duration = itemDurationMs(item, meta)
  const now = useNow(status === 'running')

  const browseOnly =
    item.commandActions.length > 0 &&
    item.commandActions.every(isBrowseAction) &&
    status !== 'failed' &&
    status !== 'declined'

  if (browseOnly) {
    return <CompactActionRows item={item} status={status} duration={duration} />
  }

  return <TerminalCard item={item} meta={meta} status={status} duration={duration} liveNow={now} />
}

// ---------------------------------------------------------------------------
// File changes — live-streaming diff cards
// ---------------------------------------------------------------------------

const collapsedDiffLines = 18

function DiffCard({
  path,
  kind,
  diff,
  status,
  workspace,
  turnId
}: {
  path: string
  kind: FileChangeItem['changes'][number]['kind']
  diff: string
  status: BlockStatus
  workspace: string | null
  turnId: string | null
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const [confirmingUndo, setConfirmingUndo] = useState(false)
  const review = useContext(FileReviewContext)
  const parsed = useMemo(
    () => parseUnifiedDiff(diff, kind.type === 'add' ? 'add' : kind.type === 'delete' ? 'del' : undefined),
    [diff, kind.type]
  )
  const running = status === 'running'
  // Syntax highlighting is deferred until the edit settles — live patches
  // re-render per delta and tokenizing every visible line each frame is waste.
  const lang = useMemo(() => (running ? null : langForPath(path)), [running, path])

  const kindBadge =
    kind.type === 'add' ? 'new' : kind.type === 'delete' ? 'deleted' : kind.move_path ? 'renamed' : null

  const dir = displayDir(path, workspace)
  const overflow = !running && !showAll ? Math.max(0, parsed.lines.length - collapsedDiffLines) : 0
  const shownLines = overflow > 0 ? parsed.lines.slice(0, collapsedDiffLines) : parsed.lines

  const undone = review.isUndone(turnId, path)
  const undoable = !running && !undone && turnId !== null && review.canUndo(turnId)

  return (
    <div className={`diff-card status-${status}${undone ? ' is-undone' : ''}`} data-diff-path={path}>
      <div className="diff-head">
        <span className="diff-file-icon">{running ? <Spinner /> : <FilePenIcon />}</span>
        <span className="diff-file" title={path}>
          <span className="diff-file-name">{basename(path)}</span>
          {dir ? <span className="diff-file-dir">{dir}</span> : null}
        </span>
        {kindBadge ? <span className="work-chip chip-muted">{kindBadge}</span> : null}
        {kind.type === 'update' && kind.move_path ? (
          <span className="diff-file-dir" title={kind.move_path}>
            → {basename(kind.move_path)}
          </span>
        ) : null}
        <span className="diff-counts">
          {parsed.adds > 0 ? <span className="diff-count-add">+{parsed.adds}</span> : null}
          {parsed.dels > 0 ? <span className="diff-count-del">−{parsed.dels}</span> : null}
          {undone ? <span className="work-chip chip-muted">undone</span> : null}
          <StatusChip status={status} />
          {undoable ? (
            <button
              type="button"
              className={`diff-undo-button ${confirmingUndo ? 'is-confirming' : ''}`}
              title="Restore this file to how it was before this turn. The current state is checkpointed first."
              onClick={() => {
                if (confirmingUndo) {
                  setConfirmingUndo(false)
                  if (turnId) review.undoFile(turnId, path)
                } else {
                  setConfirmingUndo(true)
                }
              }}
              onBlur={() => setConfirmingUndo(false)}
            >
              {confirmingUndo ? 'Undo file?' : 'Undo'}
            </button>
          ) : null}
        </span>
      </div>
      {parsed.lines.length > 0 ? (
        running ? (
          <AutoFollow className="diff-body is-live">
            <DiffLines lines={parsed.lines} lang={null} />
          </AutoFollow>
        ) : (
          <div className="diff-body">
            <DiffLines lines={shownLines} lang={lang} />
            {overflow > 0 ? (
              <button type="button" className="output-expand" onClick={() => setShowAll(true)}>
                ⋯ show full diff · {overflow} more {overflow === 1 ? 'line' : 'lines'}
              </button>
            ) : null}
            {showAll && parsed.lines.length > collapsedDiffLines ? (
              <button type="button" className="output-expand" onClick={() => setShowAll(false)}>
                collapse diff
              </button>
            ) : null}
          </div>
        )
      ) : running ? (
        <div className="diff-body">
          <div className="diff-skeleton" />
        </div>
      ) : null}
    </div>
  )
}

function DiffLines({ lines, lang }: { lines: DiffLine[]; lang: string | null }): React.JSX.Element {
  const lineTokens = useLineTokens(lines, lang, lang !== null)

  return (
    <div className="diff-lines">
      {lines.map((line, index) =>
        line.kind === 'hunk' ? (
          <div key={index} className="diff-line diff-hunk">
            <span className="diff-gutter" />
            <span className="diff-text">{line.text}</span>
          </div>
        ) : (
          <div key={index} className={`diff-line diff-${line.kind}`}>
            <span className="diff-gutter">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
            <span className="diff-text">{renderDiffText(line, lineTokens?.[index] ?? null)}</span>
          </div>
        )
      )}
    </div>
  )
}

function renderDiffText(line: DiffLine, tokens: ThemedToken[] | null): React.ReactNode {
  if (tokens) {
    return renderHighlightedDiffText(tokens, line.segments)
  }
  if (line.segments) {
    return line.segments.map((segment, si) =>
      segment.emph ? (
        <mark key={si} className="diff-emph">
          {segment.text}
        </mark>
      ) : (
        <span key={si}>{segment.text}</span>
      )
    )
  }
  return line.text || ' '
}

// Overlay Shiki tokens with the intra-line emphasis ranges: tokens are split
// at emphasis boundaries so the changed span keeps its darker tint while every
// piece keeps its syntax color.
function renderHighlightedDiffText(tokens: ThemedToken[], segments: DiffSegment[] | undefined): React.ReactNode[] {
  const ranges: Array<[number, number]> = []
  if (segments) {
    let offset = 0
    for (const segment of segments) {
      if (segment.emph && segment.text) {
        ranges.push([offset, offset + segment.text.length])
      }
      offset += segment.text.length
    }
  }

  const out: React.ReactNode[] = []
  let pos = 0
  let key = 0
  for (const token of tokens) {
    const start = pos
    const end = pos + token.content.length
    const style = token.color ? { color: token.color } : undefined
    let cursor = start
    while (cursor < end) {
      const active = ranges.find(([from, to]) => cursor >= from && cursor < to)
      const next = active
        ? Math.min(end, active[1])
        : Math.min(end, ranges.find(([from]) => from > cursor)?.[0] ?? end)
      const piece = token.content.slice(cursor - start, next - start)
      out.push(
        active ? (
          <mark key={key++} className="diff-emph" style={style}>
            {piece}
          </mark>
        ) : (
          <span key={key++} style={style}>
            {piece}
          </span>
        )
      )
      cursor = next
    }
    pos = end
  }
  return out
}

function FileChangeBlock({
  item,
  meta,
  live,
  workspace
}: {
  item: FileChangeItem
  meta: ItemMeta | undefined
  live: boolean
  workspace: string | null
}): React.JSX.Element {
  const status = blockStatus(item, live)

  return (
    <>
      {item.changes.map((change) => (
        <DiffCard
          key={`${item.id}-${change.path}`}
          path={change.path}
          kind={change.kind}
          diff={change.diff}
          status={status}
          workspace={workspace}
          turnId={meta?.turnId ?? null}
        />
      ))}
      {item.changes.length === 0 && status === 'running' ? (
        <ToolRow icon={<FilePenIcon />} status={status} verb="Editing" detail="…" />
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// MCP / dynamic tool calls, web search, plans, and the long tail
// ---------------------------------------------------------------------------

function McpBlock({
  item,
  meta,
  live
}: {
  item: McpToolCallItem
  meta: ItemMeta | undefined
  live: boolean
}): React.JSX.Element {
  const status = blockStatus(item, live)
  const duration = itemDurationMs(item, meta)
  const args = previewJson(item.arguments, 80)
  const progress = status === 'running' && meta?.progress?.length ? meta.progress[meta.progress.length - 1] : null
  const errorText = item.error ? truncate(String((item.error as { message?: string }).message ?? 'tool error'), 160) : null

  return (
    <ToolRow
      icon={<PlugIcon />}
      status={status}
      verb={item.server}
      detail={args ? `${item.tool} ${args}` : item.tool}
      detailTitle={args ? `${item.tool} ${args}` : item.tool}
      meta={duration && duration >= 100 ? fmtDuration(duration) : null}
      sub={
        progress ? (
          <div className="tool-row-sub shimmer-text">{truncate(progress, 120)}</div>
        ) : errorText ? (
          <div className="tool-row-sub is-error">{errorText}</div>
        ) : null
      }
    />
  )
}

function DynamicToolBlock({
  item,
  meta,
  live
}: {
  item: DynamicToolCallItem
  meta: ItemMeta | undefined
  live: boolean
}): React.JSX.Element {
  const status = blockStatus(item, live)
  const duration = itemDurationMs(item, meta)
  const args = previewJson(item.arguments, 80)
  const name = item.namespace ? `${item.namespace}.${item.tool}` : item.tool
  const screenshot = cdpScreenshotArtifact(item)
  const fileArtifact = cdpFileArtifact(item)
  const progress = status === 'running' && item.tool === 'research_web' ? latestItemProgress(meta) : null

  if (screenshot) {
    const dimensions = screenshot.width && screenshot.height ? `${screenshot.width}×${screenshot.height}` : null
    return (
      <div className="screenshot-tool-step">
        <ToolRow
          icon={<ImageIcon />}
          status={item.success === false ? 'failed' : status}
          verb="Captured screenshot"
          detail={screenshot.fileName}
          detailTitle={screenshot.artifactPath}
          meta={[dimensions, formatBytes(screenshot.bytes)].filter(Boolean).join(' · ')}
        />
        <CdpScreenshotPreview artifact={screenshot} />
      </div>
    )
  }

  if (fileArtifact) {
    return (
      <ToolRow
        icon={<FilePenIcon />}
        status={item.success === false ? 'failed' : status}
        verb={fileArtifact.kind === 'pdf' ? 'Saved PDF' : fileArtifact.kind === 'trace' ? 'Saved trace' : fileArtifact.kind === 'snapshot' ? 'Saved DOM snapshot' : 'Saved response body'}
        detail={fileArtifact.fileName}
        detailTitle={fileArtifact.artifactPath}
        meta={formatBytes(fileArtifact.bytes)}
      />
    )
  }

  return (
    <ToolRow
      icon={<PlugIcon />}
      status={item.success === false ? 'failed' : status}
      verb="Tool"
      detail={args ? `${name} ${args}` : name}
      meta={duration && duration >= 100 ? fmtDuration(duration) : null}
      sub={progress ? <div className="tool-row-sub shimmer-text">{truncate(progress, 120)}</div> : null}
    />
  )
}

export function CdpScreenshotPreview({ artifact }: { artifact: CdpScreenshotArtifact }): React.JSX.Element | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.api.artifact.readImage({ artifactPath: artifact.artifactPath }).then((result) => {
      if (active) setDataUrl(result.dataUrl)
    }).catch(() => {
      if (active) setDataUrl(null)
    })
    return () => {
      active = false
    }
  }, [artifact.artifactPath])

  if (!dataUrl) return null
  return (
    <button
      type="button"
      className="cdp-screenshot-attachment"
      aria-label={`Open ${artifact.fileName} in the browser`}
      title="Open in browser"
      onClick={() => void window.api.artifact.openImage({ artifactPath: artifact.artifactPath })}
    >
      <img
        className="cdp-screenshot-preview"
        src={dataUrl}
        alt={`Captured browser screenshot: ${artifact.fileName}`}
        width={artifact.width ?? undefined}
        height={artifact.height ?? undefined}
      />
      <span className="cdp-screenshot-filename">{artifact.fileName}</span>
    </button>
  )
}

function ImageViewPreview({ path, fileName }: { path: string; fileName: string }): React.JSX.Element | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.api.imageView.preview({ path }).then((result) => {
      if (active) setDataUrl(result.dataUrl)
    }).catch(() => {
      if (active) setDataUrl(null)
    })
    return () => {
      active = false
    }
  }, [path])

  if (!dataUrl) return null
  return (
    <div className="image-view-preview">
      <img src={dataUrl} alt={`Image viewed by the model: ${fileName}`} />
      <span className="cdp-screenshot-filename">{fileName}</span>
    </div>
  )
}

function cdpScreenshotArtifact(item: DynamicToolCallItem): CdpScreenshotArtifact | null {
  if (item.tool !== 'browser_cdp' && item.tool !== 'browser_screenshot' && item.tool !== 'app_screenshot') return null

  for (const content of item.contentItems ?? []) {
    if (content.type !== 'inputText') continue
    try {
      const parsed = JSON.parse(content.text) as { result?: unknown; screenshot?: Partial<CdpScreenshotArtifact> }
      const payload = parsed.result && typeof parsed.result === 'object' ? parsed.result as { screenshot?: Partial<CdpScreenshotArtifact> } : parsed
      const screenshot = payload.screenshot
      if (!screenshot || typeof screenshot.artifactPath !== 'string' || typeof screenshot.fileName !== 'string') continue
      if (typeof screenshot.mediaType !== 'string' || typeof screenshot.bytes !== 'number') continue
      return {
        artifactPath: screenshot.artifactPath,
        fileName: screenshot.fileName,
        mediaType: screenshot.mediaType,
        bytes: screenshot.bytes,
        width: typeof screenshot.width === 'number' ? screenshot.width : null,
        height: typeof screenshot.height === 'number' ? screenshot.height : null
      }
    } catch {
      // A failed or non-JSON CDP result is not an image artifact.
    }
  }
  return null
}

export function cdpScreenshotArtifacts(items: WorkItem[]): CdpScreenshotArtifact[] {
  const artifacts = new Map<string, CdpScreenshotArtifact>()
  for (const item of items) {
    if (item.type !== 'dynamicToolCall') continue
    const artifact = cdpScreenshotArtifact(item)
    if (artifact && !artifacts.has(artifact.artifactPath)) {
      artifacts.set(artifact.artifactPath, artifact)
    }
  }
  return [...artifacts.values()]
}

function cdpFileArtifact(item: DynamicToolCallItem): CdpFileArtifact | null {
  if (item.tool !== 'browser_cdp') return null

  for (const content of item.contentItems ?? []) {
    if (content.type !== 'inputText') continue
    try {
      const parsed = JSON.parse(content.text) as {
        result?: unknown
        pdf?: Partial<CdpFileArtifact>
        trace?: Partial<CdpFileArtifact>
        snapshot?: Partial<CdpFileArtifact>
        responseBody?: Partial<CdpFileArtifact>
      }
      const result = parsed.result && typeof parsed.result === 'object'
        ? parsed.result as typeof parsed
        : parsed
      const artifact = result.pdf ?? result.trace ?? result.snapshot ?? result.responseBody
      if (!artifact || typeof artifact.artifactPath !== 'string' || typeof artifact.fileName !== 'string') continue
      if ((artifact.kind !== 'pdf' && artifact.kind !== 'trace' && artifact.kind !== 'snapshot' && artifact.kind !== 'response-body') || typeof artifact.bytes !== 'number') continue
      return {
        artifactPath: artifact.artifactPath,
        fileName: artifact.fileName,
        mediaType: typeof artifact.mediaType === 'string' ? artifact.mediaType : '',
        kind: artifact.kind,
        bytes: artifact.bytes
      }
    } catch {
      // A failed or non-JSON CDP result is not a file artifact.
    }
  }
  return null
}

function webSearchDescription(action: WebSearchAction | null, query: string): { verb: string; detail: string | null } {
  if (action?.type === 'openPage') {
    return { verb: 'Opened page', detail: action.url ?? null }
  }
  if (action?.type === 'findInPage') {
    return { verb: 'Found in page', detail: action.pattern ?? action.url ?? null }
  }
  const searchQuery =
    action?.type === 'search' ? (action.query ?? action.queries?.[0] ?? query) : query
  return { verb: 'Searched web', detail: searchQuery ? `"${truncate(searchQuery, 90)}"` : null }
}

function WebSearchBlock({ item, live }: { item: WebSearchItem; live: boolean }): React.JSX.Element {
  const { verb, detail } = webSearchDescription(item.action, item.query)
  return <ToolRow icon={<GlobeIcon />} status={blockStatus(item, live)} verb={verb} detail={detail} />
}

function TurnPlanBlock({ item }: { item: TurnPlanItem }): React.JSX.Element | null {
  if (!item.steps.length && !item.explanation) {
    return null
  }

  return (
    <div className="plan-card">
      <div className="plan-head">
        <span className="plan-icon">
          <ListChecksIcon />
        </span>
        <span className="plan-title">Plan</span>
      </div>
      {item.explanation ? <div className="plan-explanation">{item.explanation}</div> : null}
      <div className="plan-steps">
        {item.steps.map((step, index) => (
          <div key={index} className={`plan-step is-${step.status}`}>
            <span className="plan-step-mark">
              {step.status === 'inProgress' ? <Spinner /> : <span className="plan-dot" />}
            </span>
            <span className={`plan-step-text ${step.status === 'inProgress' ? 'shimmer-text' : ''}`}>{step.step}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PlanTextBlock({ item, streaming }: { item: PlanItem; streaming: boolean }): React.JSX.Element | null {
  if (!item.text && !streaming) {
    return null
  }

  const body = (
    <div className="thought-text">
      <ReactMarkdown components={browserLinkComponents}>{item.text}</ReactMarkdown>
    </div>
  )

  return (
    <div className={`thought-block ${streaming ? 'is-streaming' : ''}`}>
      <div className="thought-head">
        <span className="thought-icon">
          <ListChecksIcon />
        </span>
        {streaming ? <span className="shimmer-text">Planning</span> : <span className="thought-label">Plan</span>}
      </div>
      {item.text ? (streaming ? <AutoFollow className="thought-stream">{body}</AutoFollow> : body) : null}
    </div>
  )
}

function GenericBlock({ item, live }: { item: WorkItem; live: boolean }): React.JSX.Element | null {
  const status = blockStatus(item, live)

  switch (item.type) {
    case 'sleep':
      return <ToolRow icon={<ClockIcon />} status={status} verb="Waited" detail={`${Math.round(item.durationMs / 1000)}s`} />
    case 'imageView':
      return (
        <div className="screenshot-tool-step">
          <ToolRow icon={<ImageIcon />} status={status} verb="Viewed" detail={basename(item.path)} detailTitle={item.path} />
          <ImageViewPreview path={item.path} fileName={basename(item.path)} />
        </div>
      )
    case 'imageGeneration':
      return (
        <ToolRow
          icon={<ImageIcon />}
          status={item.status === 'inProgress' && live ? 'running' : status}
          verb="Generated image"
          detail={item.revisedPrompt ? truncate(item.revisedPrompt, 90) : item.savedPath ? basename(item.savedPath) : null}
        />
      )
    case 'subAgentActivity':
      return <ToolRow icon={<BotIcon />} status={status} verb="Sub-agent" detail={`${item.kind} · ${basename(item.agentPath)}`} />
    case 'collabAgentToolCall':
      return (
        <ToolRow
          icon={<BotIcon />}
          status={item.status === 'inProgress' && live ? 'running' : status}
          verb="Agent"
          detail={item.prompt ? truncate(item.prompt, 90) : String(item.tool)}
        />
      )
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// WorkBlock dispatcher + WorkGroup
// ---------------------------------------------------------------------------

// Memoized on its scalar props. `item` keeps reference identity across deltas
// unless it's the one being patched, and `meta` is a single per-item entry, so
// a streaming sibling no longer re-renders every settled tool card in the turn.
const WorkBlock = memo(function WorkBlock({
  item,
  meta,
  live,
  isNewest,
  workspace
}: {
  item: WorkItem
  meta: ItemMeta | undefined
  live: boolean
  isNewest: boolean
  workspace: string | null
}): React.JSX.Element | null {
  switch (item.type) {
    case 'reasoning':
      return <ThoughtBlock item={item} meta={meta} streaming={live && isNewest && !meta?.completedAtMs} />
    case 'plan':
      return <PlanTextBlock item={item} streaming={live && isNewest && !meta?.completedAtMs} />
    case 'turnPlan':
      return <TurnPlanBlock item={item} />
    case 'commandExecution':
      return <CommandBlock item={item} meta={meta} live={live} />
    case 'fileChange':
      return <FileChangeBlock item={item} meta={meta} live={live} workspace={workspace} />
    case 'mcpToolCall':
      return <McpBlock item={item} meta={meta} live={live} />
    case 'dynamicToolCall':
      return <DynamicToolBlock item={item} meta={meta} live={live} />
    case 'webSearch':
      return <WebSearchBlock item={item} live={live} />
    default:
      return <GenericBlock item={item} live={live} />
  }
})

export function WorkGroup({
  items,
  itemMeta,
  live,
  workspace,
  newestItemId
}: {
  items: WorkItem[]
  itemMeta: Record<string, ItemMeta>
  live: boolean
  workspace: string | null
  newestItemId?: string
}): React.JSX.Element {
  const newestId = newestItemId ?? items[items.length - 1]?.id

  return (
    <div className="work-group">
      {items.map((item) => (
        <WorkBlock
          key={item.id}
          item={item}
          meta={itemMeta[item.id]}
          live={live}
          isNewest={item.id === newestId}
          workspace={workspace}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Turn tail — live shimmer status while running, permanent receipt when done
// ---------------------------------------------------------------------------

// Human label for what Codex is doing right now, from the newest live item.
export function currentActionLabel(
  items: WorkItem[],
  itemMeta: Record<string, ItemMeta>,
  streamingMessage: boolean
): string {
  // The turn plan is a status board, not an action — skip it when deciding
  // what Codex is doing right now.
  const scan = items.filter((item) => item.type !== 'turnPlan')

  for (let i = scan.length - 1; i >= 0; i -= 1) {
    const item = scan[i]
    const running =
      'status' in item && typeof item.status === 'string'
        ? item.status === 'inProgress'
        : i === scan.length - 1 && !itemMeta[item.id]?.completedAtMs

    if (!running) {
      continue
    }

    switch (item.type) {
      case 'reasoning':
        return 'Thinking'
      case 'plan':
        return 'Planning'
      case 'commandExecution': {
        const action = item.commandActions.find(isBrowseAction)
        if (action && item.commandActions.every(isBrowseAction)) {
          if (action.type === 'read') {
            return `Reading ${action.name}`
          }
          if (action.type === 'search') {
            return action.query ? `Searching "${truncate(action.query, 32)}"` : 'Searching files'
          }
          return 'Listing files'
        }
        const narration = narrateCommand(item.command, item.commandActions, commandDescriptionOf(item))
        return narration.natural ? truncate(narration.running, 48) : `Running ${truncate(cleanCommand(item.command), 38)}`
      }
      case 'fileChange': {
        const path = item.changes[0]?.path
        return path ? `Editing ${basename(path)}` : 'Editing files'
      }
      case 'mcpToolCall':
        return `Calling ${item.server}.${item.tool}`
      case 'dynamicToolCall': {
        const progress = item.tool === 'research_web' ? latestItemProgress(itemMeta[item.id]) : null
        if (progress) return progress
        return `Calling ${item.tool}`
      }
      case 'webSearch':
        return 'Searching the web'
      case 'imageGeneration':
        return 'Generating image'
      case 'subAgentActivity':
      case 'collabAgentToolCall':
        return 'Coordinating agents'
      case 'sleep':
        return 'Waiting'
      default:
        break
    }
  }

  return streamingMessage ? 'Writing' : 'Working'
}

function turnSummaryParts(items: WorkItem[], meta: TurnMeta | undefined): string[] {
  const parts: string[] = []

  const diffSummary = meta?.diffSummary
  if (diffSummary && diffSummary.files > 0) {
    parts.push(
      `${diffSummary.files} ${diffSummary.files === 1 ? 'file' : 'files'} +${diffSummary.adds} −${diffSummary.dels}`
    )
  } else {
    const fileItems = items.filter((item): item is FileChangeItem => item.type === 'fileChange')
    if (fileItems.length) {
      const paths = new Set(fileItems.flatMap((item) => item.changes.map((change) => change.path)))
      let adds = 0
      let dels = 0
      for (const fileItem of fileItems) {
        for (const change of fileItem.changes) {
          const parsed = parseUnifiedDiff(
            change.diff,
            change.kind.type === 'add' ? 'add' : change.kind.type === 'delete' ? 'del' : undefined
          )
          adds += parsed.adds
          dels += parsed.dels
        }
      }
      parts.push(`${paths.size} ${paths.size === 1 ? 'file' : 'files'} +${adds} −${dels}`)
    }
  }

  const commands = items.filter((item) => item.type === 'commandExecution').length
  if (commands) {
    parts.push(`${commands} ${commands === 1 ? 'command' : 'commands'}`)
  }

  const searches = items.filter((item) => item.type === 'webSearch').length
  if (searches) {
    parts.push(`${searches} ${searches === 1 ? 'search' : 'searches'}`)
  }

  const toolCalls = items.filter((item) => item.type === 'mcpToolCall' || item.type === 'dynamicToolCall').length
  if (toolCalls) {
    parts.push(`${toolCalls} ${toolCalls === 1 ? 'tool call' : 'tool calls'}`)
  }

  const tokens = meta?.tokens?.turn.totalTokens
  if (tokens) {
    parts.push(`${fmtTokens(tokens)} tokens`)
  }

  return parts
}

export function TurnTail({
  live,
  items,
  itemMeta,
  meta,
  streamingMessage,
  onOpenTrace,
  onRevert
}: {
  live: boolean
  items: WorkItem[]
  itemMeta: Record<string, ItemMeta>
  meta: TurnMeta | undefined
  streamingMessage: boolean
  onOpenTrace?: () => void
  onRevert?: () => void
}): React.JSX.Element | null {
  const now = useNow(live)
  // Two-click inline confirm: reverting rewrites workspace files, so a lone
  // misclick shouldn't fire it — but no dialogs; the revert itself is also
  // checkpointed, so even a confirmed mistake is undoable.
  const [confirmingRevert, setConfirmingRevert] = useState(false)

  if (live) {
    const label = currentActionLabel(items, itemMeta, streamingMessage)
    const tokens = meta?.tokens?.turn.totalTokens

    // Timer follows the CURRENT task: anchored to the newest running item's
    // start time, falling back to the turn start while nothing is running.
    let anchor = meta?.startedAtMs ?? null
    const scan = items.filter((item) => item.type !== 'turnPlan')
    for (let i = scan.length - 1; i >= 0; i -= 1) {
      const item = scan[i]
      const running =
        'status' in item && typeof item.status === 'string'
          ? item.status === 'inProgress'
          : i === scan.length - 1 && !itemMeta[item.id]?.completedAtMs
      if (running) {
        anchor = itemMeta[item.id]?.startedAtMs ?? anchor
        break
      }
    }
    const elapsed = anchor ? Math.max(0, now - anchor) : null

    return (
      <div className="turn-tail is-live">
        <span className="shimmer-text tail-label">{label}…</span>
        {elapsed !== null && elapsed >= 1000 ? <span className="tail-meta">{fmtDuration(elapsed)}</span> : null}
        {tokens ? (
          <span className="tail-meta" title={tokenTooltip(meta?.tokens)}>
            {fmtTokens(tokens)} tok
          </span>
        ) : null}
        {onOpenTrace ? <button type="button" className="turn-trace-button" onClick={onOpenTrace}>Trace</button> : null}
      </div>
    )
  }

  if (!items.length) {
    return null
  }

  const durationMs =
    meta?.durationMs ??
    (meta?.startedAtMs && meta?.completedAtMs ? Math.max(0, meta.completedAtMs - meta.startedAtMs) : null)
  const parts = turnSummaryParts(items, meta)

  let lead: string
  let tone = ''
  if (meta?.status === 'failed') {
    lead = durationMs ? `Failed after ${fmtDuration(durationMs)}` : 'Failed'
    tone = 'is-failed'
  } else if (meta?.status === 'interrupted') {
    lead = durationMs ? `Stopped after ${fmtDuration(durationMs)}` : 'Stopped'
    tone = 'is-stopped'
  } else {
    lead = durationMs ? `Worked for ${fmtDuration(durationMs)}` : 'Worked'
  }

  return (
    <div className={`turn-tail is-done ${tone}`}>
      <span className="tail-rule" aria-hidden="true" />
      <span className="tail-summary">
        {[lead, ...parts].join(' · ')}
        {meta?.status === 'failed' && meta.errorMessage ? ` — ${truncate(meta.errorMessage, 160)}` : ''}
      </span>
      {onRevert ? (
        <button
          type="button"
          className={`turn-revert-button ${confirmingRevert ? 'is-confirming' : ''}`}
          title="Restore the workspace files to how they were before this turn. The current state is checkpointed first, so a revert can itself be reverted."
          onClick={() => {
            if (confirmingRevert) {
              setConfirmingRevert(false)
              onRevert()
            } else {
              setConfirmingRevert(true)
            }
          }}
          onBlur={() => setConfirmingRevert(false)}
        >
          {confirmingRevert ? 'Revert workspace?' : 'Revert'}
        </button>
      ) : null}
      {onOpenTrace ? <button type="button" className="turn-trace-button" onClick={onOpenTrace}>Trace</button> : null}
      <span className="tail-rule" aria-hidden="true" />
    </div>
  )
}

function tokenTooltip(tokens: TurnTokenTelemetry | undefined): string | undefined {
  if (!tokens) {
    return undefined
  }
  const { turn, latestCall } = tokens
  const parts = [
    `${tokens.modelCallCount} model ${tokens.modelCallCount === 1 ? 'call' : 'calls'}`,
    `turn input ${fmtTokens(turn.inputTokens)}`,
    `cached ${fmtTokens(turn.cachedInputTokens)}`,
    `output ${fmtTokens(turn.outputTokens)}`,
    `reasoning ${fmtTokens(turn.reasoningOutputTokens)}`,
    `latest call ${fmtTokens(latestCall.totalTokens)}`
  ]
  if (tokens.modelContextWindow) {
    parts.push(`context ${fmtTokens(tokens.modelContextWindow)}`)
  }
  return parts.join(' · ')
}
