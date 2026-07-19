import type { CommandAction } from '../../shared/session-protocol'

// Natural-language narration for shell commands — the verbosity dial for the
// running-task UI. Three sources, best first: the Claude Bash tool's model-
// written `description`, Codex's server-parsed commandActions, then local
// heuristics over the raw command line. When nothing classifies, the caller
// gets the cleaned command back (wrapper-stripped, one line) flagged
// `natural: false` so it can keep rendering it as code instead of prose.
//
// Pure and renderer-only: presentation never feeds back into prompts, so the
// audit briefing and trace keep the raw commands.

export type CommandNarration = {
  // Present-progressive form, for in-flight rows ("Checking git status").
  running: string
  // Past form, for settled rows ("Checked git status").
  done: string
  // True when the text is real prose; false when it is the cleaned command.
  natural: boolean
}

type VerbKey =
  | 'run'
  | 'check'
  | 'view'
  | 'search'
  | 'read'
  | 'list'
  | 'count'
  | 'install'
  | 'build'
  | 'test'
  | 'typecheck'
  | 'lint'
  | 'format'
  | 'edit'
  | 'write'
  | 'create'
  | 'copy'
  | 'move'
  | 'remove'
  | 'fetch'
  | 'stage'
  | 'commit'
  | 'push'
  | 'pull'
  | 'switch'
  | 'reset'
  | 'stop'
  | 'compare'
  | 'wait'

const VERBS: Record<VerbKey, [running: string, done: string]> = {
  run: ['Running', 'Ran'],
  check: ['Checking', 'Checked'],
  view: ['Viewing', 'Viewed'],
  search: ['Searching', 'Searched'],
  read: ['Reading', 'Read'],
  list: ['Listing', 'Listed'],
  count: ['Counting', 'Counted'],
  install: ['Installing', 'Installed'],
  build: ['Building', 'Built'],
  test: ['Running', 'Ran'],
  typecheck: ['Type-checking', 'Type-checked'],
  lint: ['Linting', 'Linted'],
  format: ['Formatting', 'Formatted'],
  edit: ['Editing', 'Edited'],
  write: ['Writing', 'Wrote'],
  create: ['Creating', 'Created'],
  copy: ['Copying', 'Copied'],
  move: ['Moving', 'Moved'],
  remove: ['Removing', 'Removed'],
  fetch: ['Fetching', 'Fetched'],
  stage: ['Staging', 'Staged'],
  commit: ['Committing', 'Committed'],
  push: ['Pushing', 'Pushed'],
  pull: ['Pulling', 'Pulled'],
  switch: ['Switching', 'Switched'],
  reset: ['Resetting', 'Reset'],
  stop: ['Stopping', 'Stopped'],
  compare: ['Comparing', 'Compared'],
  wait: ['Waiting', 'Waited']
}

// Imperative first words of Claude-written descriptions ("Install package
// dependencies") mapped onto the verb table so those conjugate too.
const IMPERATIVES: Record<string, VerbKey> = {
  run: 'run',
  execute: 'run',
  check: 'check',
  verify: 'check',
  inspect: 'check',
  show: 'view',
  view: 'view',
  display: 'view',
  search: 'search',
  find: 'search',
  grep: 'search',
  locate: 'search',
  read: 'read',
  list: 'list',
  count: 'count',
  install: 'install',
  build: 'build',
  compile: 'build',
  test: 'test',
  lint: 'lint',
  format: 'format',
  edit: 'edit',
  update: 'edit',
  modify: 'edit',
  write: 'write',
  create: 'create',
  make: 'create',
  add: 'create',
  copy: 'copy',
  move: 'move',
  rename: 'move',
  remove: 'remove',
  delete: 'remove',
  clean: 'remove',
  fetch: 'fetch',
  download: 'fetch',
  get: 'fetch',
  stage: 'stage',
  commit: 'commit',
  push: 'push',
  pull: 'pull',
  compare: 'compare',
  diff: 'compare',
  stop: 'stop',
  kill: 'stop',
  wait: 'wait'
}

