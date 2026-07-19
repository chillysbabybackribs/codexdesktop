import { useMemo, useState } from 'react'
import { parseUnifiedDiff } from './diff'
import type { ThreadItem } from '../../shared/session-protocol'

// Cursor-style post-generation review bar: after a turn that edited files
// settles, this bar floats above the composer summarizing the changes with
// Keep all / Undo all and per-file undo. Edits are already applied (the app
// auto-applies, like Cursor 2.x) — this is the post-hoc review surface.

type FileChangeItem = Extract<ThreadItem, { type: 'fileChange' }>
export type ReviewChange = FileChangeItem['changes'][number]

export function ReviewBar({
  changes,
  workspace,
  undonePaths,
  alwaysKeepAll,
  onKeepAll,
  onSetAlwaysKeepAll,
  onUndoAll,
  onUndoFile
}: {
  changes: ReviewChange[]
  workspace: string | null
  undonePaths: ReadonlySet<string>
  alwaysKeepAll: boolean
  onKeepAll: () => void
  onSetAlwaysKeepAll: (enabled: boolean) => void
  onUndoAll: () => void
  onUndoFile: (path: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [confirmingUndoAll, setConfirmingUndoAll] = useState(false)

  const files = useMemo(
    () =>
      changes.map((change) => {
        const parsed = parseUnifiedDiff(
          change.diff,
          change.kind.type === 'add' ? 'add' : change.kind.type === 'delete' ? 'del' : undefined
        )
        return { path: change.path, adds: parsed.adds, dels: parsed.dels }
      }),
    [changes]
  )
  const totalAdds = files.reduce((sum, file) => sum + file.adds, 0)
  const totalDels = files.reduce((sum, file) => sum + file.dels, 0)

  return (
    <div className="review-bar" role="region" aria-label="Review changes">
      <div className="review-bar-head">
        <button
          type="button"
          className="review-bar-summary"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <ReviewChevron className={`review-chevron ${expanded ? 'is-open' : ''}`} />
          <span className="review-bar-count">
            {files.length} {files.length === 1 ? 'file' : 'files'} changed
          </span>
          <span className="review-bar-totals">
            {totalAdds > 0 ? <span className="diff-count-add">+{totalAdds}</span> : null}
            {totalDels > 0 ? <span className="diff-count-del">−{totalDels}</span> : null}
          </span>
        </button>
        <div className="review-bar-actions">
          <button
            type="button"
            className={`review-undo-all ${confirmingUndoAll ? 'is-confirming' : ''}`}
            title="Restore every workspace file to how it was before this turn (including files changed by shell commands). The current state is checkpointed first."
            onClick={() => {
              if (confirmingUndoAll) {
                setConfirmingUndoAll(false)
                onUndoAll()
              } else {
                setConfirmingUndoAll(true)
              }
            }}
            onBlur={() => setConfirmingUndoAll(false)}
          >
            {confirmingUndoAll ? 'Undo all changes?' : 'Undo all'}
          </button>
          <button
            type="button"
            className={`review-always-keep ${alwaysKeepAll ? 'is-active' : ''}`}
            aria-pressed={alwaysKeepAll}
            title="Automatically keep future edits while continuing to show each turn's change summary and Undo controls."
            onClick={() => onSetAlwaysKeepAll(!alwaysKeepAll)}
          >
            <span className="review-always-keep-mark" aria-hidden="true">
              ✓
            </span>
            Always keep all
          </button>
          <button type="button" className="review-keep-all" onClick={onKeepAll}>
            Keep all
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="review-files">
          {files.map((file) => {
            const undone = undonePaths.has(file.path)
            return (
              <div key={file.path} className={`review-file ${undone ? 'is-undone' : ''}`}>
                <button
                  type="button"
                  className="review-file-name"
                  title={file.path}
                  onClick={() => scrollToDiffCard(file.path)}
                >
                  <span className="review-file-base">{fileBase(file.path)}</span>
                  <span className="review-file-dir">{fileDir(file.path, workspace)}</span>
                </button>
                <span className="review-file-counts">
                  {file.adds > 0 ? <span className="diff-count-add">+{file.adds}</span> : null}
                  {file.dels > 0 ? <span className="diff-count-del">−{file.dels}</span> : null}
                </span>
                {undone ? (
                  <span className="work-chip chip-muted">undone</span>
                ) : (
                  <button type="button" className="review-file-undo" onClick={() => onUndoFile(file.path)}>
                    Undo
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

// Scroll the thread to the file's diff card and flash it (mirrors the agent
// focus affordance). Best-effort: silently no-ops if the card is not mounted.
function scrollToDiffCard(path: string): void {
  const node = document.querySelector(`[data-diff-path="${CSS.escape(path)}"]`)
  if (!(node instanceof HTMLElement)) return
  node.scrollIntoView({ behavior: 'smooth', block: 'center' })
  node.classList.add('is-flash')
  window.setTimeout(() => node.classList.remove('is-flash'), 900)
}

function fileBase(path: string): string {
  const clean = path.replace(/\/+$/, '')
  return clean.split('/').pop() || clean
}

function fileDir(path: string, workspace: string | null): string {
  const clean = path.replace(/\/+$/, '')
  const index = clean.lastIndexOf('/')
  const dir = index > 0 ? clean.slice(0, index) : ''
  if (!dir || !workspace) return dir
  const root = workspace.replace(/\/+$/, '')
  if (dir === root) return ''
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : dir
}

function ReviewChevron({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m8.5 6 6 6-6 6" />
    </svg>
  )
}
