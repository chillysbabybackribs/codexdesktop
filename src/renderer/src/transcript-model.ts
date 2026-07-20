import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem'
import type { FileUpdateChange } from '../../shared/codex-protocol/v2/FileUpdateChange'
import {
  workItemTypes,
  type ItemMeta,
  type TurnPlanItem,
  type WorkItem
} from './activity-model.js'

export type SystemItem = {
  type: 'system'
  id: string
  level: 'info' | 'warning' | 'error'
  text: string
}

export type ChatItem = ThreadItem | SystemItem | TurnPlanItem
export type AgentMessageItem = Extract<ThreadItem, { type: 'agentMessage' }>
export type ActivityItem = WorkItem | AgentMessageItem

export type RenderRow =
  | { kind: 'chat'; item: ChatItem; turnId: string | null }
  | { kind: 'activity'; id: string; turnId: string | null; items: ActivityItem[] }
  | { kind: 'tail'; id: string; turnId: string }

const workTypes = new Set<string>(workItemTypes)

export function isWorkItem(item: ChatItem): item is WorkItem {
  return workTypes.has(item.type)
}

function isActivityItem(
  item: ChatItem,
  turnId: string | null,
  lastAgentMessageIdByTurn: ReadonlyMap<string, string>
): item is ActivityItem {
  if (isWorkItem(item)) return true
  if (item.type !== 'agentMessage') return false

  return item.phase === 'commentary' || (
    item.phase === null &&
    turnId !== null &&
    item.id !== lastAgentMessageIdByTurn.get(turnId)
  )
}

export function buildRows(
  items: ChatItem[],
  itemMeta: Record<string, ItemMeta>,
  activeTurnId: string | null
): { rows: RenderRow[]; turnWork: Map<string, WorkItem[]> } {
  const rows: RenderRow[] = []
  const turnWork = new Map<string, WorkItem[]>()
  const activityByTurn = new Map<string, ActivityItem[]>()
  const lastAgentMessageIdByTurn = new Map<string, string>()

  for (const item of items) {
    const turnId = item.type === 'system' ? null : (itemMeta[item.id]?.turnId ?? null)
    if (item.type === 'agentMessage' && turnId) lastAgentMessageIdByTurn.set(turnId, item.id)
  }

  for (const item of items) {
    const turnId = item.type === 'system' ? null : (itemMeta[item.id]?.turnId ?? null)

    if (isActivityItem(item, turnId, lastAgentMessageIdByTurn) && turnId) {
      const activity = activityByTurn.get(turnId) ?? []
      activity.push(item)
      activityByTurn.set(turnId, activity)
    }

    if (isWorkItem(item) && turnId) {
      const work = turnWork.get(turnId) ?? []
      work.push(item)
      turnWork.set(turnId, work)
    }
  }

  const emittedActivityTurns = new Set<string>()
  const lastRowIndex = new Map<string, number>()

  for (const item of items) {
    const turnId = item.type === 'system' ? null : (itemMeta[item.id]?.turnId ?? null)

    if (isActivityItem(item, turnId, lastAgentMessageIdByTurn)) {
      if (turnId && !emittedActivityTurns.has(turnId)) {
        rows.push({ kind: 'activity', id: `activity-${turnId}`, turnId, items: activityByTurn.get(turnId) ?? [item] })
        emittedActivityTurns.add(turnId)
        lastRowIndex.set(turnId, rows.length - 1)
      } else if (!turnId) {
        rows.push({ kind: 'activity', id: `activity-${item.id}`, turnId: null, items: [item] })
      }
      continue
    }

    rows.push({ kind: 'chat', item, turnId })
    if (turnId) lastRowIndex.set(turnId, rows.length - 1)
  }

  const inserts: Array<{ index: number; row: RenderRow }> = []
  for (const turnId of turnWork.keys()) {
    if (turnId !== activeTurnId) {
      const index = lastRowIndex.get(turnId)
      if (index !== undefined) inserts.push({ index, row: { kind: 'tail', id: `tail-${turnId}`, turnId } })
    }
  }
  inserts.sort((a, b) => b.index - a.index)
  for (const insert of inserts) rows.splice(insert.index + 1, 0, insert.row)

  if (activeTurnId) rows.push({ kind: 'tail', id: `tail-${activeTurnId}`, turnId: activeTurnId })

  return { rows, turnWork }
}