type Part = { verb: VerbKey; obj: string }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function narrateCommand(
  command: string,
  actions?: readonly CommandAction[] | null,
  description?: string | null
): CommandNarration {
  const fromDescription = description?.trim() ? narrateDescription(description.trim()) : null
  if (fromDescription) return fromDescription

  const gathered =
    actions && actions.length > 0 ? partsFromActions(actions) : partsFromShell(cleanCommand(command))

  if (gathered.parts.length === 0) {
    const cleaned = cleanCommand(command)
    return { running: cleaned, done: cleaned, natural: false }
  }
  return {
    running: compose(gathered.parts, gathered.unknown, 0),
    done: compose(gathered.parts, gathered.unknown, 1),
    natural: true
  }
}

// Wrapper-stripped, whitespace-collapsed single line — what the terminal card
// shows when prose isn't possible, and what the expanded card echoes as the
// real command.
export function cleanCommand(command: string): string {
  return stripShellWrapper(command).replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Description conjugation (Claude runtime)
// ---------------------------------------------------------------------------

function narrateDescription(text: string): CommandNarration {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  const match = /^([A-Za-z]+)\b(.*)$/.exec(oneLine)
  const key = match ? IMPERATIVES[match[1].toLowerCase()] : undefined
  if (match && key) {
    const rest = match[2]
    return { running: `${VERBS[key][0]}${rest}`, done: `${VERBS[key][1]}${rest}`, natural: true }
  }
  // Not an imperative we know — the sentence still reads fine in both states.
  return { running: oneLine, done: oneLine, natural: true }
}

// ---------------------------------------------------------------------------
// Parts from Codex's server-parsed actions
// ---------------------------------------------------------------------------

function partsFromActions(actions: readonly CommandAction[]): { parts: Part[]; unknown: number } {
  const parts: Part[] = []
  let unknown = 0
  for (const action of actions) {
    if (action.type === 'read') {
      parts.push({ verb: 'read', obj: basename(action.path) || action.name })
    } else if (action.type === 'listFiles') {
      parts.push({ verb: 'list', obj: action.path ? `files in ${basename(action.path)}` : 'files' })
    } else if (action.type === 'search') {
      parts.push({ verb: 'search', obj: searchObj(action.query, action.path ? [action.path] : []) })
    } else {
      const nested = partsFromShell(cleanCommand(action.command))
      parts.push(...nested.parts)
      unknown += nested.unknown
      if (nested.parts.length === 0 && nested.unknown === 0) unknown += 1
    }
  }
  return { parts: dedupe(parts), unknown }
}

// ---------------------------------------------------------------------------
// Parts from the raw command line
// ---------------------------------------------------------------------------

function partsFromShell(command: string): { parts: Part[]; unknown: number } {
  const parts: Part[] = []
  let unknown = 0
  for (const segment of splitTopLevel(command)) {
    const stage = pickPipeStage(segment)
    if (stage === null) continue // plumbing (cd, true, echo …)
    const part = classify(stage)
    if (part) parts.push(part)
    else unknown += 1
  }
  return { parts: dedupe(parts), unknown }
}

// Split a command line at top-level `&&`, `||`, `;`, `&` and newlines,
// keeping each pipeline together. Quote- and escape-aware; parens/subshells
// are treated as opaque text.
function splitTopLevel(command: string): string[][] {
  const segments: string[][] = []
  let tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  const pushToken = (): void => {
    if (current) tokens.push(current)
    current = ''
  }
  const pushSegment = (): void => {
    pushToken()
    if (tokens.length) segments.push(tokens)
    tokens = []
  }

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[i + 1]
        i += 1
      } else if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += command[i + 1]
      i += 1
      continue
    }
    if (ch === '\n' || ch === ';') {
      pushSegment()
      continue
    }
    if (ch === '&' || ch === '|') {
      const pair = command[i + 1] === ch
      if (pair) i += 1
      if (ch === '|') {
        // Keep the pipe boundary as a marker token so pickPipeStage can
        // choose the meaningful stage of the pipeline.
        if (pair) {
          pushSegment()
        } else {
          pushToken()
          tokens.push('|')
        }
      } else {
        pushSegment()
      }
      continue
    }
    if (ch === ' ' || ch === '\t') {
      pushToken()
      continue
    }
    current += ch
  }
  pushSegment()
  return segments
}

