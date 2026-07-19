# Codex Desktop — Codebase Audit (2026-07-19, branch `stacked-subagents`)

> Prepared for an external AI assistant with no prior exposure to this project. Facts only; every claim cites a real file. Items that could not be verified are marked as such. Line numbers refer to the working tree at commit `471dc6c`.

## 1. IDENTITY & PURPOSE

**App name:** Codex Desktop (`codexdesktop`, package version 0.1.0 — [package.json](package.json)).

**What it is:** A single-user desktop chat client for the OpenAI Codex agent, with an embedded native Chromium browser surface that the agent itself can drive. The package description reads "Codex Desktop chat with an embedded Chromium browser" ([package.json:4](package.json)). The app spawns the locally installed `codex` CLI as a JSON-RPC "app-server" child process and renders its threads/turns in a React UI; it adds its own layers on top: multi-tab chats, stacked sub-agent sessions ("Agent Dock"), agent-drivable browser tabs, a research runner, local skills, persistent memory, attachments, and turn-level token telemetry. It is a solo-developer personal tool (single git user "Agent", no packaging/distribution config — there is no electron-builder/forge config in [package.json](package.json)), used by its author both as a daily driver and as the host for developing itself.

**Platform/runtime:** Electron desktop app on Linux (developed on Linux; no platform-specific packaging found). Versions from [package-lock.json](package-lock.json), not from manifest ranges:

| Component | Version |
| --- | --- |
| Electron | 43.1.0 |
| electron-vite | 5.0.0 (Vite 7.3.6) |
| React / React DOM | 19.2.7 |
| TypeScript | 7.0.2 (native-preview "tsgo" era compiler) |
| react-markdown | 10.1.0 (+ remark-gfm 4.0.1) |
| linkedom | 0.18.13 (server-side DOM for page snapshots) |
| @vitejs/plugin-react | 5.2.0 |

Runtime dependencies are only 5 packages (react, react-dom, react-markdown, remark-gfm, linkedom); everything else is devDependencies ([package.json:30-45](package.json)). There is no state-management, router, or UI-kit dependency.

**Repo layout (2 levels, annotated):**

```
codexdesktop/
├── AGENTS.md               # Contributor guide for AI agents working on the repo (architecture pointers, verification rules)
├── HANDOFF.md              # Handoff doc from a token-bloat audit session (findings + plan; historical)
├── electron.vite.config.ts # Build config: main/preload/renderer entry points
├── package.json            # Scripts incl. dev-with-autogit, verify:app, source-shadow guard, protocol codegen
├── .env                    # 2 vars: BRAVE_API_KEY, TRUSTMRR_API_KEY (values not reproduced here)
├── src/
│   ├── main/               # Electron main process: app lifecycle, stores, codex/ (app-server client), browser/ (agent browser)
│   ├── preload/            # 3 preload scripts: main window bridge, browser-page, omnibox-popup
│   ├── renderer/           # React UI (App.tsx, AgentDock, TaskActivity, BrowserPane, landing page)
│   └── shared/             # ipc.ts (channel contract) + codex-protocol/ (generated Codex app-server types, do-not-edit)
├── scripts/                # Dev tooling: autosnapshot git watcher, verify-instance launcher, source-shadow guard, token baseline, test loader
├── docs/                   # Research JSON dumps, token-baseline reports, codex trace captures, studio-system.md
├── skills/                 # Reusable agent workflows (SKILL.md per dir): studio-hunt/scout/validate/launch/pulse, imagegen, planning, etc.
├── .claude/skills/verify   # Claude-Code-specific verify skill for this repo
├── hunts/                  # Work-product of the "studio" business-hunting workflow (dated hunt runs with corpus/dossiers) — not app code
├── ideas/                  # Business idea briefs produced by studio workflow (one dir per idea, incl. _killed/) — not app code
├── market-motion/          # Market-signal snapshots (hn/, trustmrr/) — not app code
├── sites/verified-skills/  # A small static website artifact — not app code
├── sources/                # Curated source directory (DIRECTORY.md) for the studio-hunt skill — not app code
├── out/                    # electron-vite build output (committed working artifact)
├── dist/                   # Additional build artifact directory
└── tsconfig*.json          # Split node (main/preload/shared) and web (renderer) TS projects
```

Note: `hunts/`, `ideas/`, `market-motion/`, `sites/`, `sources/`, and most of `skills/` are user work-product from running the app's "studio" agent workflows inside this same repo — they are data produced *by* the product, stored alongside the product's source. [docs/studio-system.md](docs/studio-system.md) describes that workflow system.

## 2. ARCHITECTURE MAP

### 2A. Process model

The app is a single-window Electron app (Electron ^43.1.0, `package.json`) with the following OS processes / execution contexts:

