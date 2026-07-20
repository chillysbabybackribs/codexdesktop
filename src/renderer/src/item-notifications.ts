import type { ServerNotification } from '../../shared/session-protocol'
import type { ItemMeta } from './activity-model.js'
import {
  appendAgentMessageDelta,
  appendCommandOutputDelta,
  appendPlanDelta,
  appendReasoningDelta,
  replaceFileChanges,
  upsertMany,
  type ChatItem
} from './transcript-model.js'

const itemNotificationMethods = new Set([
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/plan/delta'
])

export type ItemNotification = Extract<ServerNotification, { method:
  | 'item/started'
  | 'item/completed'
  | 'item/agentMessage/delta'
  | 'item/commandExecution/outputDelta'
  | 'item/fileChange/patchUpdated'
  | 'item/mcpToolCall/progress'
  | 'item/reasoning/summaryTextDelta'
  | 'item/reasoning/summaryPartAdded'
  | 'item/reasoning/textDelta'
  | 'item/plan/delta'
}>

export function isItemNotification(notification: ServerNotification): notification is ItemNotification {
  return itemNotificationMethods.has(notification.method)
}

export function itemNotificationId(notification: ItemNotification): string {
  return notification.method === 'item/started' || notification.method === 'item/completed'
    ? notification.params.item.id
    : notification.params.itemId
}

export function isImmediateItemNotification(notification: ItemNotification): boolean {
  return notification.method === 'item/started' ||
    notification.method === 'item/completed'
}

// Apply one display frame's worth of streaming notifications in transport
// order. Keeping this as one reducer pass means text, reasoning, terminal
// output, and growing diff snapshots produce one transcript store update.
export function reduceItemNotificationBatch(
  items: ChatItem[],
  notifications: readonly ItemNotification[]
): ChatItem[] {
  let next = items
  for (const notification of notifications) {
    next = reduceItemNotificationItems(next, notification)
  }
  return next
}

export function reduceItemNotificationItems(items: ChatItem[], notification: ItemNotification): ChatItem[] {
  switch (notification.method) {
    case 'item/started':
    case 'item/completed':
      return upsertMany(items, [notification.params.item])
    case 'item/agentMessage/delta':
      return appendAgentMessageDelta(items, notification.params.itemId, notification.params.delta)
    case 'item/commandExecution/outputDelta':
      return appendCommandOutputDelta(items, notification.params.itemId, notification.params.delta)
    case 'item/fileChange/patchUpdated':
      return replaceFileChanges(items, notification.params.itemId, notification.params.changes)
    case 'item/reasoning/summaryTextDelta':
      return appendReasoningDelta(items, notification.params.itemId, 'summary', notification.params.summaryIndex, notification.params.delta)
    case 'item/reasoning/summaryPartAdded':
      return appendReasoningDelta(items, notification.params.itemId, 'summary', notification.params.summaryIndex, '')
    case 'item/reasoning/textDelta':
      return appendReasoningDelta(items, notification.params.itemId, 'content', notification.params.contentIndex, notification.params.delta)
    case 'item/plan/delta':
      return appendPlanDelta(items, notification.params.itemId, notification.params.delta)
    case 'item/mcpToolCall/progress':
      return items
  }
}

export function reduceItemNotificationMeta(
  current: Record<string, ItemMeta>,
  notification: ItemNotification,
  options: { compactionBeforeTokens?: number | null } = {}
): Record<string, ItemMeta> {
  const itemId = itemNotificationId(notification)
  const existing = current[itemId]

  // Streaming deltas normally do not change lifecycle metadata. Returning the
  // existing map avoids waking every transcript subscriber once per transport
  // chunk before the frame-batched content update has anything new to draw.
  if (
    existing?.turnId === notification.params.turnId &&
    notification.method !== 'item/started' &&
    notification.method !== 'item/completed' &&
    notification.method !== 'item/mcpToolCall/progress'
  ) {
    return current
  }

  const next: ItemMeta = { ...existing, turnId: notification.params.turnId }

  switch (notification.method) {
    case 'item/started':
      next.startedAtMs = notification.params.startedAtMs
      if (notification.params.item.type === 'contextCompaction') {
        next.compaction = {
          beforeTokens: options.compactionBeforeTokens ?? null,
          afterTokens: null
        }
      }
      break
    case 'item/completed':
      next.completedAtMs = notification.params.completedAtMs
      break
    case 'item/mcpToolCall/progress':
      next.progress = [...(existing?.progress ?? []), notification.params.message].slice(-5)
      break
    default:
      break
  }

  return { ...current, [itemId]: next }
}