// From `a | b | c` keep the stage worth narrating: the first one, unless it
// is a bare feeder (cat/echo) piping into something with more meaning. Pure
// filter tails (head, wc, sort …) are dropped with the rest.
function pickPipeStage(segment: string[]): string[] | null {
  const stages: string[][] = []
  let stage: string[] = []
  for (const token of segment) {
    if (token === '|') {
      if (stage.length) stages.push(stage)
      stage = []
    } else {
      stage.push(token)
    }
  }
  if (stage.length) stages.push(stage)

  for (const candidate of stages) {
    const stripped = stripPrefixes(candidate)
    if (!stripped.length) continue
    const name = basename(stripped[0]).toLowerCase()
    if (PLUMBING.has(name)) {
      if (stages.length > 1) continue // feeder/no-op inside a pipeline
      return null
    }
    return stripped
  }
  return null
}

// Env assignments and wrapper commands in front of the real argv.
function stripPrefixes(tokens: string[]): string[] {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1
      continue
    }
    const name = basename(token).toLowerCase()
    if (name === 'sudo' || name === 'command' || name === 'nohup' || name === 'time') {
      index += 1
      continue
    }
    if (name === 'timeout' && index + 1 < tokens.length) {
      index += 2
      continue
    }
    break
  }
  return tokens.slice(index)
}

const PLUMBING = new Set(['cd', 'true', 'false', ':', 'exit', 'set', 'export', 'echo', 'printf', 'pwd', 'tee'])

