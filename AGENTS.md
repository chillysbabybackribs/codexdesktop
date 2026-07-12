# Codex Desktop contributor guide

## What this repository is

Codex Desktop is an Electron client with a React renderer, a native Chromium browser surface, and a Codex app-server process. Treat the current checkout and its call sites as the source of truth; older notes and generated artifacts can drift.

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

