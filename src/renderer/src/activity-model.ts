import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem'
import type { TurnPlanStep } from '../../shared/codex-protocol/v2/TurnPlanStep'
import type { CodexResearchProgressEvent } from '../../shared/ipc.js'

export type TurnPlanItem = {
  type: 'turnPlan'
  id: string
  explanation: string | null
  steps: TurnPlanStep[]
}

export type ItemMeta = {
  turnId: string | null
  startedAtMs?: number
  completedAtMs?: number
  progress?: string[]
  compaction?: { beforeTokens: number | null; afterTokens: number | null }
}

export const workItemTypes = [
  'reasoning',
  'plan',
  'turnPlan',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageGeneration',
  'imageView',
  'sleep'
] as const

export type WorkItem = Extract<ThreadItem, { type: (typeof workItemTypes)[number] }> | TurnPlanItem

export function reduceResearchProgressMeta(
  current: Record<string, ItemMeta>,
  event: CodexResearchProgressEvent
): Record<string, ItemMeta> {
  const existing = current[event.itemId]
  const progress = [...(existing?.progress ?? []), event.progress.message].slice(-5)
  return {
    ...current,
    [event.itemId]: {
      ...existing,
      turnId: event.turnId,
      progress
    }
  }
}

export function latestItemProgress(meta: ItemMeta | undefined): string | null {
  return meta?.progress?.length ? meta.progress[meta.progress.length - 1] : null
}
