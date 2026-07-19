// Splits a streaming markdown document into segments whose earlier members
// never change as text is appended, so per-delta markdown parsing is bounded by
// the trailing segment instead of the whole message. Segments concatenate back
// to the exact original text; boundaries sit at blank lines outside code fences
// and skip list/indented continuations so numbering and code blocks survive the
// split. Any residual boundary artifact self-corrects when the completed
// message re-renders through the single-parse path.

const fenceOpenRe = /^ {0,3}(`{3,}|~{3,})/
const listStartRe = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const indentedRe = /^(?: {4}|\t)/

export function splitMarkdownSegments(text: string): string[] {
  if (!text) return []

  const lines = text.split(/(?<=\n)/)
  const segments: string[] = []
  let current: string[] = []
  let fence: { char: string; length: number } | null = null
  let pendingBoundary = false
  // Whether the segment's trailing block is list-flavored — a later sibling
  // list item must merge into it so loose ordered-list numbering survives.
  let inListContext = false

  for (const line of lines) {
    const bare = line.endsWith('\n') ? line.slice(0, -1) : line

    if (fence) {
      current.push(line)
      const close = bare.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null
      }
      continue
    }

    if (bare.trim() === '') {
      current.push(line)
      pendingBoundary = current.length > 0
      continue
    }

    if (pendingBoundary) {
      pendingBoundary = false
      // Sibling list items and indented continuations stay with their segment
      // so numbering and loose-list/indented-code structure are preserved; a
      // list that follows a non-list block starts a fresh segment.
      const continuesList = listStartRe.test(bare) && inListContext
      if (current.length && !continuesList && !indentedRe.test(bare)) {
        segments.push(current.join(''))
        current = []
      }
    }

    inListContext = listStartRe.test(bare)
      ? true
      : indentedRe.test(bare) || /^ {1,3}\S/.test(bare)
        ? inListContext
        : false

    const open = bare.match(fenceOpenRe)
    if (open) fence = { char: open[1][0], length: open[1].length }
    current.push(line)
  }

  if (current.length) segments.push(current.join(''))
  return segments
}

// Bounds the rendered component count for very long documents. Chunk
// boundaries sit at fixed segment indices, so filled chunks stay stable as the
// document grows; only the trailing partial chunk re-parses.
export const markdownSegmentChunkSize = 32

export function chunkMarkdownSegments(segments: string[]): string[] {
  if (segments.length <= markdownSegmentChunkSize) return segments

  const chunks: string[] = []
  for (let index = 0; index < segments.length; index += markdownSegmentChunkSize) {
    chunks.push(segments.slice(index, index + markdownSegmentChunkSize).join(''))
  }
  return chunks
}
