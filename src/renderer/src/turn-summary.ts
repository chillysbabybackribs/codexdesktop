import type { CommandAction } from '../../shared/session-protocol'
import type { ThreadItem } from '../../shared/session-protocol'
import { cleanCommand, commandDescriptionOf, narrateCommand } from './command-narrate'
import { parseUnifiedDiff } from './diff'
import { basename, fmtTokens, truncate } from './activity-format'
import { latestItemProgress, type ItemMeta, type WorkItem } from './activity-model'
import type { TurnMeta, TurnTokenTelemetry } from './turn-telemetry'

type FileChangeItem = Extract<ThreadItem, { type: 'fileChange' }>

export function isBrowseAction(action: CommandAction): boolean {
  return action.type === 'read' || action.type === 'listFiles' || action.type === 'search'
}

// Human label for what Codex is doing right now, from the newest live item.
export function currentActionLabel(
  items: WorkItem[],
  itemMeta: Record<string, ItemMeta>,
  streamingMessage: boolean
): string {
  // The turn plan is a status board, not an action — skip it when deciding
  // what Codex is doing right now.
  const scan = items.filter((item) => item.type !== 'turnPlan')

  for (let i = scan.length - 1; i >= 0; i -= 1) {
    const item = scan[i]
    const running =
      'status' in item && typeof item.status === 'string'
        ? item.status === 'inProgress'
        : i === scan.length - 1 && !itemMeta[item.id]?.completedAtMs

    if (!running) {
      continue
    }

    switch (item.type) {
      case 'reasoning':
        return 'Thinking'
      case 'plan':
        return 'Planning'
      case 'commandExecution': {
        const action = item.commandActions.find(isBrowseAction)
        if (action && item.commandActions.every(isBrowseAction)) {
          if (action.type === 'read') {
            return `Reading ${action.name}`
          }
          if (action.type === 'search') {
            return action.query ? `Searching "${truncate(action.query, 32)}"` : 'Searching files'
          }
          return 'Listing files'
        }
        const narration = narrateCommand(item.command, item.commandActions, commandDescriptionOf(item))
        return narration.natural ? truncate(narration.running, 48) : `Running ${truncate(cleanCommand(item.command), 38)}`
      }
      case 'fileChange': {
        const path = item.changes[0]?.path
        return path ? `Editing ${basename(path)}` : 'Editing files'
      }
      case 'mcpToolCall':
        return `Calling ${item.server}.${item.tool}`
      case 'dynamicToolCall': {
        const progress = item.tool === 'research_web' ? latestItemProgress(itemMeta[item.id]) : null
        if (progress) return progress
        return `Calling ${item.tool}`
      }
      case 'webSearch':
        return 'Searching the web'
      case 'imageGeneration':
        return 'Generating image'
      case 'subAgentActivity':
      case 'collabAgentToolCall':
        return 'Coordinating agents'
      case 'sleep':
        return 'Waiting'
      default:
        break
    }
  }

  return streamingMessage ? 'Writing' : 'Working'
}

export function turnSummaryParts(items: WorkItem[], meta: TurnMeta | undefined): string[] {
  const parts: string[] = []

  const diffSummary = meta?.diffSummary
  if (diffSummary && diffSummary.files > 0) {
    parts.push(
      `${diffSummary.files} ${diffSummary.files === 1 ? 'file' : 'files'} +${diffSummary.adds} −${diffSummary.dels}`
    )
  } else {
    const fileItems = items.filter((item): item is FileChangeItem => item.type === 'fileChange')
    if (fileItems.length) {
      const paths = new Set(fileItems.flatMap((item) => item.changes.map((change) => change.path)))
      let adds = 0
      let dels = 0
      for (const fileItem of fileItems) {
        for (const change of fileItem.changes) {
          const parsed = parseUnifiedDiff(
            change.diff,
            change.kind.type === 'add' ? 'add' : change.kind.type === 'delete' ? 'del' : undefined
          )
          adds += parsed.adds
          dels += parsed.dels
        }
      }
      parts.push(`${paths.size} ${paths.size === 1 ? 'file' : 'files'} +${adds} −${dels}`)
    }
  }

  const commands = items.filter((item) => item.type === 'commandExecution').length
  if (commands) {
    parts.push(`${commands} ${commands === 1 ? 'command' : 'commands'}`)
  }

  const searches = items.filter((item) => item.type === 'webSearch').length
  if (searches) {
    parts.push(`${searches} ${searches === 1 ? 'search' : 'searches'}`)
  }

  const toolCalls = items.filter((item) => item.type === 'mcpToolCall' || item.type === 'dynamicToolCall').length
  if (toolCalls) {
    parts.push(`${toolCalls} ${toolCalls === 1 ? 'tool call' : 'tool calls'}`)
  }

  const tokens = meta?.tokens?.turn.totalTokens
  if (tokens) {
    parts.push(`${fmtTokens(tokens)} tokens`)
  }

  return parts
}

export function tokenTooltip(tokens: TurnTokenTelemetry | undefined): string | undefined {
  if (!tokens) {
    return undefined
  }
  const { turn, latestCall } = tokens
  const parts = [
    `${tokens.modelCallCount} model ${tokens.modelCallCount === 1 ? 'call' : 'calls'}`,
    `turn input ${fmtTokens(turn.inputTokens)}`,
    `cached ${fmtTokens(turn.cachedInputTokens)}`,
    `output ${fmtTokens(turn.outputTokens)}`,
    `reasoning ${fmtTokens(turn.reasoningOutputTokens)}`,
    `latest call ${fmtTokens(latestCall.totalTokens)}`
  ]
  if (tokens.modelContextWindow) {
    parts.push(`context ${fmtTokens(tokens.modelContextWindow)}`)
  }
  return parts.join(' · ')
}
