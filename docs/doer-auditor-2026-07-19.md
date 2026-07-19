# Codex-doer / Claude-auditor pairing (2026-07-19)

The cross-provider flagship from the dock brainstorm, now live: the main chat
does the work on Codex; a dock agent in **audit mode** (defaulting to the
Claude provider — a different model family reviewing the doer) automatically
reviews every file-changing turn by reading the actual diff in the shared
workspace. No transcript piping.

## How it works

- **Audit mode** is a per-dock-session flag (`auditsMain`, persisted like
  `watchesMain`), toggled from the agent card menu ("Audit main-chat turns").
  Enabling it on a session that has not chosen a runtime defaults the model to
  `claude-default` — the cross-provider pairing by default, overridable.
- **Trigger** (`src/renderer/src/audit-trigger.ts`, pure + tested): fires when
  the FOCUSED main chat completes ANY turn with substance (changed files, an
  answer, or steps) and the auditor is idle. File-changing turns get the
  workspace-grounded diff audit; chat-only turns (brainstorming, research,
  Q&A) get a second-opinion review of the answer — the briefing embeds the
  doer's reply (clipped), a deliberate v2 departure from "no transcript
  piping". Trivial turns earn a few words by prompt design, not a skip. Busy
  auditors are skipped, not queued. Failed/interrupted turns trigger too —
  partial work is prime audit material.
- **Change detection is checkpoint-ground-truthed.** Protocol `fileChange`
  items only cover editor-tool edits; shell writes (`printf > file`) emit
  none — the exact blind spot our competitive research flagged in Claude
  Code's checkpointing. When no fileChange items exist, the trigger asks the
  Phase 4 checkpoint store for `changedFiles` (pre-turn snapshot vs current
  tree via a temp-index diff: modifications + additions + deletions,
  gitignore-respected). Caught-by-test and live.
- **The briefing carries the whole story, gathered for free.** The app
  "watches" the task at zero model cost (it already holds every work item)
  and the single audit prompt contains: the user's request (truncated), an
  ordered **step log** (`turnStepLines` — commands with exit codes, edited
  paths, searches, tool calls; capped at 20 clipped lines), and the changed
  file list. The auditor uses the log to choose per-file depth — `git diff`
  only what looks consequential, skim the rest — which keeps the final audit
  fast and cheap (one model call per task, no mid-turn monitoring turns).
  Findings under 120 words; durable issues appended to `AUDIT.md` — the
  filesystem blackboard both agents share.

## Verified

- 374/374 tests (trigger predicates, prompt shape, changedFiles ground truth
  incl. shell-made modification/addition/deletion, persistence round-trip).
- Live: fresh instance → dock agent → audit mode on (model auto-set to
  Claude) → codex doer ran `printf MUTATED > target.txt` (shell write, zero
  fileChange items) → checkpoint diff detected it → auto-audit fired within
  a second of turn completion → Claude ran the diff itself and replied in its
  card: "Looks solid. target.txt went from ORIGINAL CONTENT to exactly
  MUTATED (no trailing newline, matching printf's behavior). Only the one
  intended file changed…" — correctly declining an AUDIT.md entry for a clean
  change. Doer 12s, audit 12s.

## Notes / current bounds

- Audits fire for the focused main tab only (background tabs skip) — v1.
- One audit prompt per completing turn per auditor; multiple auditors all
  fire (each idle one).
- The audit send goes through the normal dock send path, so its user message
  is visible in the card (transparent; also steerable/interruptable like any
  agent turn).