| # | Process/context | Created by | Notes |
|---|---|---|---|
| 1 | **Electron main process** | `src/main/index.ts` | Single-instance lock (`app.requestSingleInstanceLock()`, `src/main/index.ts:56`). Owns TabManager, OmniboxPopup, CodexClient, BrowserAgentController, ResearchRunner, stores. |
| 2 | **Main renderer** (chat UI) | `createWindow()` at `src/main/index.ts:149-226` | One frameless `BrowserWindow` (2048×1024, min 980×620, `frame: false`, title "Chat"), `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, preload `src/preload/index.ts` (built to `index.cjs`). Loads `src/renderer/index.html` → React app in `src/renderer/src/App.tsx` (5,125 lines). |
| 3 | **Browser tab `WebContentsView`s** (one per embedded-browser tab) | `TabManager.createTab` → `createBrowserTabView` (`src/main/browser/browser-tab-view.ts:23-42`) | Native Chromium views composited *above* the renderer DOM, partition `persist:codex-browser` (`src/main/browser/browser-session.ts:6`), preload `src/preload/browser-page.ts` (auto-copy-selection only). Up to 20 tabs persisted (`MAX_SAVED_BROWSER_TABS = 20`, `src/main/browser/browser-state-types.ts:17`). |
| 4 | **Omnibox popup `WebContentsView`** | `OmniboxPopup` (`src/main/browser/omnibox-popup.ts:20-57`) | Transparent suggestion dropdown stacked above tab views (renderer DOM cannot overlay native views); own preload `src/preload/omnibox-popup.ts`, page `src/renderer/omnibox-popup.html`. |
| 5 | **Popup `BrowserWindow`s** | `attachPopupWindowHandling` (`src/main/browser/browser-popups.ts`, wired in `browser-tab-view.ts:51`) | Opener-preserving `window.open` popups, tracked in `BrowserTargetRegistry` (`src/main/browser/browser-target-registry.ts`). |
| 6 | **`codex app-server` child process** | `spawn('codex', ['app-server', '--stdio'], { env: process.env })` (`src/main/codex/app-server-process.ts:13-18`) | Spawned lazily on the first codex request via `AppServerProcess.ensureStarted` (`app-server-process.ts:35-49`). All AI turns for main chat, main-chat tabs, and dock agents run through this one child. |

There is **no** separate BrowserWindow, renderer, or child process for sub-agents — the agent dock lives entirely inside the main renderer (see 2E).

**Communication paths:**

- **Renderer ↔ main:** Electron IPC over the 61 channels defined in `src/shared/ipc.ts:240-302` (full enumeration in 2B).
- **Main ↔ codex child:** JSON-RPC 2.0 over newline-delimited stdio (`AppServerRpc`, `src/main/codex/app-server-rpc.ts`). Request timeout 30,000 ms (`app-server-rpc.ts:32`); multi-line JSON responses buffered up to 16,000,000 chars (`app-server-rpc.ts:33`). Traffic is three-way: client→server requests (`initialize`, `thread/start`, `turn/start`, …), server notifications (`turn/*`, `item/*`, `thread/*`), and server→client requests answered in `CodexClient.handleServerRequest` (`src/main/codex/codex-client.ts:484-498`): `item/tool/requestUserInput` (empty answers), `currentTime/read`, `item/tool/call` (dynamic tools), everything else rejected `-32601`.
- **Codex agent ↔ embedded browser:** an HTTP server bound to a **Unix domain socket** (not TCP), `startBrowserControlServer` (`src/main/browser/browser-control-server.ts:288-329`), path `$TMPDIR/codex-browser-<pid>.sock` (`browser-control-server.ts:29-32`). Published as `CODEX_BROWSER_SOCK` into `process.env` *before* the codex child spawns (`src/main/index.ts:279-281`) so the agent's shell can `curl --unix-socket`. Routes: `GET /tabs`, `GET /targets`, `POST /eval` (arbitrary in-page JS), `POST /flow`, `POST /snapshot`, `POST /cdp` (operations: `capabilities`, `events`, `wait`, `traceStart`, `traceStop`, `snapshot`, `networkStart`, `network`, `networkBody`, `networkStop`, `performanceStart`, `performance`, `performanceStop`, `command`), `POST /tabs` (create/close/activate/navigate). No auth/origin checks by design (`browser-control-server.ts:8-18`).
- **CDP:** the main process drives tab pages via `webContents.debugger` (attach/sendCommand, `src/main/browser/cdp-session.ts:168-185`). No WebSocket servers exist (only a `WebSocketSummary` type for observed page traffic in `src/main/browser/network-journal.ts:27`).
- **Dynamic tool loop:** `thread/start` registers 9 dynamic tools — `browser_snapshot`, `browser_navigate`, `browser_screenshot`, `ui_review`, `browser_flow`, `browser_run`, `browser_extract_page`, `browser_cdp`, `research_web` (`browserDynamicTools`, `src/main/codex/codex-config.ts:400-448`). The child calls back via JSON-RPC `item/tool/call` → `routeDynamicToolCall` (`src/main/codex/dynamic-tool-router.ts`), executed in-main against `BrowserAgentController` / `ResearchRunner` (`codex-client.ts:500-515`).
- Threads are started with `approvalPolicy: 'never'`, `sandbox: 'danger-full-access'`, `historyMode: 'legacy'`, `developerInstructions: buildGuidance()` (`codex-client.ts:196-211`) — the app never surfaces approval requests.

### 2B. IPC surface

**Exact counts:** 61 channels in `ipcChannels` (`src/shared/ipc.ts:240-302`). Registration split: **54 `ipcMain.handle`** (33 in `src/main/index.ts:316-478`, 21 in `src/main/codex/codex-ipc.ts:36-93`), **2 `ipcMain.on`** (`browser:selectionCopy` `src/main/index.ts:336`, `browser:omniboxCommit` `src/main/browser/omnibox-popup.ts:32`), **5 push channels** sent via `webContents.send` (`codex:event` `codex-ipc.ts:33`; `browser:state` `index.ts:184`; `browser:findRequested` `browser-tab-view.ts:56`; `browser:focusOmnibox` `browser-tab-view.ts:63`; `browser:omniboxRender` `omnibox-popup.ts:171` — the last goes to the popup view, not the main renderer). 54+2+5 = 61.

**Window (3, invoke):** `window:minimize`, `window:toggleMaximize`, `window:close` — frameless-window controls.

**Browser (24):**
- Tab control (invoke): `browser:newTab`, `browser:closeTab`, `browser:activateTab`, `browser:navigate` (input passes through `describeNavigationInput`, which turns `javascript:`/`file:`/`data:` into searches, `index.ts:395-399`), `browser:back`, `browser:forward`, `browser:reload`, `browser:zoom`, `browser:toggleMute`.
- Find (invoke + push): `browser:find`, `browser:stopFind`, `browser:findRequested` (main→renderer on Ctrl/Cmd-F inside a page).
- Geometry (invoke): `browser:setBounds`, `browser:beginDividerDrag`, `browser:endDividerDrag`, `browser:setOverlayOpen` (hides the native view while a renderer modal is open).
- State (push): `browser:state` — full `BrowserState` snapshot on every tab change.
- Omnibox (invoke/on/push): `browser:omniboxQuery` (returns suggestions + inline completion, shows popup), `browser:omniboxSelect`, `browser:omniboxClose`, `browser:omniboxCommit` (popup→main click), `browser:omniboxRender` (main→popup rows), `browser:focusOmnibox` (main→renderer on Ctrl/Cmd-L).
- `browser:selectionCopy` (on) — auto-copy of drag-selected page text; sender validated with `tabManager.isUserVisibleWebContents` (`index.ts:336-339`).

**Clipboard (1, invoke):** `clipboard:write` (≤1,000,000 chars, `index.ts:330-335`).

**Codex (21):** `codex:getAuthStatus`, `codex:listModels`, `codex:listThreads`, `codex:startThread`, `codex:resumeThread`, `codex:readThread`, `codex:getGoal`, `codex:setGoal`, `codex:clearGoal`, `codex:sendMessage`, `codex:steerTurn`, `codex:interruptTurn`, `codex:compactThread`, `codex:unsubscribeThread`, `codex:listInstalledPlugins`, `codex:listPlugins`, `codex:readPlugin`, `codex:getPluginAppStatuses`, `codex:installPlugin`, `codex:uninstallPlugin` (all invoke, thin passthroughs to `CodexClient` methods in `codex-ipc.ts`), plus push `codex:event` carrying `CodexEvent = CodexStatusEvent | CodexNotificationEvent | CodexResearchProgressEvent` (`src/shared/ipc.ts:66-99`).

**Memory (1):** `memory:persist` → `MemoryStore.persist`. **Trace (3):** `trace:persist`, `trace:load` (→ `TurnTraceStore`), `trace:save` (save-dialog export). **Artifact (2):** `artifact:readImage`, `artifact:openImage` (CDP screenshot artifacts; open loads a data URL into a new browser tab). **Attachment (4):** `attachment:pick`, `attachment:save`, `attachment:preview`, `attachment:open`. **Notification (1):** `notification:backgroundTurn` (OS `Notification` only when window unfocused, `index.ts:433-451`). **Workspace (1):** `workspace:pick` (directory dialog).

**Preload API surface** (`src/preload/index.ts:39-166`, exposed as `window.api` via `contextBridge`): groups `runtime` (`instanceRole` 'host'|'verification', `sessionId` — from env, `index.ts:40-43`), `clipboard` (1 method), `window` (3), `browser` (21 methods, incl. 3 subscription helpers `onFindRequested`/`onFocusOmnibox`/`onState`), `codex` (21, incl. `onEvent`), `memory` (1), `trace` (3), `artifact` (2), `attachments` (4), `notifications` (1), `workspace` (1) — 58 functions total. The two other preloads: `src/preload/browser-page.ts` exposes **no** API (it installs trusted-gesture auto-copy: `isTrusted` + ≥4px drag required, `browser-page.ts:58-80`); `src/preload/omnibox-popup.ts` exposes `window.omniboxPopup = { onRender, commit }`.

### 2C. Main chat message flow, end to end

1. **Input:** the `Composer` component (`src/renderer/src/App.tsx:4378`) calls `onSend` → **`handleSend(text, attachments)`** (`App.tsx:785`). Guards: empty input, `isSending`, `activeTurnId`, `isMainChatTransitionLocked()`; image attachments rejected for non-image models (`App.tsx:789-795`). An optimistic user message is appended immediately (`buildOptimisticUserMessage`, `App.tsx:802-804`, from `optimistic-user-message.ts`).
2. **Thread start (if needed):** `window.api.codex.startThread({ cwd: workspace, model: selectedModel })` → `codex:startThread` → `CodexClient.startThread` (`codex-client.ts:196-211`) → JSON-RPC `thread/start`. The in-flight tab key is tracked in `mainThreadStartsInFlightRef` so an unowned `thread/started` notification cannot be misattributed (`App.tsx:809-811`, `App.tsx:2009-2014`).
3. **Turn start:** `window.api.codex.sendMessage(...)` (`preload/index.ts:108`) → handler at `codex-ipc.ts:49` (re-verifies attachments via `attachmentStore.verify`) → **`CodexClient.sendMessage`** (`codex-client.ts:261-308`): builds input via `localSkills.buildTurnInput`, resolves per-turn effort/summary via `resolveTurnPolicy` (`codex-config.ts`), then **`startTurnWithSummaryFallback`** → JSON-RPC **`turn/start`** (`codex-client.ts:315-329`, retries once without `summary` on `unsupported_parameter`). Write path: `AppServerRpc.request` → `AppServerProcess.write` → child stdin (`app-server-process.ts:51-54`).
4. **Streaming back:** child stdout line → `readline` → `AppServerRpc.handleLine` (`app-server-rpc.ts:113-155`) → `CodexClient.handleNotification` (`codex-client.ts:422-451`, also maintains `threadModels`/`threadTokenUsage` and auto-compaction at 80% of context window, `codex-client.ts:57, 467-478`) → `emit('event')` → `webContents.send('codex:event')` (`codex-ipc.ts:32-34`) → renderer subscription (`App.tsx:611`) → **`handleCodexNotification`** (`App.tsx:1966`).
5. **Routing by thread id** (`App.tsx:1971-1988`): notifications for a *background main-chat tab's* thread → `handleBackgroundMainChatNotification`; for a *dock agent's* thread → `handleAgentNotification`; otherwise the focused view. Item-level methods (`item/started`, `item/completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `item/mcpToolCall/progress`, `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, `item/reasoning/textDelta`, `item/plan/delta` — 10 methods, `src/renderer/src/item-notifications.ts:13-24`) go to **`handleMainItemNotification`** (`App.tsx:1632`). Turn-level: `turn/started` (`App.tsx:2060`, sets `activeTurnId`, telemetry via `noteTurn`, `adoptTurnItems` + `mergeItems`), `turn/completed` (`App.tsx:2099`, clears turn, schedules auto-recovery on failure), `thread/tokenUsage/updated` (`App.tsx:2128`).
6. **Delta batching:** streaming deltas funnel through `enqueueItemMutation` → one `requestAnimationFrame`-batched `flushPendingItemMutations` → single `setItems` per frame (`App.tsx:2438-2473`). File-change snapshots apply immediately (`isImmediateItemNotification`, `App.tsx:1652-1668`). Reducers live in `src/renderer/src/transcript-model.ts`: `appendAgentMessageDelta` (:126), `appendCommandOutputDelta` (:139), `replaceFileChanges` (:147), `appendReasoningDelta` (:162), `appendPlanDelta` (:193), `upsertMany`/`mergeChatItem` (:114/:202, longest-text-wins merges).
7. **Render:** `buildRows` (`transcript-model.ts:47-112`) groups items into `chat` / `activity` / `tail` rows → `ChatItemView` (memoized, `App.tsx:4079`), `TaskActivityCard` (`App.tsx:3202`, using `WorkGroup`/memoized `WorkBlock` from `src/renderer/src/TaskActivity.tsx:1105/1070`), and `TurnTail` (`TaskActivity.tsx:1258`), inside `ThreadScroll` (`App.tsx:3705`). Completed turns also persist a JSON trace (`window.api.trace.persist`, `App.tsx:495-525`) and chat memory (`window.api.memory.persist`, `App.tsx:527-556`).

### 2D. Tabbed multi-chat system (main chat tabs)

- **Model:** `MainChatTab = { key, threadId, title, model, reasoningEffort, status: 'idle'|'working'|'attention', turnId }` (`src/renderer/src/main-chat-tabs.ts:5-15`); hard cap `maxMainChatTabs = 12` (`main-chat-tabs.ts:3`).
- **Persistence:** localStorage key `codexdesktop.mainChatTabs.v1` (`App.tsx:116`), written on every tab-state change (`App.tsx:340-343`). Only `key/threadId/title/model/reasoningEffort` are serialized (`serializeMainChatTabState`, `main-chat-tabs.ts:113-124`); a legacy single-thread preference (`codexdesktop.lastThreadId`) and legacy model keys migrate in on parse (`parseMainChatTabState`, `main-chat-tabs.ts:45-111`, dedupes thread ids).
- **Per-tab isolated state:** thread id, title, transcript, model + reasoning effort ("Composer choices belong to the conversation, not the window", `main-chat-tabs.ts:9-11`), turn status, goal, context usage, compaction state. Runtime transcripts for non-active tabs live in `mainChatSnapshotsRef: Map<key, MainChatSnapshot>` (`App.tsx:298`), where `MainChatSnapshot` (`App.tsx:153-167`) holds `items`, `itemMeta`, `turnMeta`, `goal`, `contextUsage`, `activeCompaction`, `precedingModelInputByTurn`, `pendingCompactionByTurn`.
- **Switching:** `handleSelectMainChatTab` (`App.tsx:1069`) → `captureActiveMainChatSnapshot()` (`App.tsx:416-434`, flushes pending deltas first) then `applyMainChatSnapshot(target, snapshot)` (`App.tsx:436-477`) which swaps ~15 refs+states atomically. Uncached thread-backed tabs get a server resume (`needsMainChatTabHydration`, `main-chat-tabs.ts:162-167`); cached tabs do not, because open tabs stay subscribed and their snapshots receive every live notification via `handleBackgroundMainChatNotification` / `reduceBackgroundTurnSnapshot` (`App.tsx:1699+`) — a background tab can run a turn concurrently, flipping its tab chip to spinner/attention (`App.tsx:1958`).
- **Close:** `closeMainChatTab` (`main-chat-tabs.ts:126-150`) — closing the last tab replaces it with a fresh "New Chat" preserving the model choice.
- **Shared across tabs:** the single workspace/cwd (`codexdesktop.workspace` localStorage, `App.tsx:205-207, 479-485`), fast-mode flag, the one codex child process, the browser pane, and the thread-history list.
- **Startup:** active tab's thread resumes first (warms the codex child), then `restoreBackgroundMainChatTabs`, then the agent dock (`App.tsx:643-649`).

### 2E. Sub-agent dock (branch `stacked-subagents`)

**Execution context.** A sub-agent is *not* a separate window, renderer, or process. It is an in-renderer `AgentSession` object (`src/renderer/src/agent-session-model.ts:12-24`: `{ key, threadId, title, status: 'idle'|'working'|'done', turnId, messages: AgentLiteMessage[], watchesMain, model, reasoningEffort, contextUsage, isCompacting }`) whose turns run as a **separate codex thread on the same `codex app-server` child**.

**Spawn.** `handleNewAgent` (`src/renderer/src/useAgentSessions.ts:181-189`) creates the session (`Agent N` naming) and opens/selects its window. The codex thread is created lazily on first send in `handleAgentSend` (`src/renderer/src/agent-commands.ts:59-70`):

```ts
store.startQueueRef.current.push(key)
const started = await window.api.codex.startThread({
  cwd: options.getWorkspace(),
  model: agentModel
})
...
bindAgentThread(key, threadId)
```

The `startQueueRef` plus the main tabs' `mainThreadStartsInFlightRef` disambiguate unowned `thread/started` notifications (`App.tsx:1996-2014`).

**Shared with the parent:** the workspace/cwd (`getWorkspace: () => workspaceRef.current`, wired at `App.tsx:1483` — same directory as the main chat), the model catalog, fast mode, the same `thread/start` configuration (so identical sandbox `danger-full-access`, guidance, and the 9 browser/research dynamic tools — the shared `CodexClient.startThread` path, `codex-client.ts:196-211`), and the single embedded browser.

**Isolated:** conversation history (its own codex thread — main chat context is *not* shared by default), per-session model/effort override (falls back to the main composer's selection, `agent-commands.ts:49`), and its transcript rendering, which is a "lite" user/assistant text list — work items, diffs and reasoning are not rendered in agent windows.

**Opt-in context sharing:** toggling `watchesMain` ("Share main-chat context" menu item, `AgentDock.tsx:370-388`) makes each send prepend `buildMainChatContext()` (`App.tsx:1452-1469`) — a `<main-chat-context>` block containing the last 8 main-chat messages truncated to 600 chars each, helper-agent framing, and main-turn status; `stripMainChatContext` removes it for display on restore (`agent-session-model.ts:172-176`).

**Event routing:** `handleCodexNotification` routes any notification whose `threadId` matches a dock session to `handleAgentNotification` (`App.tsx:1978-1987` → `useAgentSessions.ts:101-179`), which handles `turn/started`, `turn/completed` (fires OS notification via `notification:backgroundTurn`, schedules auto-recovery on failure), `item/agentMessage/delta` (rAF-coalesced via `enqueueAgentDelta`/`applyAgentDeltas`, `useAgentSessions.ts:78-99` / `agent-session-model.ts:95-119`), `item/started`/`item/completed` (compaction + final message text), `thread/tokenUsage/updated`, and `error`. Auto-recovery (`src/renderer/src/agent-lifecycle.ts:52-117`): up to 3 attempts (`maxAutoRecoveryAttempts = 3`, `App.tsx:129`) with 10 s delay, switching to a fallback model from attempt 2 (`pickFallbackModel`, `App.tsx:1547`).

**Lifecycle verbs:** *close* interrupts the turn and unsubscribes the thread (`agent-lifecycle.ts:128-136`); *reset* clears the session to a fresh thread (`agent-lifecycle.ts:138-155`); *promote* ("Switch to main chat") resumes the agent's thread as the focused main conversation and removes the dock session (`handlePromoteAgent`, `agent-lifecycle.ts:157-170`); *minimize* collapses the window to a tab chip.

**Persistence & restore:** localStorage `codexdesktop.agentDock.v1` (`App.tsx:117`), serialized as `{ counter, sessions: [{ threadId, title, watchesMain, model, reasoningEffort, open, selected }] }` (`agent-session-model.ts:136-154`), debounced 250 ms (`useAgentSessions.ts:216-234`). Restore (`restoreAgentDock`, `src/renderer/src/agent-dock-restore.ts:35-124`) runs after main tabs, skips threads a main tab owns, registers sessions before resuming ("Register before resuming so incoming events route to the dock", `agent-dock-restore.ts:69`), calls `window.api.codex.resumeThread` per session and keeps only the last **4** messages (`messages.slice(-4)`, `agent-dock-restore.ts:107`).

**Dock rendering (no portal, no drag/resize).** `AgentColumn` is rendered inline inside the `.composer-dock` div of `ChatPane` (`App.tsx:3088-3108`); `AgentTabStrip` (minimized chips) sits in the composer-context row (`App.tsx:3122-3126`). The shell is an absolutely-positioned column pinned to the chat pane's bottom-right — `.agent-column-shell { position: absolute; bottom: 0; right: -22px; z-index: 8; width: min(400px, 75%); height: calc(100vh - 64px) }` (`src/renderer/src/styles.css:4960`). Agent windows are **fixed-size stacked cards** in a vertical scroll-snap column (`.agent-column { scroll-snap-type: y mandatory }`, each `.agent-overlay` `flex: 0 0 var(--agent-window-height)` with `--agent-window-height: max(calc(50% - 5px), 320px)`, glassy `backdrop-filter: blur(16px)` surface, `styles.css:4973+`). There is **no drag, resize, or free-docking logic anywhere in `AgentDock.tsx`** — overflow is handled by "N more agents above/below" chevron bars that snap-scroll one slot (`scrollByWindow`, `AgentDock.tsx:106-116`). Each `AgentWindow` (memoized with custom equality, `AgentDock.tsx:208, 591-600`) has: header (status icon, title menu with watch/promote/zoom 80–140% persisted per key in localStorage, minimize, close), lite transcript (assistant messages through `MarkdownContent`), a `ModelPill` + context-usage pill with click-to-compact, and its own composer (Enter sends; while `working`, typed text *steers* the running turn via `turn/steer` — same routing as the main composer, `AgentDock.tsx:318-322`, `agent-commands.ts:123-143`; drag-drop/paste image attachments supported).

## 3. AGENT & MODEL LAYER

### 3.A Model providers / APIs

**Single provider path: the OpenAI Codex CLI spawned as a JSON-RPC app-server.** The main process spawns `codex app-server --stdio` from `PATH`, inheriting `process.env` (`src/main/codex/app-server-process.ts:13-18`). Line-delimited JSON-RPC over stdio is handled by `AppServerRpc` (`src/main/codex/app-server-rpc.ts`, 179 lines) driven by `CodexClient` (`src/main/codex/codex-client.ts`, 524 lines). The child is spawned lazily on first use (`ensureStarted`, `app-server-process.ts:35-49`); on exit/error a status event is emitted and pending RPCs are rejected (`app-server-process.ts:74-87`). The codex binary is not vendored in the repo (no codex dependency in `package.json`); on this machine it resolves to `codex-cli 0.144.1` at `~/.nvm/versions/node/v24.13.1/bin/codex`.

**No Claude integration exists on this branch.** `src/main/claude/` does not exist in the current tree, and a case-insensitive search for "claude" across `src/` returns zero matches. Prior-version memory of `src/main/claude/claude-client.ts` describes code that is not present here.

**Model list** comes from the app-server's paginated `model/list` RPC (`codex-client.ts:93-114`): all pages are fetched, `hidden` models filtered out, and each visible model's `supportedReasoningEfforts` cached in `modelReasoningEfforts`. A renderer comment states this is the same list/default the CLI's own `/model` picker shows (`src/renderer/src/App.tsx:558-559`). The renderer loads it once codex status is `ready` and normalizes each chat tab's saved model/effort against the list, falling back to the server default (`App.tsx:561-608`).

**Model/effort selection UI** is `src/renderer/src/ModelPill.tsx` (296 lines), shared by the main composer and each dock-agent header (`ModelPill.tsx:6-8`). It renders a model dropdown (with a "CLI default" badge on `isDefault`, `ModelPill.tsx:200`), a per-model "Reasoning effort" submenu built from `supportedReasoningEfforts` (`ModelPill.tsx:228-266`; labels minimal/low/medium/high/xhigh("Extra High")/ultra, `ModelPill.tsx:273-282`), and a "Fast mode" toggle (`ModelPill.tsx:209-226`).

**Per-turn model/effort plumbing:** `sendMessage` sends `model` on every `turn/start` so resumed threads stay on the picker's selection (`codex-client.ts:290-298`), tracks per-thread model/effort in `threadModels`/`threadReasoningEfforts` maps, and updates `threadModels` on `model/rerouted` notifications (`codex-client.ts:429-430`). `resolveTurnPolicy` (`src/main/codex/codex-config.ts:69-92`) always requests `summary: 'concise'` and may downgrade effort: read-only browser microtasks get `none`→`low`→`minimal` (first supported), fast-mode fast-path tasks get `low`→`minimal`, gated by regex classifiers `isFastPathTask`/`isReadOnlyBrowserMicrotask` (`codex-config.ts:94-122`). Reasoning summary is omitted for models matching `/gpt-5\.3-codex-spark/i` (`codex-client.ts:310-313`), with a retry-without-summary fallback on `unsupported_parameter` errors (`codex-client.ts:315-341`).

**Thread configuration:** `thread/start` sends `approvalPolicy: 'never'`, `sandbox: 'danger-full-access'`, `historyMode: 'legacy'`, `config: { web_search: 'disabled' }`, the 9 `dynamicTools`, and `developerInstructions: buildGuidance()` (`codex-client.ts:196-211`; `newThreadConfig` at `codex-config.ts:57-59`). `thread/resume` sends `legacyResumeConfig` (`tools.web_search.context_size: 'low'`, `codex-config.ts:61-67`), `excludeTurns: true`, and `initialTurnsPage: { limit: 500, sortDirection: 'asc', itemsView: 'full' }` (`codex-client.ts:213-234`).

**Auth:** the app performs no credential handling of its own. It calls `getAuthStatus` with `includeToken: false, refreshToken: false` (`codex-client.ts:85-91`) once during init, only to surface failures as a system message (`App.tsx:638-640`). The response type is `{ authMethod: AuthMode | null, authToken, requiresOpenaiAuth }` with `AuthMode = "apikey" | "chatgpt" | "chatgptAuthTokens" | "agentIdentity" | "personalAccessToken" | "bedrockApiKey"` (`src/shared/codex-protocol/GetAuthStatusResponse.ts:6`, `AuthMode.ts:8`). Actual credentials live in the codex CLI's own state (`~/.codex` — not referenced anywhere in app source; unverified which mode is active). No `OPENAI_API_KEY`/API-key env handling exists in app code. The "ChatGPT" strings at `App.tsx:4884/4961/5051` belong to the plugin/connector OAuth flow (app installs), not model auth.

### 3.B Tool / function-calling system

Three tool surfaces exist: (1) 9 app-registered **dynamic tools**, (2) the codex CLI's **built-in tools**, (3) a **Unix-socket browser control API** the agent drives from its shell.

**Dynamic tools** are declared in `browserDynamicTools` (`codex-config.ts:397-452`), sent with every `thread/start`, and dispatched when the app-server issues an `item/tool/call` request (`codex-client.ts:492-493, 500-515` → `routeDynamicToolCall`, `src/main/codex/dynamic-tool-router.ts:8-140`). Results are returned as JSON in an `inputText` content item; screenshot tools append `inputImage` data URLs (`dynamic-tool-router.ts:124-130`). Any non-null namespace or unknown tool returns an error (`dynamic-tool-router.ts:21-22, 120-122`).

| Tool | What it does | Implementation |
|---|---|---|
| `browser_snapshot` | One-call navigate/wait/extract: objective-ranked items, UI state, evidence, timings from a visible tab | `src/main/browser/browser-agent.ts` (`snapshot`), program built in `src/main/browser/page-snapshot.ts` (1189 lines) |
| `browser_navigate` | Navigate an existing visible tab; returns when requested DOM state is usable (`readySelector`, `quietMs` default 350ms, `maxSettleMs` default 3000ms) | `browser-agent.ts` (`navigate`) via `src/main/browser/page-navigation.ts` |
| `browser_screenshot` | Capture visible viewport; image returned to model vision plus artifact metadata | `dynamic-tool-router.ts:23-34` → `browser-agent.ts` (`captureScreenshot`) |
| `ui_review` | Desktop(1440×900)/tablet(820×1180)/mobile(390×844) screenshots plus injected-JS audit of overflow, clipped content, headings, landmarks, touch targets, images, fonts, runtime exceptions, failed requests | `src/main/codex/ui-review.ts:72-137` |
| `browser_flow` | Declarative fill/click/submit/wait/find steps (1–24), navigation-aware; a missed `find` is successful `not_found` data | `browser-agent.ts` (`flow`) via `src/main/browser/browser-flow.ts` (552 lines) |
| `browser_run` | Bespoke JS in a page document (top-level await/return); `tab: 'all'`/`frame: 'all'` fan-out capped at 8 targets / 12 frames | `browser-agent.ts:180-220`, caps at `browser-agent.ts:18-19` |
| `browser_extract_page` | Bounded useful text after verifying page isn't a shell/login wall/challenge page | `browser-agent.ts` (`extractPage`) + `assessExtractedPage` in `research-utils.ts` |
| `browser_cdp` | Raw Chrome DevTools Protocol: 13 operations — `command`, `capabilities`, `events`, `wait`, `traceStart/Stop`, `snapshot` (DOM model), `networkStart/network/networkBody/networkStop`, `performanceStart/performance/performanceStop` | routed in `dynamic-tool-router.ts:142-186`; `src/main/browser/cdp-session.ts`, `dom-snapshot.ts`, `network-journal.ts`, `performance-diagnostics.ts` |
| `research_web` | Verify up to 8 direct URLs or discover via up to 3 queries; saves up to 3 verified public pages (static-HTML lane with 2s/750KB preflight before Chromium fallback); focus items return evidence passages and coverage gaps; hidden window, not the visible tab | `src/main/browser/research-runner.ts` (883 lines; constants at lines 35-53) |

Browser-tool bounds: default timeout 15,000ms, max 60,000ms; default result 8,000 chars, max 100,000, oversized results saved as artifacts (`browser-agent.ts:11-17`).

**Built-in codex tools** (executed inside the codex CLI, not the app): shell command execution, file changes (apply_patch), web search (disabled on new threads via `web_search: 'disabled'`; resumed legacy threads configure `context_size: 'low'`), MCP tool calls, collab-agent tool calls, image generation, image viewing, hook prompts — evidenced by the `ThreadItem` types the renderer attributes token usage to: `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `webSearch`, `imageView`, `imageGeneration`, `hookPrompt` (`src/renderer/src/turn-telemetry.ts:226-266`). No MCP servers are configured by the app itself (unverified whether the user's `~/.codex` config adds any).

**Unix-socket browser control** (`src/main/browser/browser-control-server.ts`): an HTTP server on `$CODEX_BROWSER_SOCK` (`/tmp/codex-browser-<pid>.sock`), published into env before the codex child spawns (`src/main/index.ts:278-284`). Routes: `GET /tabs`, `GET /targets`, `POST /eval` (raw JS body), `POST /flow`, `POST /snapshot`, `POST /cdp` (same 13 operations), `POST /tabs` (create/close/activate/navigate). Explicitly unauthenticated by design (`browser-control-server.ts:15-18`); it shares the same `BrowserAgentController` and per-tab queues as the dynamic tools.

**Server-request handling:** `item/tool/requestUserInput` is answered with empty `{answers: {}}`, `currentTime/read` with the epoch, and everything else (including stray approval requests) gets `-32601` (`codex-client.ts:480-498`).

**Skills:** the repo's `skills/` directory holds 10 skills (`artifact-first-web-research`, `build-polished-ui`, `imagegen`, `planning`, `prior-chat-memory`, `studio-hunt`, `studio-launch`, `studio-pulse`, `studio-scout`, `studio-validate`). `LocalSkillRegistry` registers the root via `skills/extraRoots/set` then filters `skills/list` to enabled skills inside that root (`src/main/codex/local-skill-registry.ts:31-60`), refreshing on `skills/changed` and plugin install/uninstall (`codex-client.ts:425-427, 186, 193`). Per-turn auto-attach (`selectTurnSkills`, `codex-config.ts:152-176`): `artifact-first-web-research` on web-research-classified text, `imagegen` on media-led UI tasks, `build-polished-ui` on polished-UI tasks; any skill attaches when the text contains `$<name>` (missing markers get prepended to the visible text, `codex-config.ts:183-190`). `prior-chat-memory` attaches only on a new thread whose first message matches continuation phrasing (`shouldAttachPriorChatMemory`, `codex-config.ts:141-150, 178-181`). Skills are sent as `{ type: 'skill', name, path }` `UserInput` items alongside text and attachments (`local-skill-registry.ts:62-77`).

### 3.C Context management

**History is server-side.** The app never assembles conversation history itself: threads live in the codex app-server (`thread/start`/`thread/resume` with `historyMode: 'legacy'`), and each turn sends only new `UserInput` items (`codex-client.ts:277, 291-298`). Per-thread injected context is limited to `developerInstructions` from `buildGuidance()` (`codex-config.ts:5-48`): ~5 task-shaping bullets, plus conditional blocks for autogit (`CODEX_DESKTOP_AUTOGIT_ACTIVE`) and self-hosted process protection (`CODEX_DESKTOP_SELF_HOSTED=1`, always set by `index.ts:46`).

**Compaction** is remote/server-side (documented at `codex-config.ts:50-55`: codex routes OpenAI providers to remote compaction unconditionally; not client-customizable). The app adds an auto-trigger: when the last model call's `totalTokens` ≥ 0.8 × `modelContextWindow` (`autoCompactContextRatio`, `codex-client.ts:57`), fired from `turn/completed` so it never races an in-flight turn, deduped per thread until token usage drops back under the threshold (`codex-client.ts:361-378, 453-478`). Manual compaction exists for the main chat (`App.tsx:977-986`) and dock agents (`agent-commands.ts:109-121`); compaction progress renders via `contextCompaction` items (`useAgentSessions.ts:142-155`). No local truncation of model context exists; the only local bounding is of tool results (8k-char default) and the resume bootstrap page (500 turns).

**Token accounting** is renderer-side telemetry only (display, not budget enforcement): `thread/tokenUsage/updated` notifications feed `reduceTurnTelemetry`/`accumulateTokenUsage` (`src/renderer/src/turn-telemetry.ts:112-224`), which keeps per-turn totals, latest-call usage, context-window percent, per-call samples capped at 128 (`turn-telemetry.ts:45`), and attributes each call's input delta to the preceding thread item (`turn-telemetry.ts:226-266`). `scripts/token-baseline.mjs` is a standalone benchmark harness that spawns its own app-server, runs ephemeral threads with a synthetic `benchmark_payload` dynamic tool, and writes a JSON comparison report (lines 10-60).

**Memory** is a two-file Markdown checkpoint, injected only via skill. After turns complete, the renderer builds a `MemorySnapshot` and calls `memory:persist` (active thread: `App.tsx:527-556`; background main tabs: `App.tsx:1779-1797`; deduped by fingerprint). `MemoryStore` atomically writes `userData/memory/chats/<threadId>.md` (full transcript with per-turn HTML markers) and `userData/memory/last-chat.md` (`src/main/memory-store.ts:18-33`). The checkpoint is bounded: 2 recent exchanges, 6 milestones, 120-char title, 800-char latest request, 2,400-char latest outcome (`src/main/memory-format.ts:16-21`); "completed work" lines are scored and capped at 2 (`src/renderer/src/memory-work.ts`). The directory path is exported as `CODEX_DESKTOP_MEMORY_DIR` (`index.ts:310-311`); the `prior-chat-memory` skill instructs the model to read `$CODEX_DESKTOP_MEMORY_DIR/last-chat.md` conditionally (`skills/prior-chat-memory/SKILL.md`). No memory content is ever injected directly into a turn by the app.

**Helper-agent context injection:** dock agents with `watchesMain` enabled get a `<main-chat-context>` digest prepended to each send — the last 8 main-chat messages truncated to 600 chars each, plus main-turn status (`App.tsx:1450-1469`, `agent-commands.ts:73`). Turn traces are additionally persisted to `userData/turn-traces` (`index.ts:314, 453-458`).

### 3.D Concurrency

**One shared app-server child, many concurrent threads.** All surfaces (main chat tabs, background main tabs, dock agent sessions) share the single `CodexClient`/child process; each surface owns its own codex `threadId`, and turns on different threads run concurrently. One-turn-per-thread is enforced only in the UI: the main composer blocks while `isSending || activeTurnId` (`App.tsx:789`), agent sessions track `status: 'working'`/`turnId` (`agent-commands.ts:83-87`), and recovery refuses to restart while `session.turnId` is set (`agent-lifecycle.ts:91`). There is no main-process turn queue or lock.

**Event fan-out is threadId-keyed in the renderer.** `CodexClient` emits every notification on a single `'event'` channel forwarded over one IPC channel to the main window (`src/main/codex/codex-ipc.ts:32-34`). The renderer's `handleCodexNotification` (`App.tsx:1966-1988`) routes: notifications for the watched/active thread (`isRelevantThread`, `App.tsx:1425-1428`, `watchThreadIdRef ?? activeThreadIdRef`) go to the full main reducers; other threadIds are matched first against background main-chat tabs (`mainChatTabForThread`) and then against dock sessions (`backgroundSessionForThread`, `src/renderer/src/agent-session-model.ts`), whose events feed a lite reducer (`handleAgentNotification`, `src/renderer/src/useAgentSessions.ts:101-179` — turn status, message deltas, compaction flags, token usage, errors). Unmatched `thread/started` ownership is disambiguated by two in-flight registries — `mainThreadStartsInFlightRef` and `agentStartQueueRef` — so an unowned start notification never hijacks the main view while a tab or dock start is pending (`App.tsx:1996-2014`).

**Queues and locks that do exist:**
- Per-tab serialization of all browser operations in `BrowserAgentController.tabQueues`; different tabs run in parallel, and a timed-out operation stays queued until Chromium settles it so the next program can't race a still-running page script (`browser-agent.ts:149-166, 207-208`). Parallel fan-out caps: 8 targets, 12 frames (`browser-agent.ts:18-19`).
- `ResearchRunner` caps concurrent runs at 2 with page-worker concurrency 3 (`research-runner.ts:44-45`), and `interruptTurn` cancels the research run keyed by `turnId` before interrupting the codex turn (`codex-client.ts:343-347`).
- `compactionsInFlight` per-thread dedupe set (`codex-client.ts:67, 361-378`).
- Renderer delta batching: agent-message deltas accumulate per session/item and flush once per animation frame (`useAgentSessions.ts:78-99`); dock state persists to localStorage debounced 250ms (`useAgentSessions.ts:216-234`).
- Failed agent turns auto-recover: up to `maxRecoveryAttempts` retries after a delay, switching to a fallback model from attempt 2, with per-turn dedupe (`agent-lifecycle.ts:52-117`).
- Closing/resetting a dock agent interrupts its running turn and calls `thread/unsubscribe` only if the main view doesn't own that thread (`agent-lifecycle.ts:128-155`); dock agents can be promoted into the main view via `thread/resume` (`agent-lifecycle.ts:157-170`). Background turn completion raises an OS notification when the window is unfocused (`index.ts:433-451`).

## 4. STATE & PERSISTENCE

### 4.1 Persistence inventory

All main-process stores live under Electron `userData` — on this Linux machine that resolves to `~/.config/codexdesktop/` (verified on disk; `sites-state.json`, `sites-artifacts/`, `image-attachments/`, and `memory/workspaces/` also exist there but have no references in current-branch source — leftovers from earlier versions). A dev/verify override exists: `CODEX_DESKTOP_USER_DATA` re-points `userData` before anything initializes (`src/main/index.ts:40-41`).

| Store | Medium | Path on disk | Written by |
|---|---|---|---|
| AttachmentStore | one file per attachment, name `<uuid>--<safeName>` | `userData/chat-attachments/` (`src/main/index.ts:83`) | `src/main/attachment-store.ts` |
| MemoryStore | Markdown files | `userData/memory/chats/<threadId>.md` + `userData/memory/last-chat.md` (`src/main/memory-store.ts:14-15`, dir set at `src/main/index.ts:310`) | renderer via IPC `memoryPersist` (`src/main/codex/codex-ipc.ts:91-92`; callers `src/renderer/src/App.tsx:550,1792`) |
| TurnTraceStore | one JSON file per turn | `userData/turn-traces/<threadId>/<turnId>.json` (`src/main/index.ts:314`, `src/main/turn-trace-store.ts:26-27`) | renderer via IPC `tracePersist` (`src/main/index.ts:453-457`; callers `src/renderer/src/App.tsx:518,1771`) |
| BrowserStateStore | single JSON file (session restore) | `userData/browser-state.json` (`src/main/browser/browser-state-store.ts:16`) | main, debounced 500 ms on tab events + sync flush on quit (`src/main/index.ts:88-129,246`) |
| BrowserHistoryStore | single JSON file (omnibox frecency) | `userData/browser-history.json` (`src/main/index.ts:87`) | main, debounced 1000 ms, max 2000 entries, http(s) only (`src/main/browser/browser-history-store.ts:11-12,136-139`) |
| CdpArtifactStore | one file per artifact (`screenshot-*/document-*/trace-*/snapshot-*/response-body-*/browser-result-*.<ext>`) | `userData/cdp-artifacts/` (`src/main/index.ts:82`) | browser agent / CDP tools; pruned at 7 days / 250 MB (`src/main/browser/cdp-artifact-store.ts:11-12,284-304`) |
| Research artifacts | directory per research run containing `<baseName>.txt` + `<baseName>.html` | `userData/research/<researchId>/` (`src/main/browser/research-runner.ts:247-248`, `src/main/browser/research-artifacts.ts:51-66`) | `research_web` tool; pruned at 7 days / 250 MB (`research-artifacts.ts:4-5,98-126`) |
| Embedded-browser Chromium profile | Chromium partition data (cookies, storage, service workers) | `userData/Partitions/codex-browser/` (verified on disk) via `partition: 'persist:codex-browser'` (`src/main/browser/browser-session.ts:6`) | Chromium |
| Renderer localStorage | Electron main-window localStorage | keys listed below | renderer |

**Renderer localStorage keys** (constants at `src/renderer/src/App.tsx:115-120` unless noted):
- `codexdesktop.mainChatTabs.v1` — JSON `{activeKey, tabs:[{key, threadId, title, model, reasoningEffort}]}`, max 12 tabs (`src/renderer/src/main-chat-tabs.ts:3,113-124`)
- `codexdesktop.agentDock.v1` — JSON `{counter, sessions:[{threadId, title, watchesMain, model, reasoningEffort, open, selected}]}`, persisted with 250 ms debounce (`src/renderer/src/agent-session-model.ts:136-154`, `src/renderer/src/useAgentSessions.ts:216-234`)
- `codexdesktop.lastThreadId` (legacy pre-tabs migration input, `main-chat-tabs.ts:94-103`), `codexdesktop.model`, `codexdesktop.reasoningEffort`, `codexdesktop.fastMode` (`'1'`/`'0'`), `codexdesktop.split` (pane split number, `App.tsx:171,771`), `codexdesktop.workspace` (`App.tsx:206,481`), `codexdesktop.agent-zoom.<sessionKey>` (`src/renderer/src/AgentDock.tsx:602`)

**File-format sketches:**
- `browser-state.json`: `{version:1, activeTabIndex, tabs:[{title, url, favicon, entries: NavigationEntry[], activeIndex}]}`, max 20 tabs (`src/main/browser/browser-state-types.ts:1-17`)
- `browser-history.json`: `{version:1, entries:[{url, title, visitCount, lastVisitAt}]}` (`browser-history-store.ts:4-9,131-133`)
- turn trace JSON: opaque content validated to be JSON ≤ 5 MB with `parsed.turn.id === turnId` (`turn-trace-store.ts:4,64-78`)
- `memory/last-chat.md`: markdown with `# <title>`, `Updated:`, `Workspace:`, `Source thread:`, `Full transcript:` header lines, `## Current state`, `## Earlier milestones` (last 2 turns verbatim-ish, up to 6 milestones) (`src/main/memory-format.ts:23-76`)

