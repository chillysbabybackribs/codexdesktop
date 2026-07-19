# Codex Desktop contributor guide

## What this repository is

Codex Desktop is an Electron app with a React renderer and a native, agent-drivable Chromium browser surface, running two interchangeable model runtimes behind one `SessionProvider` abstraction: the OpenAI Codex app-server (`codex app-server --stdio`) and the Claude Agent SDK (routed by model-id prefix). On top it adds turn-level workspace checkpoints (reversible even for shell writes) and a cross-provider doer/auditor review loop. Treat the current checkout and its call sites as the source of truth; older notes and generated artifacts can drift. For a current capability map and direction, see `docs/capability-audit-2026-07-19.md`.

## Start with these files

| Area | Primary files |
| --- | --- |
| Electron lifecycle and IPC wiring | `src/main/index.ts`, `src/shared/ipc.ts`, `src/preload/index.ts` |
| Codex app-server lifecycle and requests | `src/main/codex/codex-client.ts`, `src/main/codex/app-server-process.ts`, `src/main/codex/app-server-rpc.ts` |
| Codex configuration, dynamic tools, and prompt overlay | `src/main/codex/codex-config.ts` |
| Local skill discovery and attachment | `src/main/codex/local-skill-registry.ts` |
| Browser tabs and native views | `src/main/browser/tab-manager.ts`, `src/main/browser/browser-tab-view.ts`, `src/main/browser/browser-target-registry.ts` |
| Agent-facing browser execution | `src/main/browser/browser-agent.ts`, `src/main/browser/browser-control-server.ts`, `src/main/browser/research-runner.ts` |
| Main chat UI | `src/renderer/src/App.tsx`, `src/renderer/src/useAgentSessions.ts`, `src/renderer/src/styles.css` |
| Generated Codex protocol types | `src/shared/codex-protocol/` |

Before adding a helper or abstraction, search for an existing implementation and inspect its callers. The browser pane is a native `WebContentsView`; DOM stacking rules alone cannot cover or reposition it.

## Instruction and tool boundaries

- Keep repo-specific architecture, commands, and verification rules in this file.
- Keep reusable task workflows in `skills/<name>/SKILL.md`; do not copy a skill's workflow into the global Codex prompt.
- Keep tool inputs, outputs, defaults, and error behavior in the tool description and schema beside the implementation.
- Keep `buildGuidance()` in `src/main/codex/codex-config.ts` limited to product-wide behavior that must apply in every workspace plus dynamic host-session safety.
- Generated browser scripts that use `CODEX_BROWSER_SOCK` must target an explicit existing tab id obtained from `GET /tabs` or an earlier browser result. Do not create a tab unless the user explicitly requested one.

## Generated code and source shadows

Do not hand-edit `src/shared/codex-protocol/`. Regenerate it from the installed Codex app-server when the protocol changes:

```bash
npm run gen:codex-protocol
```

Compiled JavaScript beside TypeScript sources can shadow the live source. The normal scripts check or clean these files. If a guard reports shadows, run:

```bash
npm run clean:source-shadows
```

## Automatic Git snapshots

- `npm run dev` starts both Electron/Vite and `scripts/git-autosnapshot.mjs --watch`. After the tree settles, the watcher commits safe changes and pushes the autosnapshot to the current branch on `origin` by default.
- In an auto-Git dev session, let the watcher own routine staging, commits, and pushes. Do not manually commit, push, rewrite history, or disable the watcher unless the user explicitly asks for that Git operation.
- Git state can change while work is in progress. Re-read `git status`, `HEAD`, and the current branch before Git-sensitive actions or handoff; a clean tree or autosnapshot commit does not prove the task is complete.
- Set `CODEXDESKTOP_AUTOGIT_PUSH=0` to keep snapshots local, or `CODEXDESKTOP_AUTOGIT=0` to disable the watcher. `npm run dev:app` and `npm run verify:app` do not start a watcher themselves.

## Verification

Use the narrowest relevant check first, then broaden in proportion to risk:

```bash
npm test
npm run typecheck
npm run build
```

For Electron startup, shutdown, window, browser-view, or other lifecycle changes, finish with:

```bash
npm run verify:app
```

`verify:app` builds and launches a visibly labelled disposable instance with isolated user data. When the current checkout is hosting the active Codex Desktop conversation, do not run `npm run dev`, `npm run dev:app`, terminate the host process tree, or close the host window as verification.
