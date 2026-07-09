import { createServer } from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function socketPath() {
    // Per-pid so concurrent app instances don't collide on the same path.
    return join(tmpdir(), `codex-browser-${process.pid}.sock`);
}
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
}
// Run arbitrary JS in the target tab's page and return whatever it evaluates to.
// executeJavaScript(code, true) runs with a user gesture and awaits a returned
// promise, so the agent can do the whole operation — fill+submit+read-back — in
// one call and get the resulting state in the same response.
async function handleEval(tabs, tabId, code) {
    const wc = tabs.resolveWebContents(tabId);
    if (!wc) {
        return { ok: false, error: tabId ? `no tab with id ${tabId}` : 'no active tab' };
    }
    try {
        const result = await wc.executeJavaScript(code, true);
        return { ok: true, result };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
// Forward a raw Chrome DevTools Protocol command to the tab. This is the escape
// hatch for what in-page JS can't do: trusted input events (canvas/anti-bot),
// network interception, real load-idle waits, screenshots/PDF.
async function handleCdp(tabs, tabId, method, params) {
    const wc = tabs.resolveWebContents(tabId);
    if (!wc) {
        return { ok: false, error: tabId ? `no tab with id ${tabId}` : 'no active tab' };
    }
    try {
        if (!wc.debugger.isAttached()) {
            wc.debugger.attach('1.3');
        }
        const result = await wc.debugger.sendCommand(method, (params ?? {}));
        return { ok: true, result };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
async function handleTabsAction(tabs, body) {
    let parsed;
    try {
        parsed = body ? JSON.parse(body) : {};
    }
    catch {
        return { ok: false, error: 'body must be JSON' };
    }
    switch (parsed.action) {
        case 'create': {
            const id = tabs.createTab(parsed.url);
            return { ok: true, id };
        }
        case 'close':
            if (!parsed.tab)
                return { ok: false, error: 'close requires "tab"' };
            tabs.closeTab(parsed.tab);
            return { ok: true };
        case 'activate':
            if (!parsed.tab)
                return { ok: false, error: 'activate requires "tab"' };
            tabs.activateTab(parsed.tab);
            return { ok: true };
        case 'navigate': {
            const target = parsed.tab ?? tabs.getActiveTabId();
            const input = parsed.input ?? parsed.url;
            if (!target)
                return { ok: false, error: 'no active tab to navigate' };
            if (!input)
                return { ok: false, error: 'navigate requires "input" or "url"' };
            tabs.navigate(target, input);
            return { ok: true };
        }
        default:
            return { ok: false, error: `unknown tabs action: ${parsed.action ?? '(none)'}` };
    }
}
function tabParam(req) {
    const url = new URL(req.url ?? '/', 'http://x');
    return url.searchParams.get('tab');
}
function pathOf(req) {
    return new URL(req.url ?? '/', 'http://x').pathname;
}
async function route(getTabs, req, res) {
    const path = pathOf(req);
    const tabs = getTabs();
    if (!tabs) {
        sendJson(res, 503, { ok: false, error: 'browser not ready (no window)' });
        return;
    }
    try {
        if (req.method === 'GET' && path === '/tabs') {
            sendJson(res, 200, { ok: true, tabs: tabs.listTabs() });
            return;
        }
        if (req.method === 'POST' && path === '/eval') {
            const code = await readBody(req);
            if (!code.trim()) {
                sendJson(res, 400, { ok: false, error: 'empty body; POST JS as the request body' });
                return;
            }
            sendJson(res, 200, await handleEval(tabs, tabParam(req), code));
            return;
        }
        if (req.method === 'POST' && path === '/cdp') {
            const body = await readBody(req);
            let parsed;
            try {
                parsed = JSON.parse(body);
            }
            catch {
                sendJson(res, 400, { ok: false, error: 'body must be JSON {method, params, tab?}' });
                return;
            }
            if (!parsed.method) {
                sendJson(res, 400, { ok: false, error: '"method" is required' });
                return;
            }
            sendJson(res, 200, await handleCdp(tabs, parsed.tab ?? tabParam(req), parsed.method, parsed.params));
            return;
        }
        if (req.method === 'POST' && path === '/tabs') {
            sendJson(res, 200, await handleTabsAction(tabs, await readBody(req)));
            return;
        }
        sendJson(res, 404, { ok: false, error: `no route: ${req.method} ${path}` });
    }
    catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}
export function startBrowserControlServer(getTabs) {
    const path = socketPath();
    // A stale socket file from a hard crash would make listen() fail with EADDRINUSE.
    if (existsSync(path)) {
        try {
            unlinkSync(path);
        }
        catch {
            // If we can't remove it, listen() will surface the real error below.
        }
    }
    const server = createServer((req, res) => {
        void route(getTabs, req, res);
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => {
            server.removeListener('error', reject);
            resolve({
                socketPath: path,
                close: () => new Promise((res) => {
                    server.close(() => {
                        if (existsSync(path)) {
                            try {
                                unlinkSync(path);
                            }
                            catch {
                                // best-effort cleanup
                            }
                        }
                        res();
                    });
                })
            });
        });
    });
}