**Where conversations themselves live:** not in this app. Transcript persistence belongs to the external `codex app-server`; the app stores only thread IDs (localStorage) and rehydrates via JSON-RPC `thread/resume` with `excludeTurns: true` and an `initialTurnsPage` of up to 500 turns (`src/main/codex/codex-client.ts:213-234`). The server's rollout files exist on this machine at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<uuid>.jsonl` (verified on disk); no app source file reads `~/.codex` directly (grep over `src/` finds no reference).

### 4.2 What survives restart vs what doesn't

Survives:
- **Main chat tabs** (key/threadId/title/model/effort) via `codexdesktop.mainChatTabs.v1`; transcripts re-fetched from the app-server per tab (`main-chat-tabs.ts:162-167` gates hydration; `App.tsx:176-183`).
- **Agent-dock sub-agent sessions**: threadId/title/model/effort/open/selected restore, then each thread is resumed and only the **last 4 user/assistant messages** are rebuilt into the compact dock transcript (`src/renderer/src/agent-dock-restore.ts:78-109`, `messages.slice(-4)` at line 107). Sessions whose threadId now belongs to a main tab are dropped (`agent-dock-restore.ts:49-51`).
- **Embedded browser tabs**: up to 20 tabs with full per-tab navigation history and active index; active tab hydrates first, background tabs hydrate 2-at-a-time (`src/main/index.ts:294-306`, `src/main/browser/tab-manager.ts:82-104`). Written debounced and synchronously flushed in `before-quit` (`index.ts:246`).
- **Browser history**, **turn traces**, **memory markdown**, **attachments**, **CDP/research artifacts** (subject to their pruning limits), and **browser cookies/logins** (persistent partition).

