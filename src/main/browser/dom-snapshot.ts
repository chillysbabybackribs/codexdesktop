const defaultMaxNodes = 180
const maxTextChars = 240

export type DomSnapshotNode = {
  id: string
  documentIndex: number
  nodeIndex: number
  backendNodeId: number | null
  kind: 'interactive' | 'semantic'
  tag: string
  role: string | null
  name: string | null
  text: string | null
  href: string | null
  inputType: string | null
  disabled: boolean
  checked: boolean | null
  visible: boolean | null
  bounds: { x: number; y: number; width: number; height: number } | null
  documentUrl: string | null
}

export type DomSnapshotModel = {
  documentCount: number
  totalNodeCount: number
  nodeCount: number
  omittedNodeCount: number
  nodes: DomSnapshotNode[]
}

export function buildDomSnapshotModel(raw: unknown, maxNodes = defaultMaxNodes): DomSnapshotModel {
  const snapshot = record(raw)
  const strings = Array.isArray(snapshot.strings) ? snapshot.strings.filter((value): value is string => typeof value === 'string') : []
  const documents = Array.isArray(snapshot.documents) ? snapshot.documents : []
  const candidates: Array<{ node: DomSnapshotNode; priority: number }> = []
  let totalNodeCount = 0

  for (const [documentIndex, document] of documents.entries()) {
    const documentRecord = record(document)
    const rawNodes = record(documentRecord.nodes)
    const nodeNames = numberArray(rawNodes.nodeName)
    const nodeTypes = numberArray(rawNodes.nodeType)
    const nodeValues = numberArray(rawNodes.nodeValue)
    const parents = numberArray(rawNodes.parentIndex)
    const backendNodeIds = numberArray(rawNodes.backendNodeId)
    const attributes = Array.isArray(rawNodes.attributes) ? rawNodes.attributes : []
    totalNodeCount += nodeNames.length

    const children = buildChildren(parents, nodeNames.length)
    const textFor = createTextReader(nodeNames, nodeTypes, nodeValues, children, strings)
    const bounds = layoutBounds(documentRecord.layout, strings)
    const documentUrl = stringAt(strings, documentRecord.documentURL)

    for (let nodeIndex = 0; nodeIndex < nodeNames.length; nodeIndex += 1) {
      const tag = (stringAt(strings, nodeNames[nodeIndex]) ?? '').toLowerCase()
      if (!tag || nodeTypes[nodeIndex] !== 1) continue
      const attrs = attributeMap(attributes[nodeIndex], strings)
      const classification = classifyNode(tag, attrs)
      if (!classification) continue

      const rect = bounds.get(nodeIndex) ?? null
      const text = cleanText(textFor(nodeIndex))
      const name = firstNonEmpty(attrs['aria-label'], attrs.title, attrs.placeholder, text)
      candidates.push({
        priority: nodePriority(classification.kind, nodeIndex, parents, nodeNames, strings),
        node: {
        id: `d${documentIndex}:n${nodeIndex}`,
        documentIndex,
        nodeIndex,
        backendNodeId: Number.isFinite(backendNodeIds[nodeIndex]) ? backendNodeIds[nodeIndex] : null,
        kind: classification.kind,
        tag,
        role: classification.role,
        name: name ? clip(name, maxTextChars) : null,
        text: text ? clip(text, maxTextChars) : null,
        href: attrs.href ?? null,
        inputType: tag === 'input' ? (attrs.type?.toLowerCase() || 'text') : null,
        disabled: 'disabled' in attrs || attrs['aria-disabled'] === 'true',
        checked: tag === 'input' && /^(checkbox|radio)$/i.test(attrs.type ?? '')
          ? ('checked' in attrs || attrs['aria-checked'] === 'true')
          : null,
        visible: rect ? rect.width > 0 && rect.height > 0 : null,
        bounds: rect,
        documentUrl
        }
      })
    }
  }

  const sorted = candidates.sort((left, right) =>
    left.priority - right.priority ||
    left.node.documentIndex - right.node.documentIndex ||
    left.node.nodeIndex - right.node.nodeIndex
  )
  const limited = sorted.slice(0, clampMaxNodes(maxNodes))
  return {
    documentCount: documents.length,
    totalNodeCount,
    nodeCount: limited.length,
    omittedNodeCount: Math.max(0, sorted.length - limited.length),
    nodes: limited.map(({ node }) => node)
  }
}

