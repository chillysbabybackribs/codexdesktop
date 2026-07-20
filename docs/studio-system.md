# The Studio System

Codex Desktop as the operations department of a one-person app studio. The build tools are terminal agents; this app runs everything around the build: finding ideas, killing them cheaply, launching survivors, and monitoring what ships — using the one capability generic AI apps don't have, an agent-drivable browser logged in as you.

## The pieces

**A filesystem pipeline** (lives in whatever workspace folder you open, so it works per-niche or as one global studio repo):

```text
ideas/<slug>/idea.md          seed: problem + verbatim evidence + score
ideas/<slug>/validation.md    verdict memo: PROCEED / KILL / PARK
ideas/<slug>/launch.md        distribution checklist + assets
ideas/<slug>/pulse.md         per-app metric sources + readings
ideas/_killed/                dead ideas kept as anti-duplication memory
automations/*.mjs             agent-authored browser scripts (CODEX_BROWSER_SOCK)
automations/MANIFEST.md       what each script does, last-verified date
pulse/log.md                  dated portfolio sweeps
```

Idea status lifecycle: `seed → validating → validated → building → shipped` (or `killed` / `parked`).

**Four skills** (in `skills/`, invoked by typing the marker in chat):

| Marker | Stage | What it does |
|---|---|---|
| `$studio-scout` | find | mines logged-in communities/reviews/job-posts for recurring paid pain; writes seed files |
| `$studio-validate <slug>` | decide | kill-biased 4-check protocol; writes verdict memo, flips status |
| `$studio-launch <slug>` | distribute | works the submission checklist in the logged-in browser; drafts posts (publishing gated on you) |
| `$studio-pulse` | operate | weekly sweep of dashboards/reviews/uptime; anomalies first, charts, durable log |

**One compounding convention — crystallization.** The first time the agent drives a site (a directory submission, a dashboard read), it does so interactively; then it saves the flow as a script in `automations/` that talks to the browser socket directly. Reruns cost approximately nothing and no model attention. The agent repairs scripts when sites change. The automation library is the asset that accumulates: LLM as compiler, scripts as runtime.

## The operating cadence

The skills are tools; this is the discipline that makes them a system:

- **Scout weekly, 30 minutes.** Zero new seeds is a fine outcome.
- **Validate before building, always.** Max ~2 validations a week. Respect the verdict — the protocol is kill-biased on purpose, because a wrong PROCEED costs weeks.
- **One `building` at a time.** The pipeline exists so that ideas queue in files instead of in your head. Build with terminal agents in the app's own repo/workspace; use the `verify` skill for E2E checks in the embedded browser.
- **Launch is a checklist, not an event.** A few targets per session, resumable, every listing URL recorded.
- **Pulse every Monday** (`$studio-pulse`). When typing it weekly gets old, that's the trigger to add scheduling to the app — not before.

## Improving the system

Every run is allowed to sharpen the machine, in two ways only:

1. **Edit the skills.** When a run fights its instructions, fix the SKILL.md (they hot-reload). Skills should encode what actually worked last time.
2. **`app-improvement` blocks.** When the *app* is the friction (missing tool, bad default), the agent reports it structurally; batch these and implement only what two real runs have demanded (the pull rule).

App changes explicitly deferred until pulled: scheduled/background turns (wanted by pulse), auto-attach heuristics for studio skills in `selectTurnSkills` (wanted only if typing markers gets old), a pipeline-board UI (wanted only if `grep ideas/` stops being enough).
