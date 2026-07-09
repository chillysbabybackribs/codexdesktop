// Unified-diff parsing for the live file-edit cards. The app-server streams a
// growing unified diff per changed file (item/fileChange/patchUpdated); we
// re-parse on every update — diffs are small enough that this stays cheap.

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk'

// A change line is optionally split into segments so the changed span within a
// modified line can be emphasized (darker red/green), GitHub/Cursor style.
export type DiffSegment = { text: string; emph: boolean }

export type DiffLine = {
  kind: DiffLineKind
  text: string
  segments?: DiffSegment[]
}

export type ParsedDiff = {
  lines: DiffLine[]
  adds: number
  dels: number
}

const isFileHeader = (line: string): boolean =>
  line.startsWith('diff ') ||
  line.startsWith('index ') ||
  line.startsWith('+++ ') ||
  line.startsWith('--- ') ||
  line.startsWith('new file mode') ||
  line.startsWith('deleted file mode') ||
  line.startsWith('rename from') ||
  line.startsWith('rename to') ||
  line.startsWith('similarity index') ||
  line.startsWith('old mode') ||
  line.startsWith('new mode') ||
  line.startsWith('*** ')

// `forceAll` handles add/delete file changes where the app-server sends raw
// file content without +/- markers — every content line IS an addition (or
// removal), and should count and tint as one.
export function parseUnifiedDiff(diff: string, forceAll?: 'add' | 'del'): ParsedDiff {
  const lines: DiffLine[] = []
  let adds = 0
  let dels = 0

  for (const raw of diff.split('\n')) {
    if (!raw && lines.length === 0) {
      continue
    }
    if (raw.startsWith('@@')) {
      lines.push({ kind: 'hunk', text: raw })
      continue
    }
    if (raw.startsWith('\\') || isFileHeader(raw)) {
      // "\ No newline at end of file" + git headers — the card header already
      // names the file, so these carry nothing for the reader.
      continue
    }
    if (raw.startsWith('+')) {
      adds += 1
      lines.push({ kind: 'add', text: raw.slice(1) })
      continue
    }
    if (raw.startsWith('-')) {
      dels += 1
      lines.push({ kind: 'del', text: raw.slice(1) })
      continue
    }
    lines.push({ kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw })
  }

  // Trim a trailing blank context line left by the final "\n" split.
  while (lines.length && lines[lines.length - 1].kind === 'context' && !lines[lines.length - 1].text) {
    lines.pop()
  }

  if (forceAll && adds === 0 && dels === 0) {
    for (const line of lines) {
      if (line.kind === 'context') {
        line.kind = forceAll
        if (forceAll === 'add') {
          adds += 1
        } else {
          dels += 1
        }
      }
    }
  }

  emphasizeIntraline(lines)
  return { lines, adds, dels }
}

// Pair each run of removed lines with the run of added lines that follows it
// (the classic "replaced block" shape) and mark the changed span per pair via
// common prefix/suffix. Only pairs that share real context get emphasis —
// wholly-rewritten lines stay uniformly tinted.
function emphasizeIntraline(lines: DiffLine[]): void {
  let i = 0

  while (i < lines.length) {
    if (lines[i].kind !== 'del') {
      i += 1
      continue
    }

    const delStart = i
    while (i < lines.length && lines[i].kind === 'del') {
      i += 1
    }
    const addStart = i
    while (i < lines.length && lines[i].kind === 'add') {
      i += 1
    }

    const pairs = Math.min(addStart - delStart, i - addStart)
    for (let p = 0; p < pairs; p += 1) {
      const del = lines[delStart + p]
      const add = lines[addStart + p]
      const marked = markChangedSpan(del.text, add.text)
      if (marked) {
        del.segments = marked.del
        add.segments = marked.add
      }
    }
  }
}

function markChangedSpan(
  a: string,
  b: string
): { del: DiffSegment[]; add: DiffSegment[] } | null {
  if (!a || !b || a === b) {
    return null
  }

  let prefix = 0
  const max = Math.min(a.length, b.length)
  while (prefix < max && a[prefix] === b[prefix]) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < max - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const shared = prefix + suffix
  // If the lines share almost nothing, span emphasis is noise.
  if (shared < Math.max(a.length, b.length) * 0.3) {
    return null
  }

  return {
    del: toSegments(a, prefix, a.length - suffix),
    add: toSegments(b, prefix, b.length - suffix)
  }
}

function toSegments(text: string, from: number, to: number): DiffSegment[] {
  const segments: DiffSegment[] = []
  if (from > 0) {
    segments.push({ text: text.slice(0, from), emph: false })
  }
  if (to > from) {
    segments.push({ text: text.slice(from, to), emph: true })
  }
  if (to < text.length) {
    segments.push({ text: text.slice(to), emph: false })
  }
  return segments
}

export type TurnDiffSummary = { files: number; adds: number; dels: number }

// Aggregate stats for the turn-level unified diff (turn/diff/updated) — the
// authoritative per-turn change count, deduped across repeated edits.
export function summarizeTurnDiff(diff: string): TurnDiffSummary {
  let files = 0
  let adds = 0
  let dels = 0

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff ') || line.startsWith('*** Begin Patch')) {
      // noop: file count comes from +++/--- pairs below to survive both formats
    }
    if (line.startsWith('+++ ') || line.startsWith('*** Add File:') || line.startsWith('*** Update File:') || line.startsWith('*** Delete File:')) {
      files += 1
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      adds += 1
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      dels += 1
    }
  }

  return { files, adds, dels }
}
