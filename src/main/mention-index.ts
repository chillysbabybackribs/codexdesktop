import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'

// Workspace file index for composer @-mentions. Git-backed (ls-files respects
// .gitignore and is fast); non-git workspaces simply offer no file mentions.
// The index is cached briefly per workspace — mention menus fire on every
// keystroke and the file set changes far slower than the user types.
//
// Security boundary (AUDIT.md 2026-07-19): reads are contained by REAL paths,
// not lexical ones — a tracked symlink pointing outside the workspace resolves
// outside the real root and is rejected, never read. Reads are additionally
// limited to paths the git index actually offered (the mention menu's own
// surface), and the workspace root itself must be a realpath'd directory
// inside a git work tree — or one the user approved through the native picker.

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

type CachedIndex = { at: number; index: MentionIndex; fileSet: Set<string> }

const unreadable: MentionReadResult = { content: null, truncated: false }

export class MentionIndexService {
  private readonly cache = new Map<string, CachedIndex>()
  private readonly approvedRoots = new Set<string>()

  /** Mark a workspace the user explicitly chose (native picker) as readable. */
  async approveWorkspace(workspace: string): Promise<void> {
    try {
      this.approvedRoots.add(await realpath(workspace))
    } catch {
      // Nonexistent path: nothing to approve.
    }
  }

  /**
   * Validate a renderer-supplied workspace and return its REAL root, or null.
   * Accepted when the realpath is a directory that is either explicitly
   * approved or inside a git work tree (the same privilege the mention index
   * itself requires).
   */
  private async validatedRoot(workspace: string): Promise<string | null> {
    let real: string
    try {
      real = await realpath(workspace)
      if (!(await stat(real)).isDirectory()) return null
    } catch {
      return null
    }
    if (this.approvedRoots.has(real)) return real
    try {
      const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: real })
      const top = await realpath(stdout.trim())
      if (real === top || real.startsWith(top + sep)) return real
    } catch {
      // Not a git work tree.
    }
    return null
  }

  async index(workspace: string): Promise<MentionIndex> {
    const cached = this.cache.get(workspace)
    if (cached && Date.now() - cached.at < indexTtlMs) return cached.index

    let index: MentionIndex = { files: [], dirs: [] }
    const root = await this.validatedRoot(workspace)
    if (root) {
      try {
        const { stdout } = await run('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
          cwd: root,
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
    }
    this.cache.set(workspace, { at: Date.now(), index, fileSet: new Set(index.files) })
    return index
  }

  /** Resolve one mention: file content (bounded) or a folder listing. */
  async read(workspace: string, path: string, kind: 'file' | 'folder'): Promise<MentionReadResult> {
    const root = await this.validatedRoot(workspace)
    if (!root) return unreadable

    await this.index(workspace)
    const cached = this.cache.get(workspace)
    if (!cached) return unreadable

    if (kind === 'folder') {
      // Folder listings are derived purely from the index — nothing is read
      // from disk, so escape sequences in the prefix simply match no entries.
      const prefix = `${path.replace(/\/+$/, '')}/`
      const entries = cached.index.files.filter((file) => file.startsWith(prefix))
      if (!entries.length) return unreadable
      const shown = entries.slice(0, maxFolderEntries)
      return {
        content: shown.map((entry) => `- ${entry}`).join('\n'),
        truncated: entries.length > shown.length
      }
    }

    // File reads are limited to what the index offered the menu.
    if (!cached.fileSet.has(path)) return unreadable

    const absolute = resolve(root, path)
    if (absolute !== root && !absolute.startsWith(root + sep)) return unreadable

    // Follow symlinks NOW and require the real target to stay inside the real
    // workspace root — a tracked link to /etc/passwd resolves outside and is
    // rejected here regardless of what the lexical path claimed.
    let real: string
    try {
      real = await realpath(absolute)
    } catch {
      return unreadable
    }
    if (real !== root && !real.startsWith(root + sep)) return unreadable

    try {
      const raw = await readFile(real, 'utf8')
      if (raw.includes('\0')) return unreadable // binary
      return raw.length > maxFileMentionChars
        ? { content: raw.slice(0, maxFileMentionChars), truncated: true }
        : { content: raw, truncated: false }
    } catch {
      return unreadable
    }
  }
}