Does not survive:
- Live turn state (status/turnId are reset to `'idle'`/`null` on both tab and dock restore: `main-chat-tabs.ts:42`, `agent-dock-restore.ts:58-59`), context-usage gauges, in-memory research caches (`ResearchMemoryCache`, `src/main/browser/research-artifacts.ts:12-49`), the CDP network/performance journals, agent-dock full transcripts beyond the 4-message tail, and per-session agent zoom entries keyed by the randomly regenerated session key (`agent-dock-restore.ts:55` mints a new `crypto.randomUUID()` key each restore, so old `codexdesktop.agent-zoom.*` keys orphan — behavior, not a claim of intent).

## 5. UI LAYER

- **Framework:** React 19.2.7 + react-dom 19.2.7, `react-markdown` 10.1.0 + `remark-gfm` 4.0.1 — the only runtime UI deps (`package.json`). No component library, no CSS framework; one hand-written stylesheet `src/renderer/src/styles.css` (~117 KB). Build: electron-vite ^5.0.0 / Vite ^7.3.6 / TypeScript ^7.0.2; three renderer entries (`index.html`, `landing.html`, `omnibox-popup.html`) and three preload entries (`electron.vite.config.ts`).
- **Root:** `src/renderer/src/main.tsx` → `App` (`App.tsx`, 5,125 lines — most UI components are defined in this file). Layout: `App` → `TitleBar` (`App.tsx:2576`; frameless-window controls, "Verification Instance" variant keyed off `window.api.runtime.instanceRole`) → `main.workspace` CSS grid `` `${split}% 8px 1fr` `` (`App.tsx:2499`; divider `dividerWidth = 8`, `minChatWidth = 280`, `minBrowserWidth = 420`, split persisted to `codexdesktop.split`) holding `ChatPane` | drag divider | `BrowserPane`.
- **Tab bar:** the main-chat tab strip is a `role="tablist"` header inside `ChatPane` (`.main-chat-tabbar`, `App.tsx:2641-2718`) with per-tab status glyphs (spinner for `working`, dot for `attention`), close buttons, a new-tab action, keyboard arrow navigation between tabs.
- **Main chat view:** `ChatPane` (`App.tsx:2726`) → `ThreadScroll` (`App.tsx:3705`; top-anchor pin-to-newest-user-message scroll model) rendering `buildRows` output as `ChatItemView` (memo, `App.tsx:4079`), `TaskActivityCard` (`App.tsx:3202`), `TurnTail` (`src/renderer/src/TaskActivity.tsx:1258`). `TaskActivity.tsx` (1,361 lines) supplies `WorkGroup`, memoized `WorkBlock`, `AutoFollow`, `CdpScreenshotPreview`; `TraceModal.tsx` shows persisted turn traces; `MarkdownContent.tsx` wraps react-markdown.
- **Input areas:** the main `Composer` (`App.tsx:4378`) with `AttachmentButton`/`AttachmentStrip` (`Attachments.tsx`), `ThreadMenu` history dropdown (`App.tsx:3281`), `WorkspacePill` (`App.tsx:4182`), `ModelPill` (`ModelPill.tsx`, shared with agent windows); each agent window carries its own composer (2E). Both composers steer a running turn instead of queueing a new one.
- **Sub-agent dock:** see 2E — inline stacked scroll-snap column in the chat pane, plus `AgentTabStrip` chips (`AgentDock.tsx`, 770 lines).
- **Browser pane:** `BrowserPane.tsx` renders only chrome — `TabStrip`, `BrowserToolbar` (omnibox input with inline autocomplete driven by `browser:omniboxQuery`), and an empty `.browser-view-host` div. The page itself is the native `WebContentsView` composited above the DOM; the renderer measures the host with a `ResizeObserver` and syncs bounds via `browser:setBounds` (`measureBrowserBounds`/`updateBrowserBounds`, `App.tsx:662-735`), hiding the view during divider drags and overlays.
- **Omnibox dropdown:** a separate native `WebContentsView` (`omnibox-popup.html` + `src/renderer/src/omnibox-popup.ts`) because renderer DOM cannot paint over the tab views; keyboard focus stays in the renderer's input while the popup only displays rows and reports clicks (`src/main/browser/omnibox-popup.ts:14-19`).
- **Landing page:** `landing.html` / `LandingPage.tsx` / `landing-main.tsx` is a bundled marketing page (download link to GitHub releases); nothing in `src/main` loads it (its consumption path is unverified — it is a standalone renderer entry).

