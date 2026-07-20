# Claude process-lifecycle policy (Claude-prep step 7 — APPROVED 2026-07-19)

Decision record for how the Claude Code runtime is spawned, bounded, and
versioned inside Codex Desktop. Approved by the user as recommended. These are
implementation constraints for the Claude adapter, not aspirations.

## Context

Codex runs as ONE shared `codex app-server` child serving every thread. Claude
Code has no shared-server mode: each conversation is its own CLI process
(`processModel: 'per-session'` in its capability descriptor). The policy below
bounds that inherently per-session model so a second runtime can never violate
the standing build directive: no degradation to the app or the user's machine.

## Decisions

### D1 — Bounded process-per-session

One live Claude process per RECENTLY ACTIVE session; all other sessions exist
only as on-disk session files plus their local transcript cache. Rationale: an
unbounded model idles at ~150–250 MB RSS per process; 12 tabs + a dock could
hold 2.5–4 GB hostage. Crash isolation (one process = one session) is kept.

### D2 — Live-process cap: 3, queued beyond it

- At most **3** live Claude processes (a plain exported constant, not a
  setting). Idle sessions do not hold slots (see D3).
- A turn-start beyond the cap QUEUES for a slot and the session shows a
  visible "queued" state — never a silent stall.
- Rationale: bounds RAM; protects subscription quota velocity (parallel-turn
  bursts trip Anthropic rate limits, which surface as failed turns and feed
  the auto-recovery machinery into retry storms).
- Revisit trigger: the queue state being hit routinely in real use.

### D3 — Idle-kill at 15 minutes; resume transparently

- A live process with no active turn for **15 minutes** is killed. The
  API-side prompt cache expires by TTL (~5 min) regardless of process life, so
  past that window an idle process protects nothing — killing it frees RAM at
  zero marginal quota cost.
- **Never kill mid-turn.** No exceptions, including cap pressure.
- Next message to an evicted session respawns via session resume (~1–3 s to
  first model activity). UI continuity is already instant via the Phase 3
  transcript cache; only the model's first response bears the latency.
- Resume fidelity is a TESTED surface (session-file format churn across CLI
  versions contributed to the first integration's failure) — the adapter's
  smoke suite must include kill → resume → coherent-continuation.

### D4 — Exact-pinned runtime via npm; self-update off; version gate

- The Claude runtime is an **exact-pinned npm dependency** spawned from
  `node_modules/.bin` — the lockfile IS the vendoring; version bumps are
  one-line, deliberate, and run through the verify/smoke culture before
  landing. PATH resolution is explicitly rejected: the CLI self-updates by
  default and its stream-JSON surface churns fast — the adapter would break
  overnight with no commit in this repo (the first integration's
  init-gating breakage was exactly this class).
- The pinned copy runs with its auto-updater disabled.
- On adapter startup, assert the running binary's version equals the tested
  pin; mismatch warns loudly (surfaced, not silent — Phase 5 rules apply).

### D5 — RESOLVED: Agent SDK (spike run 2026-07-19)

See `claude-d5-spike-2026-07-19.md`. All three criteria verified live: the
SDK vendors an exactly version-paired runtime binary (D4 satisfied natively —
no self-updater in play), streaming-input sessions run one persistent
resumable process (D1–D3 map 1:1), and the event stream with
`includePartialMessages` covers every reducer input plus a first-class
`rate_limit_event` for the backoff requirement. Adapter contract discovered:
`system/init` repeats per message/resume and must not be treated as a
once-per-process gate. In-process MCP (`createSdkMcpServer`) becomes the
primary tool transport; the stdio shim is the fallback. `settingSources: []`
isolates app sessions from the user's `~/.claude`.

## Interactions with existing machinery

- Warm-up: the D2 slot pool may pre-spawn ONE Claude process at app launch
  (mirroring `CodexClient.warmUp()`), counted against the cap.
- Auto-recovery: rate-limit failures must be classified as non-recoverable-by-
  retry-storm — recovery backs off rather than burning quota (extend
  `isRecoverableTurnError` semantics per provider via the capability layer).
- Checkpoints, transcript cache, and the MCP tool facade are already
  provider-neutral; no policy interaction beyond D3's reliance on the cache.

## Status

With this document, prep steps 1–7 are complete (see
`claude-prep-status-2026-07-19.md`). The Claude adapter is now a well-scoped
build: D5 spike → adapter implementing `SessionProvider` under this policy →
golden-replay + live smokes.
