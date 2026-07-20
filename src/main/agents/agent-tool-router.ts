import type { SubagentSpawner, SpawnResult } from './subagent-orchestrator.js'

// Provider-neutral dispatch for the subagent tools — the spawn-side analog of
// runBrowserTool. Both the Codex dynamic-tool adapter and the Claude MCP server
// call this, so the tool behaves identically on either runtime. Kept tiny:
// Phase 1 has exactly one tool.

export const AGENT_TOOL_NAMES = ['spawn_subagent', 'spawn_subagents_parallel'] as const

export function isAgentTool(tool: string): boolean {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(tool)
}

// The parent context the caller already knows (its own thread/turn/roster key),
// threaded into the spawned child so the roster nests it and interrupts cascade.
export type AgentToolOwner = {
  parentThreadId: string | null
  parentTurnId: string | null
  parentAgentKey: string | null
  cwd: string | null
}

export type AgentToolResult = { ok: boolean } & Record<string, unknown>

// Runs a subagent tool and returns a plain JSON-able result the parent model
// reads. Never throws for an unavailable spawner or a child failure — those are
// results the model should see, matching the browser-tool convention.
export async function runAgentTool(
  tool: string,
  args: Record<string, unknown>,
  owner: AgentToolOwner,
  spawner: SubagentSpawner | null,
): Promise<AgentToolResult> {
  if (tool !== 'spawn_subagent' && tool !== 'spawn_subagents_parallel') {
    return { ok: false, error: `unknown agent tool: ${tool}` }
  }
  if (!spawner) {
    return { ok: false, error: 'spawn_subagent is not available on this transport' }
  }
  if (tool === 'spawn_subagents_parallel') {
    const tasks = Array.isArray(args.tasks)
      ? args.tasks.slice(0, 3).map(asTaskRequest).filter((task): task is NonNullable<typeof task> => task !== null)
      : []
    if (tasks.length < 2) {
      return { ok: false, error: 'spawn_subagents_parallel requires between 2 and 3 valid tasks' }
    }
    const results = await spawner.spawnManyAndAwait(tasks.map((task) => ({
      ...task,
      parentThreadId: owner.parentThreadId,
      parentTurnId: owner.parentTurnId,
      parentAgentKey: owner.parentAgentKey,
      cwd: owner.cwd,
    })))
    return {
      ok: results.every((result) => result.ok),
      status: results.every((result) => result.ok) ? 'completed' : 'partial',
      results: results.map(summarizeSpawn),
    }
  }

  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (!task) {
    return { ok: false, error: 'spawn_subagent requires a non-empty "task"' }
  }
  const title = typeof args.title === 'string' ? args.title : null
  const model = typeof args.model === 'string' ? args.model : null

  const result = await spawner.spawnAndAwait({
    parentThreadId: owner.parentThreadId,
    parentTurnId: owner.parentTurnId,
    parentAgentKey: owner.parentAgentKey,
    task,
    title,
    model,
    cwd: owner.cwd,
  })
  return summarizeSpawn(result)
}

function asTaskRequest(value: unknown): Pick<import('./subagent-orchestrator.js').SpawnRequest, 'task' | 'title' | 'model'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const task = typeof record.task === 'string' ? record.task.trim() : ''
  if (!task) return null
  return {
    task,
    title: typeof record.title === 'string' ? record.title : null,
    model: typeof record.model === 'string' ? record.model : null,
  }
}

// Shape the parent model reads: the child's answer plus enough status to reason
// about a failure/interruption without the raw internals.
function summarizeSpawn(result: SpawnResult): AgentToolResult {
  if (result.ok) {
    return { ok: true, status: result.status, result: result.finalText }
  }
  return {
    ok: false,
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
    ...(result.finalText ? { result: result.finalText } : {}),
  }
}

// Fold a runAgentTool result into the same {result, imageUrls} envelope the
// Codex/MCP routers already use for browser tools, so a spawn tool call flows
// through the identical response-building path (no images, ever).
export async function routeAgentToolCall(
  tool: string,
  args: Record<string, unknown>,
  owner: AgentToolOwner,
  spawner: SubagentSpawner | null,
): Promise<{ result: AgentToolResult; imageUrls: string[] }> {
  const result = await runAgentTool(tool, args, owner, spawner)
  return { result, imageUrls: [] }
}
