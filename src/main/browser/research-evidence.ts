const FOCUS_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in',
  'is', 'it', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'which',
  'who', 'why', 'with', 'do', 'does', 'doe', 'did', 'tell', 'result', 'results', 'exact'
])

const DEFAULT_EVIDENCE_CHARS = 3_500
const MIN_EVIDENCE_CHARS = 1_000
const MAX_EVIDENCE_CHARS = 8_000
const MIN_PASSAGE_CHARS = 50
const MAX_PASSAGE_CHARS = 1_500
const MAX_FOCUS_ITEMS = 6
const MAX_CONTEXT_NONEMPTY_LINES = 4
const WORD_SEGMENTER = new Intl.Segmenter('und', { granularity: 'word' })

export type ResearchFocus = {
  id: string
  need: string
  minSources: number
}

export type ResearchEvidenceDocument = {
  sourceId: string
  title: string
  url: string
  content: string
  observedAt: string
  sourceTier?: string
}

export type ResearchPassage = {
  focusId: string
  sourceId: string
  lineStart: number
  lineEnd: number
  columnStart: number
  columnEnd: number
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
  canonicalUrl: string
}

type IndexedEvidenceDocument = {
  document: ResearchEvidenceDocument
  lines: string[]
  lineTokens: Array<Set<string>>
  windowTokens: Array<Set<string>>
  windowText: string[]
  tokenFrequency: Map<string, number>
  titleTokens: Set<string>
  fingerprint: string
}

