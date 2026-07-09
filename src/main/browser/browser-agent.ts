import type { WebContents } from 'electron'
import type { TabManager } from './tab-manager.js'

export const DEFAULT_BROWSER_TIMEOUT_MS = 15_000
export const MAX_BROWSER_TIMEOUT_MS = 60_000
export const DEFAULT_BROWSER_RESULT_CHARS = 24_000
export const MAX_BROWSER_RESULT_CHARS = 100_000

export type BrowserAgentOptions = {
  tabId?: string | null
  timeoutMs?: number | null
  maxResultChars?: number | null
}

export type BrowserAgentResult = {
  ok: boolean
  result?: unknown
  error?: string
  tabId?: string
  url?: string
  title?: string
  durationMs?: number
  resultChars?: number
  truncated?: boolean
}

type BrowserAgentSuccess = BrowserAgentResult & {
  ok: true
  result: unknown
  tabId: string
  url: string
  title: string
  durationMs: number
  resultChars: number
  truncated: boolean
}

type BrowserAgentFailure = BrowserAgentResult & {
  ok: false
  error: string
}

type QueuedOperation<T> = Promise<T>

/**
 * Shared browser execution surface for Codex and the legacy Unix-socket API.
 * Operations on one tab are serialized; different tabs can still run in
 * parallel. A timed-out operation remains in the queue until Chromium settles
 * it, preventing the next program from racing a still-running page script.
 */
export class BrowserAgentController {
  private readonly tabQueues = new Map<string, Promise<void>>()
  private readonly getTabs: () => TabManager | null

  constructor(getTabs: () => TabManager | null) {
    this.getTabs = getTabs
  }

  listTabs(): ReturnType<TabManager['listTabs']> {
    return this.getTabs()?.listTabs() ?? []
  }

  async run(code: string, options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    if (!code.trim()) {
      return { ok: false, error: 'browser.run requires non-empty JavaScript' } satisfies BrowserAgentFailure
    }

    const tabs = this.getTabs()
    if (!tabs) {
      return { ok: false, error: 'browser not ready (no window)' } satisfies BrowserAgentFailure
    }

    const tabId = options.tabId ?? tabs.getActiveTabId()
    if (!tabId) {
      return { ok: false, error: 'no active tab' } satisfies BrowserAgentFailure
    }

    const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_BROWSER_TIMEOUT_MS, 250, MAX_BROWSER_TIMEOUT_MS)
    const maxResultChars = clampNumber(
      options.maxResultChars,
      DEFAULT_BROWSER_RESULT_CHARS,
      1_000,
      MAX_BROWSER_RESULT_CHARS
    )

    const previous = this.tabQueues.get(tabId) ?? Promise.resolve()
    const operation: QueuedOperation<BrowserAgentResult> = previous.then(async () => {
      const webContents = tabs.resolveWebContents(tabId)
      if (!webContents) {
        return { ok: false, error: `no tab with id ${tabId}` } satisfies BrowserAgentFailure
      }

      const startedAt = Date.now()
      const execution = executePageProgram(webContents, code)

      try {
        const rawResult = await execution
        const bounded = boundResult(rawResult, maxResultChars)
        return {
          ok: true,
          result: bounded.value,
          tabId,
          url: safeUrl(webContents),
          title: safeTitle(webContents),
          durationMs: Date.now() - startedAt,
          resultChars: bounded.chars,
          truncated: bounded.truncated
        } satisfies BrowserAgentSuccess
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          tabId,
          url: safeUrl(webContents),
          title: safeTitle(webContents),
          durationMs: Date.now() - startedAt
        } satisfies BrowserAgentFailure
      }
    })

    const queueTail = operation.then(
      () => undefined,
      () => undefined
    )
    this.tabQueues.set(tabId, queueTail)
    void queueTail.then(() => {
      if (this.tabQueues.get(tabId) === queueTail) {
        this.tabQueues.delete(tabId)
      }
    })

    try {
      return await withTimeout(operation, timeoutMs)
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        tabId
      } satisfies BrowserAgentFailure
    }
  }

  async extractPage(options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    const maxResultChars = clampNumber(
      options.maxResultChars,
      DEFAULT_BROWSER_RESULT_CHARS,
      1_000,
      MAX_BROWSER_RESULT_CHARS
    )

    // Leave room for the structured extraction envelope when bounding the
    // page body, so the result remains JSON rather than becoming a partial
    // serialization of the whole envelope.
    const contentMaxChars = Math.max(1_000, maxResultChars - 1_000)

    return this.run(buildPageExtractionProgram(contentMaxChars), {
      ...options,
      maxResultChars
    })
  }
}

