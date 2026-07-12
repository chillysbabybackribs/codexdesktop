const FOCUS_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in',
  'is', 'it', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'which',
  'who', 'why', 'with'
])

const DEFAULT_EVIDENCE_CHARS = 3_500
const MIN_EVIDENCE_CHARS = 1_000
const MAX_EVIDENCE_CHARS = 8_000
const MIN_PASSAGE_CHARS = 50
const MAX_PASSAGE_CHARS = 1_500
const MAX_FOCUS_ITEMS = 6

export type ResearchFocus = {
  id: string
  need: string
  minSources: number
}

export type ResearchEvidenceDocument = {
  sourceId: string
  title: string
  url: string
  artifactPath: string
  content: string
  observedAt: string
  sourceTier?: string
}

export type ResearchPassage = {
  focusId: string
  sourceId: string
  title: string
  url: string
  artifactPath: string
  observedAt: string
  sourceTier?: string
  lineStart: number
  lineEnd: number
  text: string
  matchedTerms: string[]
  truncated: boolean
}

export type ResearchGap = {
  focusId: string
  need: string
  requiredSources: number
  matchedSources: number
  reason: 'no-relevant-passage' | 'insufficient-source-coverage'
}

export type ResearchEvidencePacket = {
  passages: ResearchPassage[]
  gaps: ResearchGap[]
}

type PassageCandidate = Omit<ResearchPassage, 'focusId'> & {
  score: number
  documentFingerprint: string
}

export function normalizeResearchFocus(
  values: Array<{ id?: unknown; need?: unknown; minSources?: unknown }> | null | undefined
): ResearchFocus[] {
  if (!Array.isArray(values)) return []

  const normalized: ResearchFocus[] = []
  const ids = new Map<string, number>()
  for (const [index, value] of values.entries()) {
    if (!value || typeof value !== 'object') continue
    const need = typeof value.need === 'string' ? value.need.trim().slice(0, 500) : ''
    if (!need) continue

    const requestedId = typeof value.id === 'string' ? value.id.trim().slice(0, 80) : ''
    const baseId = requestedId || `focus-${index + 1}`
    const duplicate = ids.get(baseId) ?? 0
    ids.set(baseId, duplicate + 1)
    normalized.push({
      id: duplicate === 0 ? baseId : `${baseId}-${duplicate + 1}`,
      need,
      minSources: clampInteger(value.minSources, 1, 1, 3)
    })
    if (normalized.length >= MAX_FOCUS_ITEMS) break
  }
  return normalized
}

export function selectResearchEvidence(
  focus: ResearchFocus[],
  documents: ResearchEvidenceDocument[],
  maxChars?: number | null
): ResearchEvidencePacket {
  if (focus.length === 0) return { passages: [], gaps: [] }

  const passageBudget = clampInteger(maxChars, DEFAULT_EVIDENCE_CHARS, MIN_EVIDENCE_CHARS, MAX_EVIDENCE_CHARS)
  const passages: ResearchPassage[] = []
  const gaps: ResearchGap[] = []

  for (const item of focus) {
    const tokens = tokenizeFocus(item.need)
    const perPassageChars = Math.max(
      MIN_PASSAGE_CHARS,
      Math.min(MAX_PASSAGE_CHARS, Math.floor(passageBudget / focus.length / item.minSources))
    )
    const candidates = tokens.length > 0
      ? documents
          .map((document) => bestDocumentPassage(document, tokens, perPassageChars))
          .filter((candidate): candidate is PassageCandidate => candidate !== null)
          .sort(compareCandidates)
      : []

    const selected: PassageCandidate[] = []
    const fingerprints = new Set<string>()
    for (const candidate of candidates) {
      if (fingerprints.has(candidate.documentFingerprint)) continue
      fingerprints.add(candidate.documentFingerprint)
      selected.push(candidate)
      if (selected.length >= item.minSources) break
    }

    passages.push(...selected.map(({ score: _score, documentFingerprint: _fingerprint, ...passage }) => ({
      focusId: item.id,
      ...passage
    })))

    if (selected.length < item.minSources) {
      gaps.push({
        focusId: item.id,
        need: item.need,
        requiredSources: item.minSources,
        matchedSources: selected.length,
        reason: selected.length === 0 ? 'no-relevant-passage' : 'insufficient-source-coverage'
      })
    }
  }

  return { passages, gaps }
}

