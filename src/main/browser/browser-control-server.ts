import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TabManager } from './tab-manager.js'

// A localhost control surface for the Codex agent, bound to a Unix domain
// socket (not a TCP port) so the agent's shell can drive the *visible* browser
// with code it writes per task — no fixed MCP tool wall, no standing context.
//
// The agent reaches it with plain shell:
//   curl -s --unix-socket "$CODEX_BROWSER_SOCK" http://x/eval --data-binary '<js>'
//
// This is unrestricted BY DESIGN: arbitrary in-page JS + raw CDP + tab control,
// no auth, no origin checks, no confirmations. It's the user's own machine,
// agent, and browser. A Unix socket keeps it off TCP so random web pages can't
// fetch() it, which is ergonomics/hygiene, not a gate.

export type BrowserControlServer = {
  socketPath: string
  close: () => Promise<void>
}

// The server is bound to a getter, not a snapshot, because the TabManager is
// torn down and recreated when the window closes/reopens. A dead getter → 503.
type TabsGetter = () => TabManager | null

function socketPath(): string {
  // Per-pid so concurrent app instances don't collide on the same path.
  return join(tmpdir(), `codex-browser-${process.pid}.sock`)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

// Run arbitrary JS in the target tab's page and return whatever it evaluates to.
// executeJavaScript(code, true) runs with a user gesture and awaits a returned
// promise, so the agent can do the whole operation — fill+submit+read-back — in
// one call and get the resulting state in the same response.
async function handleEval(tabs: TabManager, tabId: string | null, code: string): Promise<unknown> {
  const wc = tabs.resolveWebContents(tabId)
  if (!wc) {
    return { ok: false, error: tabId ? `no tab with id ${tabId}` : 'no active tab' }
  }
  try {
    const result = await wc.executeJavaScript(code, true)
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Forward a raw Chrome DevTools Protocol command to the tab. This is the escape
// hatch for what in-page JS can't do: trusted input events (canvas/anti-bot),
// network interception, real load-idle waits, screenshots/PDF.
async function handleCdp(
  tabs: TabManager,
  tabId: string | null,
  method: string,
  params: unknown
): Promise<unknown> {
  const wc = tabs.resolveWebContents(tabId)
  if (!wc) {
    return { ok: false, error: tabId ? `no tab with id ${tabId}` : 'no active tab' }
  }
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3')
    }
    const result = await wc.debugger.sendCommand(method, (params ?? {}) as object)
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function handleTabsAction(tabs: TabManager, body: string): Promise<unknown> {
  let parsed: { action?: string; url?: string; input?: string; tab?: string }
  try {
    parsed = body ? JSON.parse(body) : {}
  } catch {
    return { ok: false, error: 'body must be JSON' }
  }

  switch (parsed.action) {
    case 'create': {
      const id = tabs.createTab(parsed.url)
      return { ok: true, id }
    }
    case 'close':
      if (!parsed.tab) return { ok: false, error: 'close requires "tab"' }
      tabs.closeTab(parsed.tab)
      return { ok: true }
    case 'activate':
      if (!parsed.tab) return { ok: false, error: 'activate requires "tab"' }
      tabs.activateTab(parsed.tab)
      return { ok: true }
    case 'navigate': {
      const target = parsed.tab ?? tabs.getActiveTabId()
      const input = parsed.input ?? parsed.url
      if (!target) return { ok: false, error: 'no active tab to navigate' }
      if (!input) return { ok: false, error: 'navigate requires "input" or "url"' }
      tabs.navigate(target, input)
      return { ok: true }
    }
    default:
      return { ok: false, error: `unknown tabs action: ${parsed.action ?? '(none)'}` }
  }
}

function tabParam(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://x')
  return url.searchParams.get('tab')
}

function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://x').pathname
}

async function route(getTabs: TabsGetter, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req)

  const tabs = getTabs()
  if (!tabs) {
    sendJson(res, 503, { ok: false, error: 'browser not ready (no window)' })
    return
  }

  try {
    if (req.method === 'GET' && path === '/tabs') {
      sendJson(res, 200, { ok: true, tabs: tabs.listTabs() })
      return
    }

    if (req.method === 'POST' && path === '/eval') {
      const code = await readBody(req)
      if (!code.trim()) {
        sendJson(res, 400, { ok: false, error: 'empty body; POST JS as the request body' })
        return
      }
      sendJson(res, 200, await handleEval(tabs, tabParam(req), code))
      return
    }

    if (req.method === 'POST' && path === '/cdp') {
      const body = await readBody(req)
      let parsed: { method?: string; params?: unknown; tab?: string }
      try {
        parsed = JSON.parse(body)
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be JSON {method, params, tab?}' })
        return
      }
      if (!parsed.method) {
        sendJson(res, 400, { ok: false, error: '"method" is required' })
        return
      }
      sendJson(res, 200, await handleCdp(tabs, parsed.tab ?? tabParam(req), parsed.method, parsed.params))
      return
    }

    if (req.method === 'POST' && path === '/tabs') {
      sendJson(res, 200, await handleTabsAction(tabs, await readBody(req)))
      return
    }

    sendJson(res, 404, { ok: false, error: `no route: ${req.method} ${path}` })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

export function startBrowserControlServer(getTabs: TabsGetter): Promise<BrowserControlServer> {
  const path = socketPath()

  // A stale socket file from a hard crash would make listen() fail with EADDRINUSE.
  if (existsSync(path)) {
    try {
      unlinkSync(path)
    } catch {
      // If we can't remove it, listen() will surface the real error below.
    }
  }

  const server: Server = createServer((req, res) => {
    void route(getTabs, req, res)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.removeListener('error', reject)
      resolve({
        socketPath: path,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              if (existsSync(path)) {
                try {
                  unlinkSync(path)
                } catch {
                  // best-effort cleanup
                }
              }
              res()
            })
          })
      })
    })
  })
}
