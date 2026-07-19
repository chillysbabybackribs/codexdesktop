# Codex Desktop

**A local, browser-native agent workstation for OpenAI Codex and Claude.**

Codex Desktop combines two model runtimes, a persistent Chromium browser, reversible
workspace edits, and cross-provider review in one Electron application. It is built for
long-running software and web tasks that need a real logged-in browser, direct access to
the local workspace, and a second model checking the work.

> [!WARNING]
> This is an early, source-only developer build. Agents run with unrestricted local
> filesystem and shell access, and the embedded browser can use your authenticated web
> sessions. Run it only in workspaces and browser accounts you trust.

## What is included

- **Two agent runtimes.** OpenAI Codex app-server and the Claude Agent SDK share one
  provider-neutral session surface, model picker, transcript, and tool layer.
- **A browser the agent can actually use.** Electron `WebContentsView` tabs retain normal
  browser sessions while exposing objective-aware snapshots, guided flows, screenshots,
  responsive UI review, CDP, network and performance diagnostics, and bounded web
  research.
- **Model-spawned subagents.** A Codex or Claude lead can delegate one self-contained task
  to a fresh worker, choose either model family, watch it in the Agent Dock, and receive
  its final result back in the parent turn.
- **Cross-provider review.** A dock agent can audit the main turn against the real shared
  workspace and return a structured pass/flag verdict. Flagged feedback can be sent back
  to the doer automatically, with a one-bounce guard.
- **Reversible turns.** Before an agent turn, a temporary Git index captures the current
  non-ignored workspace state in a hidden ref. Per-file undo and whole-turn restore catch
  changes made by shell commands as well as normal edit tools.
- **A multi-pane working surface.** Open up to 12 conversations, arrange one to four live
  chat panes, place the browser beside or between them, and inspect rendered Markdown,
  highlighted code, diffs, terminal activity, plans, token usage, and per-turn traces.
- **Local context and extensions.** Attach files and images, mention indexed files or
  folders, load local skills, install Codex plugins, and persist compact prior-chat memory.
- **Optional Tor tunnel.** The browser profile can be routed through a bundled or system
  Tor client with matching DNS and WebRTC leak protections.

## How it fits together

```text
React workspace
├── SessionProvider
│   ├── Codex CLI → codex app-server --stdio
│   └── Claude Agent SDK → version-pinned bundled runtime
├── Native Chromium tabs → WebContentsView + in-process CDP
├── Agent tools → browser, research, plugins, skills, and subagents
└── Turn checkpoints → temporary Git index + hidden checkpoint refs
```

The two providers declare their capabilities instead of leaking provider-specific checks
through the UI. The same browser tool registry is exposed to Codex as dynamic tools, to
Claude through an in-process MCP server, and to local agent scripts through a Unix socket.

## Run from source

### Prerequisites

- Node.js `20.19+` or `22.12+` and npm
- Git
- The [OpenAI Codex CLI](https://github.com/openai/codex) installed, available as
  `codex` on `PATH`, and authenticated
- Optional: Claude credentials usable by the bundled Claude Agent SDK

No application-specific `.env` file is required for the core chat and browser features.

```bash
git clone https://github.com/chillysbabybackribs/codexdesktop.git
cd codexdesktop
npm ci
npm run dev:app
```

`dev:app` starts Electron and Vite without the repository's automatic Git watcher. The
app starts the Codex app-server lazily, and the model picker adds Claude models when that
runtime is available.

### Optional Tor support

```bash
npm run fetch:tor
```

This downloads the official Tor Expert Bundle for supported platforms. If no bundle is
published for your platform, install `tor` on `PATH` instead.

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev:app` | Start the normal Electron/Vite development app. |
| `npm run dev` | Start development **with automatic Git snapshots and pushes**. |
| `npm test` | Run the Node test suite. |
| `npm run typecheck` | Type-check the main, preload, and renderer projects. |
| `npm run build` | Type-check and create a production build. |
| `npm run verify:app` | Build and launch a labelled disposable instance with isolated user data. |
| `npm run lint` | Run Biome lint checks. |

Automatic snapshots are enabled by default under `npm run dev`: after the tree settles,
the watcher commits safe changes and pushes the current branch to `origin`. Set
`CODEXDESKTOP_AUTOGIT_PUSH=0` for local-only snapshots or `CODEXDESKTOP_AUTOGIT=0` to
disable the watcher.

Generated protocol types under `src/shared/codex-protocol/` should not be edited by hand.
Regenerate them from the installed Codex app-server with `npm run gen:codex-protocol`.

See [AGENTS.md](AGENTS.md) for the contributor map, architecture entry points, source
shadow rules, and lifecycle-safe verification guidance. The dated
[capability audit](docs/capability-audit-2026-07-19.md) provides deeper product context,
but the current checkout remains the source of truth as features evolve.

## Current boundaries

- Subagent delegation is currently one blocking child turn per tool call; parallel fan-out
  and gather are not implemented.
- Claude sessions do not support every Codex capability, including mid-turn steering,
  remote compaction, thread goals, and Codex plugins.
- Turn checkpoints require a Git worktree and cover non-ignored files. They are a recovery
  convenience, not a substitute for normal version control and backups.
- There is no packaged release, auto-updater, or stable compatibility promise yet.

## License

No open-source license has been added yet.