export function buildPageExtractionProgram(maxChars: number): string {
  const safeMaxChars = clampNumber(maxChars, DEFAULT_BROWSER_RESULT_CHARS, 1_000, MAX_BROWSER_RESULT_CHARS)

  // This is deliberately a deterministic, page-local extraction pipeline:
  // choose the most article-like root, remove non-content components, render
  // semantic blocks, then deduplicate and bound the returned text.
  return `
  const maxChars = ${safeMaxChars};
  const pageUrl = location.href;
  const title = document.title.trim();
  const body = document.body;
  if (!body) return { title, url: pageUrl, content: '', wordCount: 0, truncated: false, reason: 'page has no body' };

  const clone = body.cloneNode(true);
  const removeSelectors = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'img', 'picture',
    'video', 'audio', 'iframe', 'object', 'embed', 'source', 'track', 'form',
    'input', 'button', 'select', 'textarea', 'nav', 'header', 'footer', 'aside',
    '[hidden]', '[aria-hidden="true"]', '[role="navigation"]', '[role="banner"]',
    '[role="contentinfo"]', '[role="complementary"]', '[role="dialog"]',
    '[role="menu"]', '[role="toolbar"]'
  ];
  clone.querySelectorAll(removeSelectors.join(',')).forEach((node) => node.remove());

  const lowValuePattern = /(advert|^ad$|banner|cookie|consent|modal|dialog|popup|newsletter|subscribe|social|share|related|recommend|breadcrumb|pagination|sidebar|toolbar|menu|promo|sponsor|comment)/i;
  clone.querySelectorAll('*').forEach((node) => {
    const label = ((node.id || '') + ' ' + (typeof node.className === 'string' ? node.className : '')).trim();
    if (label && lowValuePattern.test(label)) node.remove();
  });

  const candidates = [
    ...clone.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"]'),
    clone
  ];
  const score = (node) => {
    const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text.length < 160) return -1;
    const links = [...node.querySelectorAll('a')].reduce((total, link) => total + (link.textContent || '').length, 0);
    const paragraphs = node.querySelectorAll('p').length;
    return text.length + paragraphs * 220 - links * 1.8;
  };
  const root = candidates.reduce((best, node) => score(node) > score(best) ? node : best, clone);

  const blockTags = new Set(['ADDRESS', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL']);
  const headingTags = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const render = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node;
    if (element.matches('img, picture, svg, canvas, video, audio, iframe, object, embed')) return '';
    const children = [...element.childNodes].map(render).join('');
    const text = children.replace(/[ \\t]+/g, ' ').trim();
    if (!text) return '';
    if (headingTags.has(element.tagName)) return '\\n\\n' + '#'.repeat(Number(element.tagName.slice(1))) + ' ' + text + '\\n\\n';
    if (element.tagName === 'LI') return '\\n- ' + text + '\\n';
    if (element.tagName === 'TR') return '\\n' + text.replace(/\\s*\\n\\s*/g, ' | ') + '\\n';
    return blockTags.has(element.tagName) ? '\\n' + text + '\\n' : text;
  };

  const rawLines = render(root)
    .split(/\\n+/)
    .map((line) => line.replace(/\\s+/g, ' ').trim())
    .filter(Boolean);
  const lines = [];
  for (const line of rawLines) {
    if (line.length < 3) continue;
    if (/^(accept cookies|reject cookies|skip to content|advertisement|sign in|log in|subscribe|share)$/i.test(line)) continue;
    if (line !== lines[lines.length - 1]) lines.push(line);
  }
  const content = lines.join('\\n\\n');
  const bounded = content.length > maxChars ? content.slice(0, maxChars).replace(/\\s+\\S*$/, '') : content;
  return {
    title,
    url: pageUrl,
    content: bounded,
    wordCount: bounded ? bounded.split(/\\s+/).length : 0,
    truncated: bounded.length < content.length,
    removedImages: true,
    removedComponents: true
  };
`
}

async function executePageProgram(webContents: WebContents, code: string): Promise<unknown> {
  const wrapped = `(async () => { ${code}\n})()`
  return webContents.executeJavaScript(wrapped, true)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`browser operation timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function boundResult(value: unknown, maxChars: number): { value: unknown; chars: number; truncated: boolean } {
  let serialized: string

  try {
    serialized = JSON.stringify(value) ?? 'null'
  } catch (error) {
    throw new Error(`browser result is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (serialized.length <= maxChars) {
    return { value, chars: serialized.length, truncated: false }
  }

  return {
    value: serialized.slice(0, maxChars).replace(/\s+\S*$/, ''),
    chars: serialized.length,
    truncated: true
  }
}

function clampNumber(value: number | null | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function safeUrl(webContents: WebContents): string {
  try {
    return webContents.getURL()
  } catch {
    return ''
  }
}

function safeTitle(webContents: WebContents): string {
  try {
    return webContents.getTitle()
  } catch {
    return ''
  }
}
