# Phase 4 — Per-turn checkpoints + revert (2026-07-19)

Reversibility only, per the build directive: no approval gates, no permission
prompts, no cwd scoping. `danger-full-access` / `approvalPolicy: 'never'` are
untouched. What changed is that agent work is now undoable.

## Mechanism

[src/main/turn-checkpoint.ts](../src/main/turn-checkpoint.ts) —
`TurnCheckpointStore` (8 tests):

- A checkpoint snapshots the workspace's non-ignored files through a
  **temporary git index** (`read-tree` → `add -A` → `write-tree` →
  `commit-tree`) into a commit referenced from the hidden namespace
  `refs/codexdesktop/checkpoints/<id>`. The user's worktree, index, branches,
  `git status`, and the autosnapshot watcher are completely undisturbed;
  `.gitignore` is respected (no `node_modules`, no secrets from ignored files).
- Non-git workspaces return null gracefully — the ledger simply offers no
  revert there (checkpointing `$HOME` would be nonsense).
- **Revert** makes the worktree match the checkpoint exactly: restores every
  checkpointed file and deletes non-ignored files created since (path-guarded
  to the repo root). It takes a **safety checkpoint first**, so a revert is
  itself revertible — proven by test.
- Metadata (id → thread/turn/label/createdAt) lives in
  `userData/checkpoints/checkpoints.json`; pruning keeps the newest 40 per
  thread and deletes their refs. Empty repos (no HEAD) work.

## Wiring

- `CodexClient.sendMessage` fires a checkpoint **before** `turn/start`
  (fire-and-forget: a failure or slow `git add` never gates or delays a send)
  and binds it to the turn id once the server mints one. Thread cwds are
  tracked from `thread/start`/`thread/resume`.
- IPC: `checkpoint:list` / `checkpoint:revert` (+ preload `window.api.checkpoints`).
- Renderer: the completed-turn tail already carries the change ledger
  ("N files +adds −dels" via `turnSummaryParts`); it now also shows a
  **Revert** button when a checkpoint is bound to that turn — two-click inline
  confirm (no dialog), success/failure surfaced as a system message. The
  turnId → checkpointId map refreshes on thread switch and turn completion.

## Verified

- 342/342 tests (8 new: worktree neutrality, gitignore, non-repo null, exact
  revert incl. delete-created-files and spare-ignored-files, revert-of-revert,
  turn binding, empty repo, prune+ref deletion).
- Typecheck + build clean.
- Live end-to-end smoke: real turn ran `printf MUTATED > target.txt` in a git
  workspace → tail offered Revert → two-click confirm → file restored to
  original content on disk, system message shown.

## Also in this session (integration fix)

The parallel session completed the dock-onto-store migration, which made the
earlier App-level dock dual-write a duplicate reduction (every dock delta
applied twice into the store). Removed the App-side dual-write and the
redundant lifecycle wrappers; `useAgentSessions` + `agent-lifecycle` now own
dock store reduction and cleanup exclusively.

## Known limits (facts, not TODOs)

- Checkpoints cover the workspace repo only; files the agent edits outside it
  are not captured (unrestricted cwd remains by design).
- The checkpoint fires at send time, concurrent with turn start; an agent that
  writes within the first ~100-300ms of a turn could race the snapshot. In
  practice the first tool call lands seconds later.
- Revert restores files, not the conversation: the transcript keeps the turn.