## 6. INTEGRATIONS & PERIPHERY

### 6.1 External processes and services

- **codex CLI child process**: `spawn('codex', ['app-server', '--stdio'], { env: process.env })` — resolved from `PATH`, no version pinning in the repo (`src/main/codex/app-server-process.ts:13-18`; not in `package.json` dependencies). On this machine `PATH` resolves to `~/.nvm/versions/node/v24.13.1/bin/codex`, `codex-cli 0.144.1`. Communication is line-delimited JSON-RPC over stdio.
- **Embedded Chromium browser tabs**: `WebContentsView`-based tabs in the main window (`src/main/browser/browser-tab-view.ts:25-31`), managed by `src/main/browser/tab-manager.ts`; popups are real `BrowserWindow`s preserving the opener for OAuth (`src/main/browser/browser-popups.ts:36-43`). The Electron UA token is stripped so Google sign-in works (`browser-session.ts:8-11`).
- **browser-control-server**: HTTP over a **Unix domain socket**, not TCP — `os.tmpdir()/codex-browser-<pid>.sock` (`src/main/browser/browser-control-server.ts:29-32`), path exported to the agent as `CODEX_BROWSER_SOCK` (`src/main/index.ts:280`). Routes: `GET /tabs`, `GET /targets`, `POST /eval` (arbitrary in-page JS), `POST /flow`, `POST /snapshot`, `POST /cdp` (raw CDP), `POST /tabs` (create/close/activate/navigate). **No auth, no origin checks, explicitly by design** (`browser-control-server.ts:15-18`).
- **Shell/terminal execution**: the app itself spawns no shells; command execution happens inside the codex agent, which the app runs with `sandbox: 'danger-full-access'` (§6.3). The same browser tools are also exposed as codex dynamic tools (`browser_run`, `browser_flow`, `browser_snapshot`, `browser_cdp`, `research_web`, etc., `src/main/codex/codex-config.ts:397-452`) served via `item/tool/call` (`codex-client.ts:489-499`).
- **research_web fetching**: bounded static-HTML fetch lane plus hidden sandboxed `WebContentsView`s sharing the browser partition (`src/main/browser/research-runner.ts:718-726`).
- **scripts/ dev tooling** (one line each): `dev-with-autogit.mjs` — wraps `electron-vite dev` and starts the autosnapshot watcher; `git-autosnapshot.mjs` — watch-mode auto-committer (30 s git timeout, 10 MB untracked-file cap, skips `.env*` files at line 602); `verify-instance.mjs` — launches a disposable Electron instance with `CODEX_DESKTOP_USER_DATA` pointed at `tmpdir()/codexdesktop-verify-<uuid>` and `CODEX_DESKTOP_INSTANCE_ROLE: 'verification'` (lines 16-18); `source-shadow-guard.mjs` — detects/fixes stale sibling `.js` shadows of `.ts` sources in `src/main|preload|shared`; `browser-eval.mjs` — canonical browser-task eval harness; `token-baseline.mjs` — token-usage baseline measurement; `test-loader.mjs` — Node loader mapping `.js` specifiers back to `.ts` for strip-only tests.

