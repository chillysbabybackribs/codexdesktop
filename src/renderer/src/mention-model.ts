// @file / @folder composer mentions (Cursor-style): pure ranking + prompt
// injection helpers. The composer resolves each mention before sending — file
// contents (bounded) ride along inside a marker block the renderer strips
// from displayed user messages.

export type FileMention = {
  /** Workspace-relative path. */
  path: string
  kind: 'file' | 'folder'
}

export type MentionCandidate = FileMention & { score: number }

export type ResolvedMention = FileMention & {
  /** File content or folder listing; null when unreadable. */
  content: string | null
  truncated: boolean
}

export const mentionContextOpen = '<codexdesktop-mentions>'
export const mentionContextClose = '</codexdesktop-mentions>'

/**
 * Case-insensitive subsequence match with Cursor-ish scoring: consecutive-run
 * and basename-start bonuses, mild penalty for path length. Null = no match.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  const baseStart = c.lastIndexOf('/') + 1

  let score = 0
  let ci = 0
  let previousHit = -2
  for (let qi = 0; qi < q.length; qi += 1) {
    const found = c.indexOf(q[qi], ci)
    if (found === -1) return null
    score += 1
    if (found === previousHit + 1) score += 2 // consecutive run
    if (found === baseStart) score += 6 // starts the basename
    else if (found === 0 || c[found - 1] === '/' || c[found - 1] === '-' || c[found - 1] === '_' || c[found - 1] === '.') {
      score += 3 // starts a path/word segment
    }
    previousHit = found
    ci = found + 1
  }
  // Prefer matches inside the basename, then shorter paths.
  if (c.indexOf(q, baseStart) !== -1) score += 8
  return score - Math.min(20, Math.floor(candidate.length / 12))
}

/** Rank files and folders for a mention query; files first on ties. */
export function rankMentionCandidates(
  query: string,
  files: readonly string[],
  dirs: readonly string[],
  limit = 8
): MentionCandidate[] {
  const candidates: MentionCandidate[] = []
  for (const path of files) {
    const score = fuzzyScore(query, path)
    if (score !== null) candidates.push({ path, kind: 'file', score: score + 1 })
  }
  for (const path of dirs) {
    const score = fuzzyScore(query, path)
    if (score !== null) candidates.push({ path, kind: 'folder', score })
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
}

/** The context block appended to the outgoing prompt (empty when no content). */
export function buildMentionContext(mentions: readonly ResolvedMention[]): string {
  const sections: string[] = []
  for (const mention of mentions) {
    if (mention.content === null) {
      sections.push(`[${mention.kind}: ${mention.path}] (unreadable — mentioned for context)`)
      continue
    }
    const suffix = mention.truncated ? ' (truncated)' : ''
    sections.push(
      mention.kind === 'file'
        ? `[file: ${mention.path}]${suffix}\n\`\`\`\n${mention.content}\n\`\`\``
        : `[folder: ${mention.path}]${suffix}\n${mention.content}`
    )
  }
  if (!sections.length) return ''
  return `\n\n${mentionContextOpen}\nThe user attached these workspace paths as context:\n\n${sections.join('\n\n')}\n${mentionContextClose}`
}

/** Remove the injected mention block from a displayed user message. */
export function stripMentionContext(text: string): string {
  const start = text.indexOf(mentionContextOpen)
  if (start === -1) return text
  const end = text.indexOf(mentionContextClose, start)
  if (end === -1) return text.slice(0, start).trimEnd()
  return `${text.slice(0, start)}${text.slice(end + mentionContextClose.length)}`.trimEnd()
}
