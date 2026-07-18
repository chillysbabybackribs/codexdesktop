export type PageSnapshotMode = 'task' | 'content' | 'interactive'

export type PageSnapshotOptions = {
  objective?: string | null
  mode?: PageSnapshotMode | null
  selector?: string | null
  maxItems?: number | null
  maxChars?: number | null
}

export type PageSnapshotItemState = {
  read?: boolean
  checked?: boolean
  selected?: boolean
  expanded?: boolean
  pressed?: boolean | 'mixed'
  disabled?: boolean
  current?: string
  value?: string
  classTokens?: string[]
  dataTokens?: string[]
  evidence?: string[]
}

export type PageSnapshotItem = {
  ref: string
  order: number
  tag: string
  role: string | null
  name: string | null
  text: string | null
  href: string | null
  datetime: string | null
  state: PageSnapshotItemState
  visible: boolean | null
  nearbyHeading: string | null
}

export type PageSnapshotPassage = {
  order: number
  text: string
  score: number
  matchedTerms: string[]
}

export type PageSnapshotResult = {
  page: {
    url: string
    title: string
    lang: string | null
    readyState: string | null
  }
  mode: PageSnapshotMode
  scope: {
    selector: string | null
    matched: boolean
    error?: string
  }
  items: PageSnapshotItem[]
  content: string
  passages: PageSnapshotPassage[]
  coverage: {
    objectiveTerms: string[]
    matchedTerms: string[]
    gaps: string[]
    complete: boolean
    visitedNodes: number
    candidateCount: number
    omittedItems: number
  }
  timings: {
    traversalMs: number
    rankingMs: number
    totalMs: number
  }
  truncated: boolean
}

type ObjectiveTermGroup = {
  term: string
  alternatives: string[]
}

type RuntimePageSnapshotConfig = {
  objective: string
  objectiveGroups: ObjectiveTermGroup[]
  mode: PageSnapshotMode
  selector: string
  maxItems: number
  maxChars: number
  maxVisitedNodes: number
}

type RuntimeCandidate = {
  element: Element
  ref: string
  order: number
  tag: string
  role: string | null
  text: string
  nameHint: string
  href: string
  datetime: string
  state: PageSnapshotItemState
  nearbyHeading: string
  repeated: boolean
  score: number
  matchedTerms: string[]
}

type RuntimeBlock = {
  order: number
  tag: string
  text: string
  primary: boolean
  score: number
  matchedTerms: string[]
}

const DEFAULT_MAX_ITEMS = 40
const DEFAULT_MAX_CHARS = 8_000
const MIN_MAX_CHARS = 1_000
const MAX_MAX_CHARS = 100_000
const MAX_MAX_ITEMS = 200

const OBJECTIVE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'each', 'find', 'for', 'from', 'go', 'how',
  'i', 'in', 'is', 'it', 'me', 'navigate', 'of', 'on', 'or', 'page', 'please',
  'show', 'tell', 'that', 'the', 'this', 'to', 'what', 'when', 'where', 'which',
  'who', 'whether', 'with', 'first', 'last', 'latest', 'recent', 'top'
])

const OBJECTIVE_SYNONYMS: Record<string, string[]> = {
  notification: ['notification', 'notifications', 'alert', 'alerts', 'activity', 'activities', 'inbox', 'update', 'updates'],
  unread: ['unread', 'unseen', 'unviewed', 'new'],
  read: ['read', 'seen', 'viewed', 'opened'],
  message: ['message', 'messages', 'reply', 'replies', 'replied', 'mention', 'mentions', 'mentioned'],
  account: ['account', 'profile', 'user'],
  setting: ['setting', 'settings', 'preference', 'preferences', 'option', 'options'],
  error: ['error', 'errors', 'failure', 'failed', 'problem', 'problems'],
  price: ['price', 'prices', 'pricing', 'cost', 'costs'],
  download: ['download', 'downloads', 'file', 'files'],
  date: ['date', 'dates', 'time', 'times', 'datetime']
}

const OBJECTIVE_CANONICAL = new Map(
  Object.entries(OBJECTIVE_SYNONYMS).flatMap(([canonical, alternatives]) =>
    alternatives.map((alternative) => [alternative, canonical] as const)
  )
)