function classifyNode(tag: string, attrs: Record<string, string>): { kind: 'interactive' | 'semantic'; role: string | null } | null {
  const explicitRole = attrs.role?.trim().toLowerCase() || null
  if (explicitRole || 'contenteditable' in attrs) {
    return { kind: 'interactive', role: explicitRole ?? 'textbox' }
  }
  if (tag === 'a' && attrs.href) return { kind: 'interactive', role: 'link' }
  if (tag === 'button' || tag === 'summary') return { kind: 'interactive', role: 'button' }
  if (tag === 'textarea') return { kind: 'interactive', role: 'textbox' }
  if (tag === 'select') return { kind: 'interactive', role: 'combobox' }
  if (tag === 'input') return { kind: 'interactive', role: inputRole(attrs.type) }
  if (/^h[1-6]$/.test(tag)) return { kind: 'semantic', role: 'heading' }
  if (['main', 'nav', 'article', 'form', 'dialog', 'table'].includes(tag)) return { kind: 'semantic', role: tag }
  return null
}

function inputRole(type?: string): string {
  switch (type?.toLowerCase()) {
    case 'checkbox': return 'checkbox'
    case 'radio': return 'radio'
    case 'range': return 'slider'
    case 'submit':
    case 'button':
    case 'reset': return 'button'
    default: return 'textbox'
  }
}

function nodePriority(
  kind: DomSnapshotNode['kind'],
  nodeIndex: number,
  parents: number[],
  names: number[],
  strings: string[]
): number {
  let priority = kind === 'interactive' ? 0 : 1
  for (let ancestor = parents[nodeIndex], depth = 0; ancestor >= 0 && depth < 20; ancestor = parents[ancestor], depth += 1) {
    const tag = (stringAt(strings, names[ancestor]) ?? '').toLowerCase()
    if (tag === 'nav') return priority + 3
    if (tag === 'header' || tag === 'footer' || tag === 'aside') priority += 2
  }
  return priority
}

function layoutBounds(value: unknown, strings: string[]): Map<number, { x: number; y: number; width: number; height: number }> {
  void strings
  const layout = record(value)
  const indices = numberArray(layout.nodeIndex)
  const bounds = Array.isArray(layout.bounds) ? layout.bounds : []
  const result = new Map<number, { x: number; y: number; width: number; height: number }>()
  for (let index = 0; index < indices.length; index += 1) {
    const rect = bounds[index]
    if (!Array.isArray(rect) || rect.length < 4 || !rect.every((value) => typeof value === 'number' && Number.isFinite(value))) continue
    result.set(indices[index], { x: rect[0], y: rect[1], width: rect[2], height: rect[3] })
  }
  return result
}

function buildChildren(parents: number[], count: number): number[][] {
  const children = Array.from({ length: count }, (): number[] => [])
  for (let index = 0; index < parents.length; index += 1) {
    const parent = parents[index]
    if (parent >= 0 && parent < count) children[parent].push(index)
  }
  return children
}

function createTextReader(
  names: number[],
  types: number[],
  values: number[],
  children: number[][],
  strings: string[]
): (nodeIndex: number) => string {
  const cache = new Map<number, string>()
  const visit = (nodeIndex: number): string => {
    const cached = cache.get(nodeIndex)
    if (cached !== undefined) return cached
    const tag = (stringAt(strings, names[nodeIndex]) ?? '').toLowerCase()
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return ''
    const own = types[nodeIndex] === 3 ? (stringAt(strings, values[nodeIndex]) ?? '') : ''
    const text = clip([own, ...children[nodeIndex].map(visit)].join(' '), maxTextChars)
    cache.set(nodeIndex, text)
    return text
  }
  return visit
}

function attributeMap(value: unknown, strings: string[]): Record<string, string> {
  if (!Array.isArray(value)) return {}
  const attrs: Record<string, string> = {}
  for (let index = 0; index + 1 < value.length; index += 2) {
    const name = stringAt(strings, value[index])?.toLowerCase()
    const attrValue = stringAt(strings, value[index + 1])
    if (name && attrValue !== null) attrs[name] = attrValue
  }
  return attrs
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map((item) => typeof item === 'number' ? item : -1) : []
}

function stringAt(strings: string[], index: unknown): string | null {
  return typeof index === 'number' && index >= 0 && index < strings.length ? strings[index] : null
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? null
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clip(value: string, max: number): string {
  const normalized = cleanText(value)
  return normalized.length > max ? `${normalized.slice(0, max - 1).trimEnd()}…` : normalized
}

function clampMaxNodes(value: number): number {
  return Number.isFinite(value) ? Math.min(500, Math.max(1, Math.round(value))) : defaultMaxNodes
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
