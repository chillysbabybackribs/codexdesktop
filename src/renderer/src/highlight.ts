// Lazy singleton Shiki highlighter for chat code fences and diff cards.
//
// The highlighter (and each grammar) loads asynchronously the first time it is
// needed; until then callers render plain text and re-render when the version
// bumps. Rendering stays synchronous — components read tokens from the loaded
// highlighter inside useMemo, subscribed via useSyncExternalStore.
import { useMemo, useSyncExternalStore } from 'react'
import {
  bundledLanguages,
  createHighlighter,
  type Highlighter,
  type ThemedToken
} from 'shiki'

export type { ThemedToken } from 'shiki'

// VS Code's Dark+ grammar colors — the same token palette Cursor inherits.
const THEME = 'dark-plus'

// Grammars loaded with the highlighter itself. Anything else in Shiki's web
// bundle is fetched on demand the first time a fence/diff mentions it.
const PRELOAD_LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'css',
  'html',
  'bash',
  'python',
  'markdown',
  'yaml',
  'diff'
]

let highlighter: Highlighter | null = null
let loadStarted = false
let version = 0
const pendingLangs = new Set<string>()
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

function ensureHighlighter(): void {
  if (loadStarted) {
    return
  }
  loadStarted = true
  void createHighlighter({ themes: [THEME], langs: PRELOAD_LANGS })
    .then((instance) => {
      highlighter = instance
      notify()
    })
    .catch(() => {
      // Highlighting is progressive enhancement — plain text remains.
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getVersion(): number {
  return version
}

/** Normalize a fence/language tag to a Shiki bundled-language id, or null. */
export function resolveLang(lang: string | null | undefined): string | null {
  if (!lang) {
    return null
  }
  const norm = lang.toLowerCase()
  return norm in bundledLanguages ? norm : null
}

const extLangMap: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  md: 'markdown',
  mdx: 'mdx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  xml: 'xml',
  svg: 'xml',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  dockerfile: 'docker',
  prisma: 'prisma',
  lua: 'lua',
  zig: 'zig'
}

/** Infer a highlight language from a file path (for diff cards). */
export function langForPath(path: string): string | null {
  const name = path.split('/').pop() ?? path
  if (name.toLowerCase() === 'dockerfile') {
    return 'docker'
  }
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : null
  const lang = ext ? extLangMap[ext] : null
  return lang && lang in bundledLanguages ? lang : null
}

/**
 * Tokenize synchronously if the highlighter + grammar are ready; otherwise
 * kick off the load and return null (caller renders plain text and will be
 * re-rendered by the version bump when ready).
 */
export function tokenizeSync(code: string, lang: string): ThemedToken[][] | null {
  ensureHighlighter()
  if (!highlighter) {
    return null
  }
  if (!highlighter.getLoadedLanguages().includes(lang)) {
    if (!pendingLangs.has(lang)) {
      pendingLangs.add(lang)
      void highlighter
        .loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0])
        .then(notify)
        .catch(() => {})
    }
    return null
  }
  try {
    return highlighter.codeToTokensBase(code, {
      lang: lang as Parameters<Highlighter['codeToTokensBase']>[1]['lang'],
      theme: THEME
    })
  } catch {
    return null
  }
}

/** Tokens for a whole code block (markdown fences). Null → render plain. */
export function useHighlightTokens(code: string, lang: string | null): ThemedToken[][] | null {
  const v = useSyncExternalStore(subscribe, getVersion)
  return useMemo(() => {
    void v
    return lang ? tokenizeSync(code, lang) : null
  }, [code, lang, v])
}

/**
 * Per-line tokens for diff cards. Each line is tokenized independently (diff
 * lines interleave add/del/context, so cross-line grammar state is already
 * broken); null entries — and a null result — mean plain text.
 */
export function useLineTokens(
  lines: readonly { kind: string; text: string }[],
  lang: string | null,
  enabled: boolean
): (ThemedToken[] | null)[] | null {
  const v = useSyncExternalStore(subscribe, getVersion)
  return useMemo(() => {
    void v
    if (!enabled || !lang) {
      return null
    }
    let any = false
    const result = lines.map((line) => {
      if (line.kind === 'hunk' || !line.text) {
        return null
      }
      const tokens = tokenizeSync(line.text, lang)?.[0] ?? null
      if (tokens) {
        any = true
      }
      return tokens
    })
    return any ? result : null
  }, [lines, lang, enabled, v])
}
