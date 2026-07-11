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

## Guest-page input (embedded browser view) — use CDP, NOT xdotool

XTEST/`xdotool` mouse drags into the `WebContentsView` are unreliable: synthetic pointer events often don't register as a text selection, and pixel coords on live remote pages drift. Worse, code paths gated on `event.isTrusted` (e.g. auto-copy-on-drag) will (correctly) reject anything you dispatch from page JS via `dispatchEvent` — so a Playwright `page.evaluate(() => window.dispatchEvent(new PointerEvent(...)))` proves *rejection* but can't prove the genuine path.

Reliable path: drive the guest WebContents over CDP with `Input.dispatchMouseEvent`. Electron delivers these as **trusted** OS-level input (`isTrusted === true`), so they select text and fire `isTrusted`-gated handlers exactly like a real drag.

- The guest tab is a separate `page` target in `/json/list` (its url is the site, not `localhost:5173`). Connect Playwright's CDP session to it: `const cdp = await guestPage.context().newCDPSession(guestPage)`.
- Genuine drag-select over a known element (get its rect first via `guestPage.evaluate` → `getBoundingClientRect()`), then:
  ```js
  const press = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  const move  = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved',   x, y, button: 'left', buttons: 1 })
  const up    = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased',x, y, button: 'left', buttons: 1, clickCount: 1 })
  await press(r.left+2, r.top + r.height/2)
  for (let x = r.left+2; x <= r.right-2; x += 12) { await move(x, r.top + r.height/2) }  // >4px total triggers the drag threshold
  await up(r.right-2, r.top + r.height/2)
  ```
- Coords are CSS px in the guest viewport (top-left of the WebContents = 0,0), NOT screen coords — no window-offset math.
- To assert auto-copy fired: set a clipboard sentinel first (`printf X | xclip -selection clipboard`), run the drag, then read back with `xclip -selection clipboard -o`. The preload also mounts a shadow-DOM "Copied" toast host and clears the selection on success — assert `getSelection().toString() === ''` as a race-free in-page signal.
- Keyboard into the guest view: `Input.dispatchKeyEvent` (or `Input.insertText` for a string) over the same CDP session.

## Real-turn gotchas (costs Codex quota — keep to a few turns)

- Cheap cwd check: send "Run exactly `pwd`" and read the command item.
- Triggering an approval card: network commands do NOT reliably trigger approval on this machine (network is reachable inside workspace-write here). A write OUTSIDE the workspace does: "Try to run: echo probe > /home/dp/codex-approval-probe.txt — request escalated permissions if the sandbox forbids it." Clean the probe file up afterwards.
- User's global `~/.codex/config.toml` sets `sandbox = "danger-full-access"`, `approval_policy = "never"` — the app's per-thread params override some of this (file sandbox yes, network unclear).
- Reset UI state you toggled: auto-approve checkbox, and `localStorage.removeItem('codexdesktop.workspace')` + reload if you picked a temp workspace.