export function expandPageSnapshotObjectiveTerms(objective: string): ObjectiveTermGroup[] {
  const groups: ObjectiveTermGroup[] = []
  const seen = new Set<string>()
  for (const raw of tokenizeObjective(objective)) {
    if (OBJECTIVE_STOP_WORDS.has(raw) || /^\d+$/.test(raw)) continue
    const singular = raw.length > 3 && raw.endsWith('s') && !/(ss|us|is)$/.test(raw)
      ? raw.slice(0, -1)
      : raw
    const canonical = OBJECTIVE_CANONICAL.get(raw) ?? OBJECTIVE_CANONICAL.get(singular) ?? singular
    if (seen.has(canonical)) continue
    seen.add(canonical)
    const alternatives = OBJECTIVE_SYNONYMS[canonical] ?? uniqueStrings([canonical, raw, singular])
    groups.push({ term: canonical, alternatives: uniqueStrings(alternatives) })
    if (groups.length >= 16) break
  }
  return groups
}

export function buildPageSnapshotProgram(options: PageSnapshotOptions = {}): string {
  const objective = typeof options.objective === 'string' ? options.objective.trim().slice(0, 500) : ''
  const mode = isPageSnapshotMode(options.mode)
    ? options.mode
    : objective
      ? 'task'
      : 'content'
  const maxItems = clampInteger(options.maxItems, DEFAULT_MAX_ITEMS, 1, MAX_MAX_ITEMS)
  const maxChars = clampInteger(options.maxChars, DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS)
  const config: RuntimePageSnapshotConfig = {
    objective,
    objectiveGroups: expandPageSnapshotObjectiveTerms(objective),
    mode,
    selector: typeof options.selector === 'string' ? options.selector.trim().slice(0, 1_000) : '',
    maxItems,
    maxChars,
    maxVisitedNodes: Math.min(100_000, Math.max(50_000, maxItems * 1_000))
  }
  return `return (${pageSnapshotRuntime.toString()})(${JSON.stringify(config)});`
}

