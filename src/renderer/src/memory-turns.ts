import type { MemoryPersistParams } from '../../shared/ipc';
import type { ItemMeta, TurnMeta } from './TaskActivity';
import { visibleUserMessageText } from './ChatTranscript';
import { selectCompletedWork } from './memory-work';
import type { ChatItem } from './transcript-model';

function isTerminalTurnStatus(status: TurnMeta['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

export function completedMemoryTurns(
  items: ChatItem[],
  itemMeta: Record<string, ItemMeta>,
  turnMeta: Record<string, TurnMeta>,
): MemoryPersistParams['turns'] {
  const turns = new Map<string, { user: string; assistant: string; completedWork: string[] }>();

  for (const item of items) {
    if (item.type === 'system') continue;
    const turnId = itemMeta[item.id]?.turnId;
    if (!turnId || !isTerminalTurnStatus(turnMeta[turnId]?.status)) continue;

    const turn = turns.get(turnId) ?? { user: '', assistant: '', completedWork: [] };

    if (item.type === 'userMessage') {
      turn.user = visibleUserMessageText(item).trim();
    } else if (item.type === 'agentMessage' && item.phase !== 'commentary') {
      turn.assistant = item.text.trim();
    } else {
      const completedWork = completedWorkSummary(item);
      if (completedWork && !turn.completedWork.includes(completedWork)) {
        turn.completedWork.push(completedWork);
      }
    }

    turns.set(turnId, turn);
  }

  return [...turns.values()]
    .filter((turn) => turn.user && turn.assistant)
    .map((turn) => ({ ...turn, completedWork: selectCompletedWork(turn.completedWork) }));
}

function completedWorkSummary(item: ChatItem): string | null {
  if (item.type === 'commandExecution' && item.status !== 'inProgress') {
    const outcome =
      item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null)
        ? (commandTestOutcome(item.aggregatedOutput) ?? 'Command succeeded')
        : `Command ${item.status}${item.exitCode === null ? '' : ` with exit ${item.exitCode}`}`;
    return `${outcome}: ${singleLineClip(item.command, 150)}`;
  }

  if (item.type === 'fileChange' && item.status !== 'inProgress') {
    const paths = item.changes.map((change) => change.path).slice(0, 4);
    const omitted = item.changes.length - paths.length;
    return `File changes ${item.status}: ${paths.join(', ')}${omitted > 0 ? ` and ${omitted} more` : ''}`;
  }

  if (item.type === 'dynamicToolCall' && item.status !== 'inProgress') {
    return `Tool ${item.status}: ${item.tool}`;
  }

  if (item.type === 'mcpToolCall' && item.status !== 'inProgress') {
    return `Tool ${item.status}: ${item.server}/${item.tool}`;
  }

  return null;
}

function commandTestOutcome(output: string | null): string | null {
  if (!output) return null;
  const tests = output.match(/(?:^|\n)[^\n]*tests\s+(\d+)/i)?.[1];
  const passed = output.match(/(?:^|\n)[^\n]*pass\s+(\d+)/i)?.[1];
  const failed = output.match(/(?:^|\n)[^\n]*fail\s+(\d+)/i)?.[1];
  if (!tests || !passed || failed === undefined) return null;
  return `${passed}/${tests} tests passed, ${failed} failed`;
}

function singleLineClip(value: string, maxChars: number): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > maxChars ? `${line.slice(0, maxChars).trimEnd()}…` : line;
}
