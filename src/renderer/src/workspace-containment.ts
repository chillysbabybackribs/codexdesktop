// Post-turn workspace-containment check — the backstop behind the prompt-level
// guardrail in main-chat-intake.ts. The app is deliberately unrestricted (no
// sandbox, no approval UI), so work CAN land outside the declared workspace;
// when it does, it silently escapes turn checkpoints, Keep/Undo, and the
// audit's diff grounding. This detector scans a completed turn's shell
// commands and editor writes for likely out-of-workspace targets so the
// transcript can say so — a warning, never a gate.

// Commands that suggest creation/writing. Reads of absolute paths are normal;
// only write-shaped commands are considered (editor fileChange paths are
// writes by definition and skip this filter).
const WRITE_HINT =
  /\b(mkdir|touch|tee|git\s+init|npm\s+(init|create)|yarn\s+(init|create)|pnpm\s+(init|create)|cargo\s+(new|init)|cp|mv|rsync|ln|install|unzip|chmod|chown|tar\s+-?x\w*)\b|>>?/

// System/tooling prefixes that are never "escaped work".
const IGNORED_PREFIXES = [
  '/tmp',
  '/dev',
  '/proc',
  '/sys',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/etc',
  '/opt',
  '/run',
  '/var',
  '/snap',
  '/nix',
]

// The lookbehind keeps relative segments like `./words` or `foo/bar` from
// matching as absolute paths mid-token; it sits before the prefix so `~/x`
// and `$HOME/x` still match.
const PATH_TOKEN = /(?<![\w.@+\-])(?:~|\$HOME)?\/[\w.@+\-/]+/g

export function outOfWorkspacePaths(input: {
  commands: string[]
  filePaths: string[]
  workspace: string | null
}): string[] {
  const workspace = input.workspace?.replace(/\/+$/, '')
  if (!workspace) return []
  // Resolvable only when the workspace itself lives in a home directory; a
  // `~` path can still be judged without it — it cannot be inside a
  // non-home workspace by construction.
  const home = /^\/home\/[^/]+/.exec(workspace)?.[0] ?? null
  const found = new Set<string>()

  const consider = (raw: string): void => {
    let path = raw
    if (raw.startsWith('~') || raw.startsWith('$HOME')) {
      if (!home) {
        found.add(raw)
        return
      }
      path = home + raw.slice(raw.startsWith('~') ? 1 : '$HOME'.length)
    }
    if (!path.startsWith('/')) return
    if (path === workspace || path.startsWith(`${workspace}/`)) return
    if (IGNORED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return
    found.add(path)
  }

  for (const command of input.commands) {
    if (!WRITE_HINT.test(command)) continue
    for (const match of command.matchAll(PATH_TOKEN)) consider(match[0])
  }
  // Editor writes carry explicit paths; relative ones are workspace-scoped by
  // construction and fall out of the leading-slash check.
  for (const filePath of input.filePaths) consider(filePath)

  return [...found].slice(0, 5)
}
