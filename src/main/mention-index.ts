import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'

// Workspace file index for composer @-mentions. Git-backed (ls-files respects
// .gitignore and is fast); non-git workspaces simply offer no file mentions.
// The index is cached briefly per workspace — mention menus fire on every
// keystroke and the file set changes far slower than the user types.

const run = promisify(execFile)

const indexTtlMs = 10_000
const maxIndexedFiles = 20_000
const maxFileMentionChars = 24_000
const maxFolderEntries = 200

export type MentionIndex = { files: string[]; dirs: string[] }

export type MentionReadResult = {
  content: string | null
  truncated: boolean
}

type CachedIndex = { at: number; index: MentionIndex }

export class MentionIndexService {
  private readonly cache = new Map<string, CachedIndex>()

  async index(workspace: string): Promise<MentionIndex> {
    const cached = this.cache.get(workspace)
    if (cached && Date.now() - cached.at < indexTtlMs) return cached.index

    let index: MentionIndex = { files: [], dirs: [] }
    try {
      const { stdout } = await run('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
        cwd: workspace,
        maxBuffer: 64 * 1024 * 1024
      })
      const files = stdout.split('\0').filter(Boolean).slice(0, maxIndexedFiles)
      const dirs = new Set<string>()
      for (const file of files) {
        let slash = file.indexOf('/')
        while (slash !== -1) {
          dirs.add(file.slice(0, slash))
          slash = file.indexOf('/', slash + 1)
        }
      }
      index = { files, dirs: [...dirs].sort() }
    } catch {
      // Not a git work tree (or git unavailable): no mention candidates.
    }
    this.cache.set(workspace, { at: Date.now(), index })
    return index
  }

  /** Resolve one mention: file content (bounded) or a folder listing. */
  async read(workspace: string, path: string, kind: 'file' | 'folder'): Promise<MentionReadResult> {
    const root = resolve(workspace)
    const absolute = resolve(root, path)
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      return { content: null, truncated: false }
    }

    if (kind === 'folder') {
      const { files } = await this.index(workspace)
      const prefix = `${path.replace(/\/+$/, '')}/`
      const entries = files.filter((file) => file.startsWith(prefix))
      if (!entries.length) return { content: null, truncated: false }
      const shown = entries.slice(0, maxFolderEntries)
      return {
        content: shown.map((entry) => `- ${entry}`).join('\n'),
        truncated: entries.length > shown.length
      }
    }

    try {
      const raw = await readFile(absolute, 'utf8')
      if (raw.includes('\0')) return { content: null, truncated: false } // binary
      return raw.length > maxFileMentionChars
        ? { content: raw.slice(0, maxFileMentionChars), truncated: true }
        : { content: raw, truncated: false }
    } catch {
      return { content: null, truncated: false }
    }
  }
}