function pageSnapshotRuntime(config: RuntimePageSnapshotConfig): PageSnapshotResult {
  const startedAt = now()
  const textLimit = 360
  const candidatePoolLimit = Math.min(800, Math.max(40, config.maxItems * 6))
  const passagePoolLimit = Math.min(48, Math.max(12, config.maxItems * 2))
  const contentStorageChars = Math.min(240_000, Math.max(50_000, config.maxChars * 6))
  const objectiveGroups = config.objectiveGroups
  const requestedStateTerms = new Set(
    objectiveGroups
      .map(({ term }) => term)
      .filter((term) => term === 'read' || term === 'unread')
  )
  const blockTags = new Set([
    'address', 'article', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt',
    'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'main', 'p',
    'pre', 'section', 'summary', 'table', 'tbody', 'td', 'th', 'thead', 'tr'
  ])
  const headingTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
  const repeatedRoles = new Set(['article', 'listitem', 'option', 'row', 'treeitem'])
  const interactiveRoles = new Set([
    'button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'switch', 'tab',
    'textbox', 'treeitem'
  ])
  const lowValueTokens = new Set([
    'advert', 'advertisement', 'ads', 'breadcrumb', 'cookie', 'footer', 'menu',
    'newsletter', 'pagination', 'promo', 'recommend', 'related', 'share',
    'sidebar', 'social', 'sponsor', 'subscribe', 'toolbar'
  ])
  const stateTokenPattern = /^(?:active|checked|closed|disabled|enabled|inactive|new|open|opened|read|selected|seen|unread|unseen|unviewed|viewed)$/i
  const pageUrl = typeof location?.href === 'string' ? location.href : ''
  const page = {
    url: pageUrl,
    title: cleanText(document.title || '').slice(0, 300),
    lang: cleanText(document.documentElement?.getAttribute?.('lang') || '').slice(0, 40) || null,
    readyState: typeof document.readyState === 'string' ? document.readyState : null
  }
  const scope = {
    selector: config.selector || null,
    matched: false
  } as PageSnapshotResult['scope']

  let root: Node | null = document.body ?? document.documentElement
  if (config.selector) {
    try {
      root = document.querySelector(config.selector)
      scope.matched = Boolean(root)
    } catch (error) {
      root = null
      scope.error = `invalid selector: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
    }
  } else {
    scope.matched = Boolean(root)
  }

  const candidates: RuntimeCandidate[] = []
  const passages: RuntimeBlock[] = []
  const primaryContentBlocks: RuntimeBlock[] = []
  const fallbackContentBlocks: RuntimeBlock[] = []
  const seenNodes = new WeakSet<object>()
  let primaryContentChars = 0
  let fallbackContentChars = 0
  let visitedNodes = 0
  let elementOrder = 0
  let candidateCount = 0
  let traversalTruncated = false
  let lastHeading = ''

  type WalkContext = {
    candidate: RuntimeCandidate | null
    block: RuntimeBlock | null
    heading: { text: string } | null
    hidden: boolean
    lowValue: boolean
    primary: boolean
  }
  type WalkEntry =
    | { kind: 'node'; node: Node; context: WalkContext }
    | { kind: 'exit'; candidate: RuntimeCandidate | null; block: RuntimeBlock | null; heading: { text: string } | null }

  const initialContext: WalkContext = {
    candidate: null,
    block: null,
    heading: null,
    hidden: false,
    lowValue: false,
    primary: false
  }
  const stack: WalkEntry[] = root ? [{ kind: 'node', node: root, context: initialContext }] : []
  const traversalStartedAt = now()

  while (stack.length > 0 && visitedNodes < config.maxVisitedNodes) {
    const entry = stack.pop()!
    if (entry.kind === 'exit') {
      if (entry.heading) {
        const heading = cleanText(entry.heading.text).slice(0, 240)
        if (heading) lastHeading = heading
      }
      if (entry.block) finalizeBlock(entry.block)
      if (entry.candidate) finalizeCandidate(entry.candidate)
      continue
    }

    const node = entry.node
    if (!node || (typeof node === 'object' && seenNodes.has(node as object))) continue
    if (typeof node === 'object') seenNodes.add(node as object)
    visitedNodes += 1

    if (node.nodeType === Node.TEXT_NODE) {
      if (entry.context.hidden || entry.context.lowValue) continue
      const value = cleanText(node.nodeValue || '')
      if (!value) continue
      if (entry.context.candidate) {
        entry.context.candidate.text = appendBounded(entry.context.candidate.text, value, textLimit)
      }
      if (entry.context.block) {
        entry.context.block.text = appendBounded(entry.context.block.text, value, 1_500)
      }
      if (entry.context.heading) {
        entry.context.heading.text = appendBounded(entry.context.heading.text, value, 240)
      }
      continue
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      pushChildren(node, entry.context)
      continue
    }

    const element = node as Element
    const tag = element.tagName.toLowerCase()
    if (['script', 'style', 'noscript', 'template', 'svg', 'canvas'].includes(tag)) continue

    elementOrder += 1
    const primary = entry.context.primary || isPrimaryElement(element, tag)
    const explicitlyHidden = entry.context.hidden || isExplicitlyHidden(element)
    const lowValue = primary
      ? false
      : entry.context.lowValue || isLowValueElement(element, tag)
    const role = inferRole(element, tag)
    const state = readState(element)
    const repeated = isRepeatedElement(element, tag, role, state)
    const interactive = isInteractiveElement(element, tag, role)
    const shouldCreateCandidate = !explicitlyHidden && !lowValue && isCandidateElement(
      element,
      tag,
      role,
      state,
      repeated,
      interactive,
      entry.context.candidate
    )
    const createdCandidate = shouldCreateCandidate
      ? createCandidate(element, tag, role, state, repeated)
      : null
    const activeCandidate = createdCandidate ?? entry.context.candidate

    if (activeCandidate && activeCandidate !== createdCandidate) {
      enrichCandidateFromDescendant(activeCandidate, element, tag, state)
    }

    const createdHeading = headingTags.has(tag) ? { text: '' } : null
    const activeHeading = createdHeading ?? entry.context.heading
    const createdBlock = !explicitlyHidden && !lowValue && blockTags.has(tag)
      ? ({ order: elementOrder, tag, text: '', primary, score: 0, matchedTerms: [] } satisfies RuntimeBlock)
      : null
    const activeBlock = createdBlock ?? entry.context.block

    stack.push({
      kind: 'exit',
      candidate: createdCandidate,
      block: createdBlock,
      heading: createdHeading
    })
    pushChildren(element, {
      candidate: activeCandidate,
      block: activeBlock,
      heading: activeHeading,
      hidden: explicitlyHidden,
      lowValue,
      primary
    })
  }

  if (stack.length > 0) traversalTruncated = true
  const traversalMs = roundMs(now() - traversalStartedAt)
  const rankingStartedAt = now()

  const matchingCandidates = objectiveGroups.length > 0
    ? candidates.filter((candidate) => candidate.matchedTerms.length > 0)
    : candidates
  const rankedCandidates = (matchingCandidates.length > 0 ? matchingCandidates : candidates)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, config.maxItems)
  const selectedCandidates = rankedCandidates.sort((left, right) => left.order - right.order)
  let itemEntries = selectedCandidates.map((candidate) => ({
    candidate,
    item: materializeCandidate(candidate)
  }))

  const rankedPassages = passages
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, Math.min(12, passagePoolLimit))
    .sort((left, right) => left.order - right.order)
  let outputPassages: PageSnapshotPassage[] = rankedPassages.map((passage) => ({
    order: passage.order,
    text: passage.text,
    score: passage.score,
    matchedTerms: passage.matchedTerms
  }))

  const contentBlocks = primaryContentBlocks.length > 0 ? primaryContentBlocks : fallbackContentBlocks
  const itemContent = selectedCandidates.map((candidate) => candidate.text || candidate.nameHint).filter(Boolean)
  const contentSource = config.mode === 'content'
    ? contentBlocks.map(formatBlock)
    : itemContent.length > 0
      ? itemContent
      : rankedPassages.map((passage) => passage.text)
  const contentBudget = Math.max(200, Math.floor(config.maxChars * (config.mode === 'content' ? 0.5 : 0.28)))
  const joinedContent = contentSource.join('\n\n')
  let content = clipAtWord(joinedContent, contentBudget)
  let contentTruncated = content.length < joinedContent.length

  const matched = new Set<string>()
  for (const candidate of selectedCandidates) {
    for (const term of candidate.matchedTerms) matched.add(term)
  }
  for (const passage of rankedPassages) {
    for (const term of passage.matchedTerms) matched.add(term)
  }
  const objectiveTerms = objectiveGroups.map(({ term }) => term)
  const matchedTerms = objectiveTerms.filter((term) => matched.has(term))
  const gaps = objectiveTerms.filter((term) => !matched.has(term))
  const rankingMs = roundMs(now() - rankingStartedAt)

  let omittedItems = Math.max(0, candidateCount - itemEntries.length)
  let result: PageSnapshotResult = {
    page,
    mode: config.mode,
    scope,
    items: itemEntries.map(({ item }) => item),
    content,
    passages: outputPassages,
    coverage: {
      objectiveTerms,
      matchedTerms,
      gaps,
      complete: gaps.length === 0,
      visitedNodes,
      candidateCount,
      omittedItems
    },
    timings: {
      traversalMs,
      rankingMs,
      totalMs: roundMs(now() - startedAt)
    },
    truncated: traversalTruncated || contentTruncated || candidateCount > itemEntries.length
  }

  fitResult()
  return result

  function pushChildren(node: Node, context: WalkContext): void {
    const children = composedChildren(node)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child) stack.push({ kind: 'node', node: child, context })
    }
  }

  function composedChildren(node: Node): Node[] {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element & {
        shadowRoot?: ShadowRoot | null
        assignedNodes?: (options?: { flatten?: boolean }) => Node[]
      }
      const tag = element.tagName.toLowerCase()
      if (tag === 'slot' && typeof element.assignedNodes === 'function') {
        try {
          const assigned = element.assignedNodes({ flatten: true })
          if (assigned.length > 0) return assigned
        } catch {
          // Fall through to the slot's fallback children.
        }
      }
      if (element.shadowRoot) return Array.from(element.shadowRoot.childNodes)
    }
    return Array.from(node.childNodes ?? [])
  }

  function isPrimaryElement(element: Element, tag: string): boolean {
    return tag === 'main' || tag === 'article' ||
      element.getAttribute('role')?.toLowerCase() === 'main' ||
      element.getAttribute('itemprop')?.toLowerCase() === 'articlebody'
  }

  function isExplicitlyHidden(element: Element): boolean {
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return true
    const style = (element.getAttribute('style') || '').toLowerCase().replace(/\s+/g, '')
    return /(?:^|;)(?:display:none|visibility:hidden|content-visibility:hidden)(?:;|$)/.test(style)
  }

  function isLowValueElement(element: Element, tag: string): boolean {
    if (tag === 'nav' || tag === 'footer' || tag === 'aside') return true
    const role = (element.getAttribute('role') || '').toLowerCase()
    if (['banner', 'complementary', 'contentinfo', 'navigation', 'toolbar'].includes(role)) return true
    if (config.mode === 'content' && ['dialog', 'menu'].includes(role)) return true
    const tokens = normalizedTokens(`${element.id || ''} ${element.getAttribute('class') || ''}`)
    return tokens.some((token) => lowValueTokens.has(token))
  }

  function inferRole(element: Element, tag: string): string | null {
    const explicit = cleanText(element.getAttribute('role') || '').toLowerCase()
    if (explicit) return explicit
    if (tag === 'a' && element.hasAttribute('href')) return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    if (tag === 'option') return 'option'
    if (tag === 'li') return 'listitem'
    if (tag === 'tr') return 'row'
    if (tag === 'article') return 'article'
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'range') return 'slider'
      if (['button', 'reset', 'submit'].includes(type)) return 'button'
      if (type === 'search') return 'searchbox'
      return 'textbox'
    }
    return null
  }

  function readState(element: Element): PageSnapshotItemState {
    const state: PageSnapshotItemState = {}
    const evidence: string[] = []
    const classTokens = unique(normalizedTokens(element.getAttribute('class') || '')).slice(0, 10)
    if (classTokens.length > 0) {
      state.classTokens = classTokens
      evidence.push(...classTokens.slice(0, 6).map((token) => `class:${token}`))
    }

    const dataTokens: string[] = []
    for (const name of ['data-state', 'data-status', 'data-read', 'data-viewed', 'data-seen']) {
      if (!element.hasAttribute(name)) continue
      const value = cleanText(element.getAttribute(name) || '').slice(0, 80)
      if (!value && !name.startsWith('data-')) continue
      evidence.push(`${name}:${value}`)
      dataTokens.push(...normalizedTokens(value))
    }
    if (dataTokens.length > 0) state.dataTokens = unique(dataTokens).slice(0, 10)

    const ariaChecked = booleanAttribute(element, 'aria-checked')
    const nativeChecked = booleanProperty(element, 'checked')
    if (ariaChecked !== null || nativeChecked !== null) state.checked = ariaChecked ?? nativeChecked ?? false
    const ariaSelected = booleanAttribute(element, 'aria-selected')
    const nativeSelected = booleanProperty(element, 'selected')
    if (ariaSelected !== null || nativeSelected !== null) state.selected = ariaSelected ?? nativeSelected ?? false
    const expanded = booleanAttribute(element, 'aria-expanded')
    if (expanded !== null) state.expanded = expanded
    const pressedRaw = element.getAttribute('aria-pressed')
    if (pressedRaw === 'mixed') state.pressed = 'mixed'
    else {
      const pressed = booleanAttribute(element, 'aria-pressed')
      if (pressed !== null) state.pressed = pressed
    }
    const ariaDisabled = booleanAttribute(element, 'aria-disabled')
    const nativeDisabled = booleanProperty(element, 'disabled')
    if (ariaDisabled !== null || nativeDisabled !== null || element.hasAttribute('disabled')) {
      state.disabled = ariaDisabled ?? nativeDisabled ?? element.hasAttribute('disabled')
    }
    const current = cleanText(element.getAttribute('aria-current') || '')
    if (current) state.current = current.slice(0, 80)

    const value = 'value' in element && typeof (element as Element & { value?: unknown }).value === 'string'
      ? cleanText((element as Element & { value: string }).value)
      : cleanText(element.getAttribute('value') || '')
    if (value && element.getAttribute('type')?.toLowerCase() !== 'password') state.value = value.slice(0, 160)

    const stateTokens = new Set([...classTokens, ...dataTokens])
    const explicitRead = readBooleanish(element.getAttribute('data-read'))
    const explicitViewed = readBooleanish(element.getAttribute('data-viewed'))
    const explicitSeen = readBooleanish(element.getAttribute('data-seen'))
    if (explicitRead !== null) state.read = explicitRead
    else if (explicitViewed !== null) state.read = explicitViewed
    else if (explicitSeen !== null) state.read = explicitSeen
    else if (['unread', 'unseen', 'unviewed', 'new'].some((token) => stateTokens.has(token))) state.read = false
    else if (['read', 'seen', 'viewed', 'opened'].some((token) => stateTokens.has(token))) state.read = true

    for (const [name, value] of [
      ['aria-checked', element.getAttribute('aria-checked')],
      ['aria-selected', element.getAttribute('aria-selected')],
      ['aria-expanded', element.getAttribute('aria-expanded')],
      ['aria-pressed', element.getAttribute('aria-pressed')],
      ['aria-disabled', element.getAttribute('aria-disabled')],
      ['aria-current', element.getAttribute('aria-current')]
    ]) {
      if (value !== null) evidence.push(`${name}:${cleanText(value).slice(0, 80)}`)
    }
    const filteredEvidence = unique(evidence).filter((value) =>
      value.startsWith('aria-') || value.startsWith('data-') || stateTokenPattern.test(value.slice(value.indexOf(':') + 1)) ||
      /:(?:notification|message|result|row|item|card)$/i.test(value)
    ).slice(0, 12)
    if (filteredEvidence.length > 0) state.evidence = filteredEvidence
    return state
  }

  function booleanAttribute(element: Element, name: string): boolean | null {
    const value = element.getAttribute(name)
    if (value === null) return null
    if (/^(?:true|1|yes|checked|selected)$/i.test(value)) return true
    if (/^(?:false|0|no)$/i.test(value)) return false
    return null
  }

  function booleanProperty(element: Element, name: string): boolean | null {
    const value = (element as unknown as Record<string, unknown>)[name]
    return typeof value === 'boolean' ? value : null
  }

  function readBooleanish(value: string | null): boolean | null {
    if (value === null) return null
    if (/^(?:true|1|yes|read|viewed|seen|opened)$/i.test(value)) return true
    if (/^(?:false|0|no|unread|unviewed|unseen|new)$/i.test(value)) return false
    return null
  }

  function isRepeatedElement(
    element: Element,
    tag: string,
    role: string | null,
    state: PageSnapshotItemState
  ): boolean {
    if (['article', 'li', 'tr'].includes(tag) || (role && repeatedRoles.has(role))) return true
    const tokens = normalizedTokens(
      `${tag} ${element.id || ''} ${element.getAttribute('class') || ''} ${element.getAttribute('data-testid') || ''}`
    )
    if (tokens.some((token) => ['card', 'item', 'message', 'notification', 'result', 'row'].includes(token))) return true
    return state.read !== undefined || Boolean(state.dataTokens?.length)
  }

  function isInteractiveElement(element: Element, tag: string, role: string | null): boolean {
    if (role && interactiveRoles.has(role)) return true
    if (element.hasAttribute('contenteditable')) return true
    return ['a', 'button', 'input', 'select', 'summary', 'textarea'].includes(tag)
  }

  function isCandidateElement(
    element: Element,
    _tag: string,
    _role: string | null,
    state: PageSnapshotItemState,
    repeated: boolean,
    interactive: boolean,
    parentCandidate: RuntimeCandidate | null
  ): boolean {
    if (parentCandidate?.repeated) return false
    if (repeated || interactive) return true
    if (state.read !== undefined || state.checked !== undefined || state.selected !== undefined) return true
    const label = `${element.id || ''} ${element.getAttribute('class') || ''} ${element.getAttribute('data-testid') || ''}`
    return matchGroups(label).length > 0
  }

  function createCandidate(
    element: Element,
    tag: string,
    role: string | null,
    state: PageSnapshotItemState,
    repeated: boolean
  ): RuntimeCandidate {
    return {
      element,
      ref: element.id
        ? `#${cleanText(element.id).slice(0, 120)}`
        : element.getAttribute('data-testid')
          ? `testid:${cleanText(element.getAttribute('data-testid') || '').slice(0, 120)}`
          : `e${elementOrder}`,
      order: elementOrder,
      tag,
      role,
      text: '',
      nameHint: cleanText(
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.getAttribute('alt') ||
        element.getAttribute('placeholder') ||
        ''
      ).slice(0, 240),
      href: readHref(element),
      datetime: cleanText(element.getAttribute('datetime') || '').slice(0, 120),
      state,
      nearbyHeading: lastHeading,
      repeated,
      score: 0,
      matchedTerms: []
    }
  }

  function enrichCandidateFromDescendant(
    candidate: RuntimeCandidate,
    element: Element,
    tag: string,
    state: PageSnapshotItemState
  ): void {
    if (!candidate.href && tag === 'a') candidate.href = readHref(element)
    if (!candidate.datetime && tag === 'time') {
      candidate.datetime = cleanText(element.getAttribute('datetime') || '').slice(0, 120)
    }
    if (candidate.state.read === undefined && state.read !== undefined) candidate.state.read = state.read
    if (candidate.state.selected === undefined && state.selected !== undefined) candidate.state.selected = state.selected
    if (candidate.state.checked === undefined && state.checked !== undefined) candidate.state.checked = state.checked
    if (state.evidence?.length) {
      candidate.state.evidence = unique([...(candidate.state.evidence ?? []), ...state.evidence]).slice(0, 12)
    }
  }

  function readHref(element: Element): string {
    const raw = element.getAttribute('href') || ''
    if (!raw) return ''
    try {
      return new URL(raw, pageUrl || 'https://snapshot.invalid/').href.slice(0, 800)
    } catch {
      return raw.slice(0, 800)
    }
  }

  function finalizeCandidate(candidate: RuntimeCandidate): void {
    candidate.text = cleanText(candidate.text).slice(0, textLimit)
    if (!candidate.text && !candidate.nameHint && !candidate.href && Object.keys(candidate.state).length === 0) return
    candidateCount += 1
    inferStructuredReadState(candidate)
    const stateText = [
      candidate.state.read === false ? 'unread unseen unviewed new' : '',
      candidate.state.read === true ? 'read seen viewed opened' : '',
      ...(candidate.state.classTokens ?? []),
      ...(candidate.state.dataTokens ?? []),
      ...(candidate.state.evidence ?? [])
    ].join(' ')
    const haystack = `${candidate.tag} ${candidate.role || ''} ${candidate.nameHint} ${candidate.text} ${candidate.href} ${stateText}`
    candidate.matchedTerms = matchGroups(haystack).filter((term) => !requestedStateTerms.has(term))
    if (candidate.state.read !== undefined) {
      for (const term of requestedStateTerms) {
        if (!candidate.matchedTerms.includes(term)) candidate.matchedTerms.push(term)
      }
    }
    const stateQueryMatches = candidate.state.read !== undefined &&
      candidate.matchedTerms.some((term) => term === 'read' || term === 'unread')
      ? 1
      : 0
    const nonStateMatches = candidate.matchedTerms.filter((term) => term !== 'read' && term !== 'unread').length
    candidate.score = (nonStateMatches + stateQueryMatches) * 100 +
      (candidate.repeated ? 24 : 0) +
      (candidate.role && interactiveRoles.has(candidate.role) ? 10 : 0) +
      (candidate.state.read !== undefined ? 30 : 0) +
      (candidate.state.selected !== undefined ? 10 : 0) +
      Math.min(20, Math.floor(candidate.text.length / 24))
    keepBest(candidates, candidate, candidatePoolLimit, compareCandidateQuality)
  }

  function inferStructuredReadState(candidate: RuntimeCandidate): void {
    if (candidate.state.read !== undefined || candidate.state.selected === undefined || requestedStateTerms.size === 0) return
    const identityTokens = new Set(normalizedTokens([
      candidate.tag,
      candidate.role || '',
      candidate.element.id || '',
      candidate.element.getAttribute('class') || '',
      candidate.element.getAttribute('data-testid') || ''
    ].join(' ')))
    const notificationLike = ['activity', 'inbox', 'message', 'notification'].some((token) => identityTokens.has(token))
    const rowLike = ['card', 'item', 'row'].some((token) => identityTokens.has(token))
    if (!notificationLike || !rowLike) return

    // Inbox components commonly render unread rows using their selected
    // visual state. Keep the inference narrowly scoped to notification-like
    // repeated rows and include the source evidence so callers can audit it.
    candidate.state.read = !candidate.state.selected
    candidate.state.evidence = unique([
      ...(candidate.state.evidence ?? []),
      candidate.state.selected ? 'inferred:selected-unread' : 'inferred:unselected-read'
    ]).slice(0, 12)
  }

  function finalizeBlock(block: RuntimeBlock): void {
    block.text = cleanText(block.text)
    if (block.text.length < 3) return
    if (headingTags.has(block.tag)) block.text = `${'#'.repeat(Number(block.tag.slice(1)) || 1)} ${block.text}`
    block.text = block.text.slice(0, 1_500)
    block.matchedTerms = matchGroups(block.text).filter((term) => !requestedStateTerms.has(term))
    block.score = block.matchedTerms.length * 100 + (block.primary ? 20 : 0) + Math.min(30, Math.floor(block.text.length / 40))
    if (block.matchedTerms.length > 0 || objectiveGroups.length === 0) {
      keepBest(passages, { ...block }, passagePoolLimit, compareBlockQuality)
    }

    if (block.primary) {
      if (primaryContentChars < contentStorageChars) {
        primaryContentBlocks.push({ ...block })
        primaryContentChars += block.text.length
      }
    } else if (fallbackContentChars < contentStorageChars) {
      fallbackContentBlocks.push({ ...block })
      fallbackContentChars += block.text.length
    }
  }

  function materializeCandidate(candidate: RuntimeCandidate): PageSnapshotItem {
    const text = cleanText(candidate.text).slice(0, textLimit) || null
    return {
      ref: candidate.ref,
      order: candidate.order,
      tag: candidate.tag,
      role: candidate.role,
      name: candidate.nameHint || text?.slice(0, 240) || null,
      text,
      href: candidate.href || null,
      datetime: candidate.datetime || null,
      state: candidate.state,
      visible: detectVisibility(candidate.element),
      nearbyHeading: candidate.nearbyHeading || null
    }
  }

  function detectVisibility(element: Element): boolean | null {
    if (isExplicitlyHidden(element)) return false
    try {
      const view = document.defaultView as (Window & typeof globalThis) | null
      const style = typeof view?.getComputedStyle === 'function' ? view.getComputedStyle(element) : null
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) return false
      if (typeof (element as Element & { getClientRects?: () => DOMRectList }).getClientRects === 'function') {
        const rects = (element as Element & { getClientRects: () => DOMRectList }).getClientRects()
        return rects.length > 0
      }
      return style ? true : null
    } catch {
      return null
    }
  }

  function matchGroups(value: string): string[] {
    if (objectiveGroups.length === 0) return []
    const tokens = new Set(normalizedTokens(value))
    return objectiveGroups
      .filter((group) => group.alternatives.some((alternative) => tokens.has(alternative)))
      .map(({ term }) => term)
  }

  function formatBlock(block: RuntimeBlock): string {
    return block.text
  }

  function compareCandidateQuality(left: RuntimeCandidate, right: RuntimeCandidate): number {
    return left.score - right.score || right.order - left.order
  }

  function compareBlockQuality(left: RuntimeBlock, right: RuntimeBlock): number {
    return left.score - right.score || right.order - left.order
  }

  function keepBest<T>(values: T[], value: T, limit: number, compare: (left: T, right: T) => number): void {
    if (values.length < limit) {
      values.push(value)
      return
    }
    let worstIndex = 0
    for (let index = 1; index < values.length; index += 1) {
      if (compare(values[index], values[worstIndex]) < 0) worstIndex = index
    }
    if (compare(value, values[worstIndex]) > 0) values[worstIndex] = value
  }

  function fitResult(): void {
    let serializedChars = JSON.stringify(result).length
    if (serializedChars <= config.maxChars) return
    result.truncated = true

    if (result.content) {
      const reduction = Math.min(result.content.length, serializedChars - config.maxChars + 64)
      result.content = clipAtWord(result.content, Math.max(0, result.content.length - reduction))
      content = result.content
      contentTruncated = true
      serializedChars = JSON.stringify(result).length
    }
    while (serializedChars > config.maxChars && outputPassages.length > 0) {
      outputPassages.pop()
      result.passages = outputPassages
      serializedChars = JSON.stringify(result).length
    }
    while (serializedChars > config.maxChars && itemEntries.length > 1) {
      let worstIndex = 0
      for (let index = 1; index < itemEntries.length; index += 1) {
        if (compareCandidateQuality(itemEntries[index].candidate, itemEntries[worstIndex].candidate) < 0) worstIndex = index
      }
      itemEntries.splice(worstIndex, 1)
      itemEntries.sort((left, right) => left.candidate.order - right.candidate.order)
      result.items = itemEntries.map(({ item }) => item)
      omittedItems += 1
      result.coverage.omittedItems = Math.max(result.coverage.omittedItems, omittedItems)
      serializedChars = JSON.stringify(result).length
    }
    if (serializedChars > config.maxChars) {
      for (const item of result.items) {
        if (item.text && item.text.length > 120) item.text = `${item.text.slice(0, 119).trimEnd()}…`
        if (item.name && item.name.length > 120) item.name = `${item.name.slice(0, 119).trimEnd()}…`
        if (item.state.evidence && item.state.evidence.length > 4) item.state.evidence = item.state.evidence.slice(0, 4)
        if (item.state.classTokens && item.state.classTokens.length > 4) item.state.classTokens = item.state.classTokens.slice(0, 4)
      }
      serializedChars = JSON.stringify(result).length
    }
    if (serializedChars > config.maxChars) {
      result = {
        page: result.page,
        mode: result.mode,
        scope: result.scope,
        items: [],
        content: '',
        passages: [],
        coverage: result.coverage,
        timings: result.timings,
        truncated: true
      }
    }
  }

  function appendBounded(current: string, value: string, limit: number): string {
    if (current.length >= limit) return current
    const separator = current ? ' ' : ''
    return `${current}${separator}${value}`.slice(0, limit)
  }

  function cleanText(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
  }

  function normalizedTokens(value: string): string[] {
    return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  }

  function unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))]
  }

  function clipAtWord(value: string, limit: number): string {
    if (limit <= 0) return ''
    if (value.length <= limit) return value
    const clipped = value.slice(0, limit)
    return clipped.replace(/\s+\S*$/, '').trimEnd() || clipped
  }

  function now(): number {
    return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()
  }

  function roundMs(value: number): number {
    return Math.round(value * 100) / 100
  }
}

function tokenizeObjective(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function isPageSnapshotMode(value: unknown): value is PageSnapshotMode {
  return value === 'task' || value === 'content' || value === 'interactive'
}

function clampInteger(value: number | null | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}
