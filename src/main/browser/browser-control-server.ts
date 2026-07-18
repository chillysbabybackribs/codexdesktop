import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserAgentController } from './browser-agent.js'
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

function frameParam(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://x')
  return url.searchParams.get('frame')
}

function numberParam(req: IncomingMessage, name: string): number | null {
  const raw = new URL(req.url ?? '/', 'http://x').searchParams.get(name)
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://x').pathname
}

async function route(
  getTabs: TabsGetter,
  browserAgent: BrowserAgentController,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const path = pathOf(req)

  const tabs = getTabs()
  if (!tabs) {
    sendJson(res, 503, { ok: false, error: 'browser not ready (no window)' })
    return
  }

  try {
    if (req.method === 'GET' && path === '/tabs') {
      sendJson(res, 200, { ok: true, tabs: browserAgent.listTabs() })
      return
    }


    // Includes visible tabs and opener-preserving popup BrowserWindows.
    if (req.method === 'GET' && path === '/targets') {
      sendJson(res, 200, { ok: true, targets: browserAgent.listTargets() })
      return
    }

    if (req.method === 'POST' && path === '/eval') {
      const code = await readBody(req)
      if (!code.trim()) {
        sendJson(res, 400, { ok: false, error: 'empty body; POST JS as the request body' })
        return
      }
      sendJson(res, 200, await browserAgent.run(code, {
        tabId: tabParam(req),
        frame: frameParam(req),
        timeoutMs: numberParam(req, 'timeoutMs'),
        maxResultChars: numberParam(req, 'maxResultChars')
      }))
      return
    }

    if (req.method === 'POST' && path === '/snapshot') {
      const body = await readBody(req)
      let parsed: Record<string, unknown>
      try {
        parsed = asRecord(body ? JSON.parse(body) : {})
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be a JSON snapshot request' })
        return
      }
      const objective = typeof parsed.objective === 'string' ? parsed.objective : null
      if (!objective?.trim()) {
        sendJson(res, 400, { ok: false, error: 'snapshot requires "objective"' })
        return
      }
      sendJson(res, 200, await browserAgent.snapshot({
        objective,
        url: typeof parsed.url === 'string' ? parsed.url : null,
        tabId: typeof parsed.tab === 'string' ? parsed.tab : tabParam(req),
        frame: typeof parsed.frame === 'string' ? parsed.frame : frameParam(req),
        mode: parsed.mode === 'task' || parsed.mode === 'content' || parsed.mode === 'interactive' ? parsed.mode : null,
        order: parsed.order === 'reverse-document' ? 'reverse-document' : parsed.order === 'document' ? 'document' : null,
        selector: typeof parsed.selector === 'string' ? parsed.selector : null,
        maxItems: typeof parsed.maxItems === 'number' ? parsed.maxItems : null,
        readySelector: typeof parsed.readySelector === 'string' ? parsed.readySelector : null,
        timeoutMs: typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : numberParam(req, 'timeoutMs'),
        quietMs: typeof parsed.quietMs === 'number' ? parsed.quietMs : null,
        maxSettleMs: typeof parsed.maxSettleMs === 'number' ? parsed.maxSettleMs : null,
        maxResultChars: typeof parsed.maxResultChars === 'number' ? parsed.maxResultChars : numberParam(req, 'maxResultChars')
      }))
      return
    }

    if (req.method === 'POST' && path === '/cdp') {
      const body = await readBody(req)
      let parsed: {
        operation?: string
        method?: string
        params?: unknown
        tab?: string
        timeoutMs?: number
        maxResultChars?: number
        afterSequence?: number
        filter?: unknown
        contains?: unknown
        limit?: number
        requestId?: string
      }
      try {
        parsed = JSON.parse(body)
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be JSON {method, params, tab?}' })
        return
      }
      const operation = parsed.operation ?? 'command'
      const options = {
        tabId: parsed.tab ?? tabParam(req),
        timeoutMs: parsed.timeoutMs,
        maxResultChars: parsed.maxResultChars,
        afterSequence: parsed.afterSequence,
        filter: asRecord(parsed.filter),
        contains: stringRecord(parsed.contains),
        limit: parsed.limit
      }
      if (operation === 'capabilities') {
        sendJson(res, 200, await browserAgent.cdpCapabilities(options))
      } else if (operation === 'events') {
        sendJson(res, 200, await browserAgent.cdpEvents(options, parsed.method))
      } else if (operation === 'wait') {
        sendJson(res, 200, parsed.method
          ? await browserAgent.waitForCdpEvent(parsed.method, options)
          : { ok: false, error: 'wait requires "method" event name' })
      } else if (operation === 'traceStart') {
        sendJson(res, 200, await browserAgent.startCdpTrace(asRecord(parsed.params), options))
      } else if (operation === 'traceStop') {
        sendJson(res, 200, await browserAgent.stopCdpTrace(options))
      } else if (operation === 'snapshot') {
        sendJson(res, 200, await browserAgent.captureDomSnapshot(asRecord(parsed.params), options))
      } else if (operation === 'networkStart') {
        sendJson(res, 200, await browserAgent.startNetworkJournal(options))
      } else if (operation === 'network') {
        sendJson(res, 200, await browserAgent.readNetworkJournal(asRecord(parsed.params), options))
      } else if (operation === 'networkBody') {
        sendJson(res, 200, parsed.requestId
          ? await browserAgent.captureNetworkResponseBody(parsed.requestId, options)
          : { ok: false, error: 'networkBody requires "requestId"' })
      } else if (operation === 'networkStop') {
        sendJson(res, 200, await browserAgent.stopNetworkJournal(options))
      } else if (operation === 'performanceStart') {
        sendJson(res, 200, await browserAgent.startPerformanceDiagnostics(options))
      } else if (operation === 'performance') {
        sendJson(res, 200, await browserAgent.readPerformanceDiagnostics(options))
      } else if (operation === 'performanceStop') {
        sendJson(res, 200, await browserAgent.stopPerformanceDiagnostics(options))
      } else if (operation === 'command') {
        sendJson(res, 200, parsed.method
          ? await browserAgent.cdp(parsed.method, asRecord(parsed.params), options)
          : { ok: false, error: 'command requires "method"' })
      } else {
        sendJson(res, 400, { ok: false, error: `unsupported operation: ${operation}` })
      }
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(asRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

export function startBrowserControlServer(
  getTabs: TabsGetter,
  browserAgent = new BrowserAgentController(getTabs)
): Promise<BrowserControlServer> {
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
    void route(getTabs, browserAgent, req, res)
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