function bestDocumentPassage(
  document: ResearchEvidenceDocument,
  focusTokens: string[],
  maxChars: number
): PassageCandidate | null {
  const lines = document.content.split('\n')
  const requiredMatches = focusTokens.length <= 2 ? 1 : Math.min(2, Math.ceil(focusTokens.length * 0.3))
  let best: { lineIndex: number; score: number; matchedTerms: string[] } | null = null

  for (const [lineIndex, line] of lines.entries()) {
    const lineTokens = new Set(tokenize(line))
    const localMatches = focusTokens.filter((token) => lineTokens.has(token))
    if (localMatches.length === 0) continue
    const windowTokens = new Set(tokenize(lines.slice(Math.max(0, lineIndex - 2), lineIndex + 3).join(' ')))
    const matchedTerms = focusTokens.filter((token) => windowTokens.has(token))
    if (matchedTerms.length < requiredMatches) continue

    const normalizedLine = normalizeText(lines.slice(Math.max(0, lineIndex - 2), lineIndex + 3).join(' '))
    const normalizedNeed = normalizeText(focusTokens.join(' '))
    const exactPhrase = normalizedNeed.length > 0 && normalizedLine.includes(normalizedNeed)
    const score = matchedTerms.length * 30 + localMatches.length * 8 + (exactPhrase ? 100 : 0)
    if (!best || score > best.score) best = { lineIndex, score, matchedTerms }
  }

  if (!best) return null
  const window = buildPassageWindow(lines, best.lineIndex, focusTokens, maxChars)
  return {
    sourceId: document.sourceId,
    title: document.title,
    url: document.url,
    artifactPath: document.artifactPath,
    observedAt: document.observedAt,
    ...(document.sourceTier ? { sourceTier: document.sourceTier } : {}),
    lineStart: window.lineStart,
    lineEnd: window.lineEnd,
    text: window.text,
    matchedTerms: best.matchedTerms,
    truncated: window.truncated,
    score: best.score,
    documentFingerprint: fingerprint(document.content)
  }
}

function buildPassageWindow(
  lines: string[],
  matchIndex: number,
  focusTokens: string[],
  maxChars: number
): { lineStart: number; lineEnd: number; text: string; truncated: boolean } {
  const matchedLine = lines[matchIndex] ?? ''
  if (matchedLine.length > maxChars) {
    const normalized = matchedLine.toLowerCase()
    const firstMatch = focusTokens
      .map((token) => normalized.search(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i')))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? 0
    const start = Math.max(0, Math.min(matchedLine.length - maxChars, firstMatch - Math.floor(maxChars / 3)))
    return {
      lineStart: matchIndex + 1,
      lineEnd: matchIndex + 1,
      text: matchedLine.slice(start, start + maxChars),
      truncated: true
    }
  }

  let start = matchIndex
  let end = matchIndex
  let text = matchedLine
  for (let distance = 1; distance <= 2; distance += 1) {
    const nextLeft = matchIndex - distance
    const nextRight = matchIndex + distance
    if (nextLeft >= 0) {
      const candidate = `${lines[nextLeft]}\n${text}`
      if (candidate.length <= maxChars) {
        start = nextLeft
        text = candidate
      }
    }
    if (nextRight < lines.length) {
      const candidate = `${text}\n${lines[nextRight]}`
      if (candidate.length <= maxChars) {
        end = nextRight
        text = candidate
      }
    }
  }

  while (start < end && !lines[start]?.trim()) start += 1
  while (end > start && !lines[end]?.trim()) end -= 1
  return {
    lineStart: start + 1,
    lineEnd: end + 1,
    text: lines.slice(start, end + 1).join('\n'),
    truncated: start > 0 || end < lines.length - 1
  }
}

function compareCandidates(left: PassageCandidate, right: PassageCandidate): number {
  if (right.score !== left.score) return right.score - left.score
  if (left.sourceId !== right.sourceId) return left.sourceId.localeCompare(right.sourceId)
  return left.lineStart - right.lineStart
}

function tokenizeFocus(value: string): string[] {
  return unique(tokenize(value).filter((token) => !FOCUS_STOP_WORDS.has(token)))
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function fingerprint(value: string): string {
  return normalizeText(value)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