export function normalizeResearchFocus(
  values: Array<{ id?: unknown; need?: unknown; minSources?: unknown }> | null | undefined
): ResearchFocus[] {
  if (!Array.isArray(values)) return []

  const normalized: ResearchFocus[] = []
  const ids = new Set<string>()
  for (const [index, value] of values.entries()) {
    if (!value || typeof value !== 'object') continue
    const need = typeof value.need === 'string' ? value.need.trim().slice(0, 500) : ''
    if (!need) continue

    const requestedId = typeof value.id === 'string' ? value.id.trim().slice(0, 80) : ''
    const baseId = requestedId || `focus-${index + 1}`
    let id = baseId
    let suffix = 2
    while (ids.has(id)) {
      id = `${baseId}-${suffix}`
      suffix += 1
    }
    ids.add(id)
    normalized.push({
      id,
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
  const indexedDocuments = documents.map(indexEvidenceDocument)

  for (const item of focus) {
    const tokens = tokenizeFocus(item.need)
    const clauses = tokenizeFocusClauses(item.need)
    const perPassageChars = Math.max(
      MIN_PASSAGE_CHARS,
      Math.min(MAX_PASSAGE_CHARS, Math.floor(passageBudget / focus.length / item.minSources))
    )
    const candidates = tokens.length > 0
      ? indexedDocuments
          .map((document) => bestDocumentPassage(document, tokens, clauses, perPassageChars))
          .filter((candidate): candidate is PassageCandidate => candidate !== null)
          .sort(compareCandidates)
      : []

    const selected: PassageCandidate[] = []
    const fingerprints = new Set<string>()
    const urls = new Set<string>()
    for (const candidate of candidates) {
      if (fingerprints.has(candidate.documentFingerprint) || urls.has(candidate.canonicalUrl)) continue
      fingerprints.add(candidate.documentFingerprint)
      urls.add(candidate.canonicalUrl)
      selected.push(candidate)
      if (selected.length >= item.minSources) break
    }

    passages.push(...selected.map(({
      score: _score,
      documentFingerprint: _fingerprint,
      canonicalUrl: _canonicalUrl,
      ...passage
    }) => ({
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
  indexed: IndexedEvidenceDocument,
  focusTokens: string[],
  focusClauses: string[][],
  maxChars: number
): PassageCandidate | null {
  const { document, lines } = indexed
  const passageFocusTokens = focusTokens
  const titleMatches = focusTokens.filter((token) => indexed.titleTokens.has(token))
  // A strongly matching title is meaningful discovery evidence, especially
  // for issues, forum threads, reviews, and release notes. It should lower the
  // bar for locating a useful body window, not remove those terms and make the
  // body satisfy an unrelated remainder of the request.
  const requiredMatches = titleMatches.length >= 2
    ? 1
    : Math.min(3, Math.max(1, Math.ceil(passageFocusTokens.length * 0.6)))
  const passageClauses = focusClauses
    .filter((clause) => clause.length > 0)
  let best: {
    lineStart: number
    lineEnd: number
    columnStart: number
    columnEnd: number
    text: string
    truncated: boolean
    score: number
    matchedTerms: string[]
  } | null = null

  for (const lineIndex of lines.keys()) {
    const lineTokens = indexed.lineTokens[lineIndex] ?? new Set<string>()
    const localMatches = focusTokens.filter((token) => lineTokens.has(token))
    if (localMatches.length === 0) continue
    const windowTokens = indexed.windowTokens[lineIndex] ?? new Set<string>()
    const matchedTerms = passageFocusTokens.filter((token) => windowTokens.has(token))
    if (matchedTerms.length < requiredMatches) continue
    if (!clausesCovered(windowTokens, passageClauses)) continue
    const requiredExactTerms = passageFocusTokens.filter((token) => /\d/.test(token))
    if (requiredExactTerms.some((token) => !windowTokens.has(token))) continue
    const normalizedLine = indexed.windowText[lineIndex] ?? ''
    const normalizedNeed = normalizeText(focusTokens.join(' '))
    const exactPhrase = normalizedNeed.length > 0 && normalizedLine.includes(normalizedNeed)
    const preliminaryScore = matchedTerms.length * 30 + localMatches.length * 8 + (exactPhrase ? 100 : 0)
    const window = buildPassageWindow(
      lines,
      lineIndex,
      passageFocusTokens,
      maxChars,
      passageClauses.length > 1
    )
    const visibleTokens = new Set(tokenize(window.text))
    const visibleMatchedTerms = passageFocusTokens.filter((token) => visibleTokens.has(token))
    if (visibleMatchedTerms.length < requiredMatches) continue
    if (!clausesCovered(visibleTokens, passageClauses)) continue
    if (passageFocusTokens.some((token) => /\d/.test(token) && !visibleTokens.has(token))) continue
    const score = scorePassageText(window.text, passageFocusTokens, indexed.tokenFrequency) + preliminaryScore / 100
    if (!best || score > best.score) best = { ...window, score, matchedTerms: visibleMatchedTerms }
  }

  if (!best) return null
  return {
    sourceId: document.sourceId,
    lineStart: best.lineStart,
    lineEnd: best.lineEnd,
    columnStart: best.columnStart,
    columnEnd: best.columnEnd,
    text: best.text,
    matchedTerms: best.matchedTerms,
    truncated: best.truncated,
    score: best.score,
    documentFingerprint: indexed.fingerprint,
    canonicalUrl: document.url
  }
}

function indexEvidenceDocument(document: ResearchEvidenceDocument): IndexedEvidenceDocument {
  const lines = document.content.split('\n')
  const lineTokens = lines.map((line) => new Set(tokenize(line)))
  const windows = lines.map((_line, lineIndex) => semanticWindow(lines, lineIndex).join(' '))
  const tokenFrequency = new Map<string, number>()
  for (const tokens of lineTokens) {
    for (const token of tokens) tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1)
  }
  return {
    document,
    lines,
    lineTokens,
    windowTokens: windows.map((value) => new Set(tokenize(value))),
    windowText: windows.map(normalizeText),
    tokenFrequency,
    titleTokens: new Set(tokenize(document.title)),
    fingerprint: fingerprint(document.content)
  }
}

function buildPassageWindow(
  lines: string[],
  matchIndex: number,
  focusTokens: string[],
  maxChars: number,
  semanticContext = false
): {
  lineStart: number
  lineEnd: number
  columnStart: number
  columnEnd: number
  text: string
  truncated: boolean
} {
  const matchedLine = lines[matchIndex] ?? ''
  if (matchedLine.length > maxChars) {
    const normalized = matchedLine.toLowerCase()
    const matchIndexes = focusTokens
      .map((token) => normalized.search(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i')))
      .filter((index) => index >= 0)
    const starts = unique(matchIndexes.map((index) => String(
      Math.max(0, Math.min(matchedLine.length - maxChars, index - Math.floor(maxChars / 3)))
    ))).map(Number)
    const start = starts.sort((left, right) => {
      const leftMatches = countTokenMatches(matchedLine.slice(left, left + maxChars), focusTokens)
      const rightMatches = countTokenMatches(matchedLine.slice(right, right + maxChars), focusTokens)
      return rightMatches - leftMatches || left - right
    })[0] ?? 0
    return {
      lineStart: matchIndex + 1,
      lineEnd: matchIndex + 1,
      columnStart: start,
      columnEnd: start + maxChars,
      text: matchedLine.slice(start, start + maxChars),
      truncated: true
    }
  }

  let start = matchIndex
  let end = matchIndex
  let text = matchedLine
  if (semanticContext) {
    const indexes = semanticWindowIndexes(lines, matchIndex)
    for (const index of indexes.sort((left, right) => Math.abs(left - matchIndex) - Math.abs(right - matchIndex))) {
      if (index === matchIndex) continue
      const nextStart = Math.min(start, index)
      const nextEnd = Math.max(end, index)
      const candidate = lines.slice(nextStart, nextEnd + 1).join('\n')
      if (candidate.length <= maxChars) {
        start = nextStart
        end = nextEnd
        text = candidate
      }
    }
  } else {
    let canExpandLeft = true
    let canExpandRight = true
    for (let distance = 1; distance <= 2; distance += 1) {
      const nextLeft = matchIndex - distance
      const nextRight = matchIndex + distance
      if (canExpandLeft && nextLeft >= 0) {
        const candidate = `${lines[nextLeft]}\n${text}`
        if (candidate.length <= maxChars) {
          start = nextLeft
          text = candidate
        } else canExpandLeft = false
      }
      if (canExpandRight && nextRight < lines.length) {
        const candidate = `${text}\n${lines[nextRight]}`
        if (candidate.length <= maxChars) {
          end = nextRight
          text = candidate
        } else canExpandRight = false
      }
    }
  }

  while (start < end && !lines[start]?.trim()) start += 1
  while (end > start && !lines[end]?.trim()) end -= 1
  return {
    lineStart: start + 1,
    lineEnd: end + 1,
    columnStart: 0,
    columnEnd: lines[end]?.length ?? 0,
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
  return unique(tokenize(value).filter((token) => !FOCUS_STOP_WORDS.has(token))).slice(0, 16)
}

function tokenizeFocusClauses(value: string): string[][] {
  return value
    // Keep explicit multi-part questions together for passage-window coverage,
    // but do not turn ordinary alternative lists ("CPU, crashes, or slow")
    // into mandatory clauses that every source must contain.
    .split(/(?:[;?]|\b(?:and|or)\s+(?=(?:how|what|which|where|when|whether|why)\b))/i)
    .map(tokenizeFocus)
    .filter((tokens) => tokens.length > 0)
}

function tokenize(value: string): string[] {
  return [...WORD_SEGMENTER.segment(value.normalize('NFKC').toLowerCase())]
    .filter((segment) => segment.isWordLike)
    .map(({ segment }) => normalizeToken(/^v\d/.test(segment) ? segment.slice(1) : segment))
    .filter((token) => token.length >= 2)
}

function normalizeToken(value: string): string {
  if (value.length > 3 && value.endsWith('s') && !/(ss|us|is)$/.test(value)) return value.slice(0, -1)
  if (value.length > 5 && value.endsWith('ed')) return value.slice(0, -2)
  if (value.length > 6 && value.endsWith('ing')) return value.slice(0, -3)
  return value
}

function normalizeText(value: string): string {
  return tokenize(value).join(' ')
}

function fingerprint(value: string): string {
  return normalizeText(value)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function countTokenMatches(value: string, tokens: string[]): number {
  const values = new Set(tokenize(value))
  return tokens.reduce((count, token) => count + (values.has(token) ? 1 : 0), 0)
}

function scorePassageText(value: string, focusTokens: string[], tokenFrequency: Map<string, number>): number {
  const matched = countTokenMatches(value, focusTokens)
  const exactPhrase = normalizeText(value).includes(normalizeText(focusTokens.join(' ')))
  const visible = new Set(tokenize(value))
  const rarity = focusTokens.reduce(
    (score, token) => score + (visible.has(token) ? 40 / Math.max(1, tokenFrequency.get(token) ?? 1) : 0),
    0
  )
  return matched * 30 + rarity + (exactPhrase ? 100 : 0)
}

function clausesCovered(tokens: Set<string>, clauses: string[][]): boolean {
  return clauses.every((clause) => {
    const required = Math.min(2, Math.max(1, Math.ceil(clause.length * 0.5)))
    return clause.filter((token) => tokens.has(token)).length >= required
  })
}

function semanticWindow(lines: string[], lineIndex: number): string[] {
  return semanticWindowIndexes(lines, lineIndex).map((index) => lines[index] ?? '')
}

function semanticWindowIndexes(lines: string[], lineIndex: number): number[] {
  const indexes = [lineIndex]
  for (const direction of [-1, 1]) {
    let nonempty = 0
    for (
      let index = lineIndex + direction;
      index >= 0 && index < lines.length && nonempty < MAX_CONTEXT_NONEMPTY_LINES;
      index += direction
    ) {
      indexes.push(index)
      if (lines[index]?.trim()) nonempty += 1
    }
  }
  return unique(indexes.map(String)).map(Number).sort((left, right) => left - right)
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