export function upsertMany(current: ChatItem[], nextItems: ChatItem[]): ChatItem[] {
  const next = [...current]

  for (const item of nextItems) {
    const index = next.findIndex((currentItem) => currentItem.id === item.id)
    if (index === -1) next.push(item)
    else next[index] = mergeChatItem(next[index], item)
  }

  return next
}

export function appendAgentMessageDelta(items: ChatItem[], itemId: string, delta: string): ChatItem[] {
  const index = items.findIndex((item) => item.id === itemId)
  if (index === -1) {
    return [...items, { type: 'agentMessage', id: itemId, text: delta, phase: null, memoryCitation: null }]
  }

  return items.map((item) =>
    item.id === itemId && item.type === 'agentMessage'
      ? { ...item, text: `${item.text}${delta}` }
      : item
  )
}

export function appendCommandOutputDelta(items: ChatItem[], itemId: string, delta: string): ChatItem[] {
  return items.map((item) =>
    item.id === itemId && item.type === 'commandExecution'
      ? { ...item, aggregatedOutput: `${item.aggregatedOutput ?? ''}${delta}` }
      : item
  )
}

export function replaceFileChanges(
  items: ChatItem[],
  itemId: string,
  changes: FileUpdateChange[]
): ChatItem[] {
  const index = items.findIndex((item) => item.id === itemId)
  if (index === -1) {
    return [...items, { type: 'fileChange', id: itemId, changes, status: 'inProgress' }]
  }

  return items.map((item) =>
    item.id === itemId && item.type === 'fileChange' ? { ...item, changes } : item
  )
}

export function appendReasoningDelta(
  items: ChatItem[],
  itemId: string,
  field: 'summary' | 'content',
  partIndex: number,
  delta: string
): ChatItem[] {
  const index = items.findIndex((item) => item.id === itemId)
  if (index === -1) {
    const item: Extract<ThreadItem, { type: 'reasoning' }> = {
      type: 'reasoning',
      id: itemId,
      summary: [],
      content: []
    }
    const target = field === 'summary' ? item.summary : item.content
    while (target.length <= partIndex) target.push('')
    target[partIndex] = delta
    return [...items, item]
  }

  return items.map((item) => {
    if (item.id !== itemId || item.type !== 'reasoning') return item

    const target = field === 'summary' ? [...item.summary] : [...item.content]
    while (target.length <= partIndex) target.push('')
    target[partIndex] = `${target[partIndex]}${delta}`
    return field === 'summary' ? { ...item, summary: target } : { ...item, content: target }
  })
}

export function appendPlanDelta(items: ChatItem[], itemId: string, delta: string): ChatItem[] {
  const index = items.findIndex((item) => item.id === itemId)
  if (index === -1) return [...items, { type: 'plan', id: itemId, text: delta }]

  return items.map((item) =>
    item.id === itemId && item.type === 'plan' ? { ...item, text: `${item.text}${delta}` } : item
  )
}

export function mergeChatItem(current: ChatItem, incoming: ChatItem): ChatItem {
  if (current.type !== incoming.type) return incoming

  switch (incoming.type) {
    case 'agentMessage': {
      const existing = current as Extract<ThreadItem, { type: 'agentMessage' }>
      return { ...existing, ...incoming, text: incoming.text.length >= existing.text.length ? incoming.text : existing.text }
    }
    case 'commandExecution': {
      const existing = current as Extract<ThreadItem, { type: 'commandExecution' }>
      const incomingOutput = incoming.aggregatedOutput ?? ''
      const existingOutput = existing.aggregatedOutput ?? ''
      return { ...existing, ...incoming, aggregatedOutput: incomingOutput.length >= existingOutput.length ? incomingOutput : existingOutput }
    }
    case 'reasoning': {
      const existing = current as Extract<ThreadItem, { type: 'reasoning' }>
      return {
        ...existing,
        ...incoming,
        summary: mergeTextParts(existing.summary, incoming.summary),
        content: mergeTextParts(existing.content, incoming.content)
      }
    }
    case 'plan': {
      const existing = current as Extract<ThreadItem, { type: 'plan' }>
      return { ...existing, ...incoming, text: incoming.text.length >= existing.text.length ? incoming.text : existing.text }
    }
    default:
      return incoming
  }
}

function mergeTextParts(current: string[], incoming: string[]): string[] {
  const length = Math.max(current.length, incoming.length)
  return Array.from({ length }, (_, index) => {
    const existing = current[index] ?? ''
    const next = incoming[index] ?? ''
    return next.length >= existing.length ? next : existing
  })
}
