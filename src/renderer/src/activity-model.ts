import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem'
import type { TurnPlanStep } from '../../shared/codex-protocol/v2/TurnPlanStep'

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