function classify(tokens: string[]): Part | null {
  const name = basename(tokens[0]).toLowerCase()
  const args = tokens.slice(1)

  switch (name) {
    case 'git':
      return classifyGit(args)
    case 'rg':
    case 'grep':
    case 'egrep':
    case 'ag':
      return classifySearch(args)
    case 'ls':
    case 'tree':
      return { verb: 'list', obj: listObj(positional(args)[0]) }
    case 'find':
    case 'fd':
      return { verb: 'list', obj: listObj(name === 'find' ? positional(args)[0] : positional(args)[1]) }
    case 'cat':
    case 'bat':
    case 'head':
    case 'tail':
    case 'less':
    case 'more': {
      const files = positional(args)
      if (!files.length) return null
      return { verb: 'read', obj: files.length === 1 ? basename(files[0]) : `${files.length} files` }
    }
    case 'sed': {
      // Positional args are the script (`120,160p`, `s/x/y/`) then files —
      // only a trailing token that looks like a path counts as the target.
      const target = positional(args).at(-1)
      const isFile = !!target && /[\\/.]/.test(target) && !/^s[/#|]/.test(target)
      if (args.some((arg) => arg.startsWith('-i'))) {
        return { verb: 'edit', obj: isFile ? basename(target) : 'a file' }
      }
      return isFile ? { verb: 'read', obj: basename(target) } : null
    }
    case 'wc': {
      const target = positional(args).at(-1)
      return { verb: 'count', obj: target ? `lines in ${basename(target)}` : 'lines' }
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return classifyPackageManager(args)
    case 'npx':
      return args.length ? classify(args) : null
    case 'tsc':
    case 'tsgo':
      return { verb: 'typecheck', obj: 'the code' }
    case 'vitest':
    case 'jest':
    case 'mocha':
    case 'pytest':
      return { verb: 'test', obj: 'tests' }
    case 'electron-vite':
    case 'vite':
    case 'webpack':
    case 'rollup':
    case 'esbuild': {
      const sub = positional(args)[0]
      if (sub === 'dev' || sub === 'serve' || sub === 'preview') return { verb: 'run', obj: 'the dev server' }
      return { verb: 'build', obj: 'the app' }
    }
    case 'make':
      return { verb: 'build', obj: positional(args)[0] ? `\`${positional(args)[0]}\`` : 'the project' }
    case 'cargo':
    case 'go': {
      const sub = positional(args)[0]
      if (sub === 'test') return { verb: 'test', obj: 'tests' }
      if (sub === 'build') return { verb: 'build', obj: 'the project' }
      if (sub === 'run') return { verb: 'run', obj: 'the project' }
      return null
    }
    case 'node':
    case 'tsx':
    case 'ts-node':
    case 'deno':
    case 'python':
    case 'python3': {
      const script = positional(args).find((arg) => /[\\/.]/.test(arg))
      return { verb: 'run', obj: script ? basename(script) : `a ${name} script` }
    }
    case 'biome':
    case 'eslint':
      return { verb: 'lint', obj: 'the code' }
    case 'prettier':
      return { verb: 'format', obj: 'the code' }
    case 'curl':
    case 'wget': {
      const url = positional(args).find((arg) => /^https?:\/\//.test(arg))
      return { verb: 'fetch', obj: url ? hostOf(url) : 'a URL' }
    }
    case 'mkdir':
      return { verb: 'create', obj: firstPathObj(args, 'a directory') }
    case 'touch':
      return { verb: 'create', obj: firstPathObj(args, 'a file') }
    case 'cp':
      return { verb: 'copy', obj: firstPathObj(args, 'files') }
    case 'mv':
      return { verb: 'move', obj: firstPathObj(args, 'files') }
    case 'rm':
      return { verb: 'remove', obj: firstPathObj(args, 'files') }
    case 'chmod':
    case 'chown':
      return { verb: 'edit', obj: 'file permissions' }
    case 'which':
    case 'type':
      return { verb: 'check', obj: positional(args)[0] ? `for ${positional(args)[0]}` : 'a command' }
    case 'ps':
    case 'pgrep':
    case 'lsof':
      return { verb: 'check', obj: 'running processes' }
    case 'kill':
    case 'pkill':
    case 'killall':
      return { verb: 'stop', obj: 'a process' }
    case 'diff':
      return { verb: 'compare', obj: 'files' }
    case 'sleep':
      return { verb: 'wait', obj: positional(args)[0] ? `${positional(args)[0]}s` : 'briefly' }
    default:
      if (/\.(sh|bash|mjs|cjs|js|ts|py)$/.test(name)) {
        return { verb: 'run', obj: basename(tokens[0]) }
      }
      return null
  }
}

function classifyGit(args: string[]): Part | null {
  const rest = [...args]
  while (rest.length) {
    const token = rest[0]
    if (token === '-C' || token === '-c') {
      rest.splice(0, 2)
    } else if (token.startsWith('-')) {
      rest.shift()
    } else {
      break
    }
  }
  const sub = rest.shift()
  if (!sub) return null
  switch (sub) {
    case 'status':
      return { verb: 'check', obj: 'git status' }
    case 'log':
      return { verb: 'view', obj: 'recent commits' }
    case 'diff':
      return { verb: 'view', obj: 'the diff' }
    case 'show':
      return { verb: 'view', obj: 'a commit' }
    case 'blame':
      return { verb: 'view', obj: rest[0] ? `blame for ${basename(positional(rest).at(-1) ?? '')}` : 'blame' }
    case 'add':
      return { verb: 'stage', obj: 'changes' }
    case 'commit':
      return { verb: 'commit', obj: 'changes' }
    case 'push':
      return { verb: 'push', obj: 'changes' }
    case 'pull':
    case 'fetch':
      return { verb: 'pull', obj: 'changes' }
    case 'branch':
      return { verb: 'check', obj: 'branches' }
    case 'remote':
      return { verb: 'check', obj: 'git remotes' }
    case 'rev-parse':
    case 'rev-list':
    case 'describe':
      return { verb: 'check', obj: 'git refs' }
    case 'checkout':
    case 'switch':
      return { verb: 'switch', obj: 'branches' }
    case 'restore':
    case 'reset':
      return { verb: 'reset', obj: 'changes' }
    case 'stash':
      return { verb: 'stage', obj: 'a stash' }
    case 'worktree':
      return { verb: 'check', obj: 'worktrees' }
    case 'clone':
      return { verb: 'fetch', obj: 'a repository' }
    default:
      return { verb: 'run', obj: `git ${sub}` }
  }
}

// Value-taking flags for rg/grep so the pattern lands on the right token.
const SEARCH_VALUE_FLAGS = new Set(['-e', '-g', '-t', '-T', '-A', '-B', '-C', '-m', '-d', '-f', '--glob', '--type', '--max-count', '--include', '--exclude'])

function classifySearch(args: string[]): Part {
  let pattern: string | null = null
  const paths: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '-e' && i + 1 < args.length) {
      pattern = args[i + 1]
      i += 1
      continue
    }
    if (SEARCH_VALUE_FLAGS.has(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith('-')) continue
    if (pattern === null) pattern = arg
    else paths.push(arg)
  }
  return { verb: 'search', obj: searchObj(pattern, paths) }
}

function classifyPackageManager(args: string[]): Part | null {
  const sub = positional(args)[0]
  if (!sub) return null
  if (sub === 'install' || sub === 'i' || sub === 'ci' || sub === 'add') {
    return { verb: 'install', obj: 'dependencies' }
  }
  if (sub === 'test' || sub === 't') return { verb: 'test', obj: 'tests' }
  const script = sub === 'run' ? positional(args)[1] : null
  const known: Record<string, Part> = {
    build: { verb: 'build', obj: 'the app' },
    typecheck: { verb: 'typecheck', obj: 'the code' },
    lint: { verb: 'lint', obj: 'the code' },
    format: { verb: 'format', obj: 'the code' },
    test: { verb: 'test', obj: 'tests' },
    dev: { verb: 'run', obj: 'the dev server' }
  }
  if (script) return known[script] ?? { verb: 'run', obj: `the ${script} script` }
  return known[sub] ?? { verb: 'run', obj: `\`${sub}\`` }
}

// ---------------------------------------------------------------------------
// Composition helpers
// ---------------------------------------------------------------------------

function compose(parts: Part[], unknown: number, tense: 0 | 1): string {
  const first = `${VERBS[parts[0].verb][tense]} ${parts[0].obj}`
  const extras = parts.length - 1 + unknown
  if (extras === 0) return first
  if (parts.length >= 2 && extras === 1) {
    const second = `${VERBS[parts[1].verb][tense]} ${parts[1].obj}`
    return `${first}, ${second[0].toLowerCase()}${second.slice(1)}`
  }
  return `${first} and ${extras} more`
}

function dedupe(parts: Part[]): Part[] {
  const seen = new Set<string>()
  return parts.filter((part) => {
    const key = `${part.verb}:${part.obj}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function searchObj(query: string | null | undefined, paths: string[]): string {
  const cleaned = query ? displayPattern(query) : null
  const where = paths.length === 1 ? ` in ${basename(paths[0])}` : paths.length > 1 ? ` in ${paths.length} files` : ''
  return cleaned ? `for “${cleaned}”${where}` : `files${where}`
}

// Regex patterns read badly verbatim; strip the escaping that is pure noise.
function displayPattern(pattern: string): string {
  const cleaned = pattern
    .replace(/\\b/g, '')
    .replace(/\\([.\\/+*?()[\]{}^$-])/g, '$1')
    .trim()
  return truncate(cleaned || pattern, 36)
}

function listObj(path: string | undefined): string {
  return path && path !== '.' ? `files in ${basename(path)}` : 'files'
}

function firstPathObj(args: string[], fallback: string): string {
  const target = positional(args)[0]
  return target ? basename(target) : fallback
}

function positional(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('-'))
}

// `/bin/bash -lc "…"`, `sh -c '…'`, `/usr/bin/env bash -c …` → the inner command.
function stripShellWrapper(command: string): string {
  let text = command.trim()
  for (let i = 0; i < 2; i += 1) {
    const match = /^(?:\/[\w./-]*\/)?(?:env\s+)?(?:ba|z|da)?sh\s+(?:-[a-z]+\s+)*(['"]?)([\s\S]+)\1$/.exec(text)
    if (!match || !match[2]) break
    text = match[2].trim()
  }
  return text
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return truncate(url, 40)
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