### 6.2 Sandboxing / window policies

Every web surface uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`:
- Main window: preload `preload/index.cjs` (`src/main/index.ts:160-165`)
- Browser tabs: preload `preload/browser-page.cjs` + `partition: 'persist:codex-browser'` (`browser-tab-view.ts:25-31`); the guest-page preload only injects selection styling and a selection-copy IPC channel (`src/preload/browser-page.ts`, 84 lines)
- Popups: same prefs (`browser-popups.ts:36-43`); research views: same, no preload (`research-runner.ts:718-723`); omnibox popup: preload `omnibox-popup.cjs`, no partition (`src/main/browser/omnibox-popup.ts:121-126`)

Policies:
- `download-policy.ts` is only filename sanitization (`safeDownloadName`, strips paths/control chars); actual policy is in `browser-session.ts:36-66`: downloads from non-user-visible surfaces are blocked, otherwise paused behind a native save dialog defaulting to the OS downloads dir.
- Guest permissions: everything denied except `fullscreen` and `pointerLock` — geolocation, media, clipboard-read, `clipboard-sanitized-write`, MIDI/USB/serial all denied (`browser-session.ts:18-35`).
- `window-open-policy.ts:29-51`: `javascript:`/`file:` popups denied; `about:blank` scripted windows allowed as popups (opener kept for OAuth); plain `target="_blank"` http(s) links navigate the current tab; non-http(s) denied.
- `url-utils.ts`: address-bar input allows only `https?:`/`about:` schemes to navigate — any other scheme becomes a Google search (`describeNavigationInput`, lines 12-36); programmatic navigation (`normalizeNavigationInput`, lines 41-62) passes schemes through untouched, including `data:`.

### 6.3 Security-relevant facts

- **`.env` at repo root** (101 bytes, 2 lines): defines `BRAVE_API_KEY` and `TRUSTMRR_API_KEY` (values not reproduced). No source file, script, or vite config in the repo references either variable or loads `.env` (grep over `src/`, `scripts/`, `electron.vite.config.ts` finds nothing except `git-autosnapshot.mjs:602`, which excludes `.env*` from snapshots). Whether some external tool consumes them is unknown.
- **Codex auth**: delegated entirely to the codex CLI (`~/.codex/auth.json` exists on this machine, written by codex, never read by the app). The app only queries `getAuthStatus` with `includeToken: false, refreshToken: false` (`codex-client.ts:85-91`); response shape `{authMethod, authToken, requiresOpenaiAuth}` (`src/shared/codex-protocol/GetAuthStatusResponse.ts:6`).
- **Agent filesystem/command access**: every thread is started and resumed with `approvalPolicy: 'never'` and `sandbox: 'danger-full-access'` (`codex-client.ts:201-202,217-218`), i.e. the agent runs arbitrary commands with full user-level filesystem access and no approval prompts; the client denies any stray approval request the server might send (`codex-client.ts:480-499`). Thread cwd defaults to `$HOME` (`codex-client.ts:199`).
- **CSP**: renderer pages carry a meta CSP: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: http: https:` (`src/renderer/index.html:6`, same in `omnibox-popup.html:6`). Embedded remote pages have no injected CSP — isolation relies on the sandboxed, node-free, context-isolated partition.
- **browser-control-server exposure**: unauthenticated arbitrary JS/CDP/tab control, but reachable only via the Unix socket (filesystem permissions are the boundary; web pages cannot `fetch()` it, per the design comment at `browser-control-server.ts:15-18`). Socket path is per-PID; stale sockets are unlinked on start (`browser-control-server.ts:294-301`).
- **Host-process self-protection** is prompt-level only: `buildGuidance()` injects developer instructions telling the agent not to kill the host Electron/dev-server PIDs when `CODEX_DESKTOP_SELF_HOSTED=1` (`codex-config.ts:31-45`); nothing technically enforces it given `danger-full-access`.

