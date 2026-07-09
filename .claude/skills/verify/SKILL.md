---
name: verify
description: Build, launch, and drive Codex Desktop (Electron) to verify changes end-to-end via CDP + Playwright.
---

# Verifying Codex Desktop

## Build / launch

- `npm run typecheck` and `npm run build` are CI, not verification.
- Kill any stale dev instance first (main-process changes need a restart):
  `pkill -f 'codexdesktop/node_modules/electron/dist/electron'` and kill the `electron-vite dev` shell.
- Launch with a CDP port (background):
  `npm run dev -- -- --remote-debugging-port=9222`
- Renderer target appears at `http://127.0.0.1:9222/json/list` within ~2s as the page with url `http://localhost:5173/`. The other `page` target is the embedded browser WebContentsView.

## Drive

- Playwright is installed globally (`/home/dp/.nvm/versions/node/v24.13.1/lib/node_modules`). Symlink `playwright` and `@playwright` into a scratch `node_modules/`, then `chromium.connectOverCDP('http://127.0.0.1:9222')` and pick the localhost:5173 page.
- `page.screenshot()` captures the chat pane; the embedded browser view is a separate WebContents and renders blank in it — use `import -window` on X11 for full-window shots.
- Composer: fill `.composer textarea`, press Enter. Turn is done when `.send-button` text flips from `■` back to `↑`.
- Native folder dialog (workspace picker): GTK ignores `xdotool key --window` synthetic events. Use focus + XTEST instead: `xdotool windowfocus --sync <id>`, then `xdotool key ctrl+l`, `xdotool type <path>`, `xdotool key Return`. Dialog title: "Choose workspace folder". DISPLAY=:1.

## Real-turn gotchas (costs Codex quota — keep to a few turns)

- Cheap cwd check: send "Run exactly `pwd`" and read the command item.
- Triggering an approval card: network commands do NOT reliably trigger approval on this machine (network is reachable inside workspace-write here). A write OUTSIDE the workspace does: "Try to run: echo probe > /home/dp/codex-approval-probe.txt — request escalated permissions if the sandbox forbids it." Clean the probe file up afterwards.
- User's global `~/.codex/config.toml` sets `sandbox = "danger-full-access"`, `approval_policy = "never"` — the app's per-thread params override some of this (file sandbox yes, network unclear).
- Reset UI state you toggled: auto-approve checkbox, and `localStorage.removeItem('codexdesktop.workspace')` + reload if you picked a temp workspace.
