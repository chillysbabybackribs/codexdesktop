import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  AgentRunEvent,
  AgentRunSnapshot,
  AgentRunStatus,
  SessionEvent,
} from '../../shared/ipc.js'

type EmitRun = (event: AgentRunEvent) => void

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function clip(value: string | null, max = 1000): string | null {
  if (!value) return null
  return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value
}

function codexStatus(value: unknown, fallback: unknown): AgentRunStatus {
  switch (value) {
    case 'pendingInit': return 'queued'
    case 'running': return 'working'
    case 'completed': return 'completed'
    case 'errored':
    case 'notFound': return 'failed'
    case 'interrupted':
    case 'shutdown': return 'stopped'
    default:
      return fallback === 'failed' ? 'failed' : fallback === 'completed' ? 'completed' : 'working'
  }
}

export class AgentRunBridge {
  private readonly runs = new Map<string, AgentRunSnapshot>()
  private readonly codexActiveTurns = new Map<string, string>()
  private readonly emit: EmitRun

  constructor(emit: EmitRun) {
    this.emit = emit
  }

  ingestCodex(event: SessionEvent): void {
    if (event.type !== 'notification') return
    const notification = record(event.notification)
    const params = record(notification.params)
    const threadId = text(params.threadId)
    if (notification.method === 'turn/started') {
      const turnId = text(record(params.turn).id)
      if (threadId && turnId) this.codexActiveTurns.set(threadId, turnId)
      return
    }
    if (notification.method === 'turn/completed') {
      const turn = record(params.turn)
      const turnId = text(turn.id)
      if (threadId && (!turnId || this.codexActiveTurns.get(threadId) === turnId)) {
        this.codexActiveTurns.delete(threadId)
      }
      const previous = threadId ? this.runs.get(`codex:${threadId}`) : null
      if (previous) {
        const status = codexStatus(turn.status, turn.status)
        const error = record(turn.error)
        this.publish({
          ...previous,
          status,
          progress: status === 'stopped' ? 'Agent stopped' : previous.progress,
          resultSummary: status === 'failed'
            ? clip(text(error.message) ?? previous.resultSummary)
            : previous.resultSummary,
          updatedAtMs: Date.now(),
          completedAtMs: terminal(status) ? Date.now() : null,
        })
      }
      return
    }
    if (notification.method !== 'item/started' && notification.method !== 'item/completed') return
    const item = record(params.item)
    const now = Date.now()

    if (item.type === 'collabAgentToolCall') {
      const receivers = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
        : []
      const states = record(item.agentsStates)
      for (const nativeId of receivers) {
        const state = record(states[nativeId])
        const id = `codex:${nativeId}`
        const previous = this.runs.get(id)
        this.publish({
          id,
          nativeId,
          provider: 'codex',
          lane: 'model',
          parentThreadId: text(item.senderThreadId) ?? text(params.threadId),
          parentTurnId: text(params.turnId),
          parentAgentKey: event.agentKey ?? null,
          title: previous?.title ?? titleFrom(text(item.prompt), 'Codex agent'),
          task: text(item.prompt) ?? previous?.task ?? null,
          status: codexStatus(state.status, item.status),
          progress: text(state.message),
          resultSummary: codexStatus(state.status, item.status) === 'failed' ? text(state.message) : previous?.resultSummary ?? null,
          outputPath: null,
          wakeStatus: previous?.wakeStatus ?? 'pending',
          startedAtMs: previous?.startedAtMs ?? now,
          updatedAtMs: now,
          completedAtMs: terminal(codexStatus(state.status, item.status)) ? now : null,
        })
      }
      return
    }

    if (item.type === 'subAgentActivity') {
      const nativeId = text(item.agentThreadId)
      if (!nativeId) return
      const id = `codex:${nativeId}`
      const previous = this.runs.get(id)
      const kind = text(item.kind)
      const status: AgentRunStatus = kind === 'interrupted' ? 'stopped' : 'working'
      this.publish({
        id,
        nativeId,
        provider: 'codex',
        lane: 'model',
        parentThreadId: text(params.threadId),
        parentTurnId: text(params.turnId),
        parentAgentKey: event.agentKey ?? null,
        title: previous?.title ?? titleFrom(text(item.agentPath), 'Codex agent'),
        task: previous?.task ?? null,
        status,
        progress: kind ? `Agent ${kind}` : null,
        resultSummary: previous?.resultSummary ?? null,
        outputPath: null,
        wakeStatus: previous?.wakeStatus ?? 'pending',
        startedAtMs: previous?.startedAtMs ?? now,
        updatedAtMs: now,
        completedAtMs: terminal(status) ? now : null,
      })
    }
  }

  codexActiveTurnId(threadId: string): string | null {
    return this.codexActiveTurns.get(threadId) ?? null
  }

  ingestClaude(raw: unknown, context: { threadId: string; turnId: string | null }): void {
    const message = record(raw)
    if (message.type !== 'system') return
    const subtype = text(message.subtype)
    if (!subtype?.startsWith('task_') && subtype !== 'background_tasks_changed') return
    const now = Date.now()

    if (subtype === 'background_tasks_changed') {
      const tasks = Array.isArray(message.tasks) ? message.tasks : []
      for (const value of tasks) {
        const task = record(value)
        const nativeId = text(task.task_id)
        if (!nativeId) continue
        this.publishClaude(nativeId, context, {
          status: 'working',
          title: titleFrom(text(task.description), 'Claude task'),
          task: text(task.description),
          progress: 'Running in background',
          now,
        })
      }
      return
    }

    const nativeId = text(message.task_id)
    if (!nativeId) return
    if (subtype === 'task_started') {
      this.publishClaude(nativeId, context, {
        status: 'working',
        title: titleFrom(text(message.subagent_type) ?? text(message.description), 'Claude task'),
        task: text(message.prompt) ?? text(message.description),
        progress: text(message.description) ?? 'Task started',
        now,
      })
    } else if (subtype === 'task_progress' || subtype === 'task_updated') {
      this.publishClaude(nativeId, context, {
        status: 'working',
        task: text(message.description),
        progress: text(message.summary) ?? text(message.description) ?? text(message.last_tool_name),
        now,
      })
    } else if (subtype === 'task_notification') {
      const rawStatus = text(message.status)
      this.publishClaude(nativeId, context, {
        status: rawStatus === 'completed' ? 'completed' : rawStatus === 'stopped' ? 'stopped' : 'failed',
        progress: rawStatus ? `Task ${rawStatus}` : null,
        resultSummary: text(message.summary),
        outputPath: text(message.output_file),
        now,
      })
    }
  }

  private publishClaude(
    nativeId: string,
    context: { threadId: string; turnId: string | null },
    update: {
      status: AgentRunStatus
      title?: string
      task?: string | null
      progress?: string | null
      resultSummary?: string | null
      outputPath?: string | null
      now: number
    },
  ): void {
    const id = `claude:${context.threadId}:${nativeId}`
    const previous = this.runs.get(id)
    this.publish({
      id,
      nativeId,
      provider: 'claude',
      lane: 'model',
      parentThreadId: context.threadId,
      parentTurnId: previous?.parentTurnId ?? context.turnId,
      parentAgentKey: null,
      title: update.title ?? previous?.title ?? 'Claude task',
      task: update.task ?? previous?.task ?? null,
      status: update.status,
      progress: update.progress ?? previous?.progress ?? null,
      resultSummary: clip(update.resultSummary ?? previous?.resultSummary ?? null),
      outputPath: update.outputPath ?? previous?.outputPath ?? null,
      wakeStatus: previous?.wakeStatus ?? 'pending',
      startedAtMs: previous?.startedAtMs ?? update.now,
      updatedAtMs: update.now,
      completedAtMs: terminal(update.status) ? update.now : null,
    })
  }

  private publish(run: AgentRunSnapshot): void {
    this.runs.set(run.id, run)
    this.emit({ type: 'agentRun', run })
  }
}

type ResumeParent = (threadId: string, prompt: string) => Promise<void>

type PersistedCoordinator = {
  delivered: string[]
  queued: AgentRunSnapshot[]
}

export class AgentCompletionCoordinator {
  private readonly activeTurns = new Map<string, string>()
  private readonly queued = new Map<string, Map<string, AgentRunSnapshot>>()
  private readonly delivered = new Set<string>()
  private readonly flushTimers = new Map<string, NodeJS.Timeout>()
  private readonly emit: EmitRun
  private readonly resumeParent: ResumeParent
  private readonly statePath: string
  private readonly watchdog: NodeJS.Timeout
  private hydrated = false

  constructor(options: { emit: EmitRun; resumeParent: ResumeParent; statePath: string }) {
    this.emit = options.emit
    this.resumeParent = options.resumeParent
    this.statePath = options.statePath
    void this.hydrate()
    this.watchdog = setInterval(() => this.reconcile(), 15_000)
    this.watchdog.unref?.()
  }

  observeSessionEvent(event: SessionEvent): void {
    if (event.type !== 'notification') return
    const notification = record(event.notification)
    const params = record(notification.params)
    const threadId = text(params.threadId)
    if (!threadId) return
    if (notification.method === 'turn/started') {
      const turn = record(params.turn)
      const turnId = text(turn.id)
      if (turnId) this.activeTurns.set(threadId, turnId)
    } else if (notification.method === 'turn/completed') {
      this.activeTurns.delete(threadId)
      this.scheduleFlush(threadId)
    }
  }

  observeRun(run: AgentRunSnapshot): void {
    if (run.provider === 'app' || !terminal(run.status) || !run.parentThreadId) return
    if (this.delivered.has(run.id)) {
      this.emit({ type: 'agentRun', run: { ...run, wakeStatus: 'resumed' } })
      return
    }
    const activeTurnId = this.activeTurns.get(run.parentThreadId)
    // A child that finishes while its spawning turn is still active is
    // already being observed by that model call (blocking collab/gather
    // semantics). Starting another turn would duplicate the continuation.
    if (activeTurnId && activeTurnId === run.parentTurnId) {
      this.delivered.add(run.id)
      this.emit({ type: 'agentRun', run: { ...run, wakeStatus: 'suppressed' } })
      void this.persist()
      return
    }
    const threadRuns = this.queued.get(run.parentThreadId) ?? new Map<string, AgentRunSnapshot>()
    threadRuns.set(run.id, { ...run, wakeStatus: activeTurnId ? 'queued' : 'pending' })
    this.queued.set(run.parentThreadId, threadRuns)
    this.emit({ type: 'agentRun', run: threadRuns.get(run.id)! })
    void this.persist()
    this.scheduleFlush(run.parentThreadId)
  }

  dispose(): void {
    clearInterval(this.watchdog)
    for (const timer of this.flushTimers.values()) clearTimeout(timer)
    this.flushTimers.clear()
  }

  private scheduleFlush(threadId: string): void {
    if (this.activeTurns.has(threadId) || this.flushTimers.has(threadId)) return
    const timer = setTimeout(() => {
      this.flushTimers.delete(threadId)
      void this.flush(threadId)
    }, 500)
    this.flushTimers.set(threadId, timer)
  }

  private async flush(threadId: string): Promise<void> {
    if (this.activeTurns.has(threadId)) return
    const runs = [...(this.queued.get(threadId)?.values() ?? [])]
      .filter((run) => !this.delivered.has(run.id))
    if (!runs.length) return

    const prompt = automaticContinuationPrompt(runs)
    try {
      await this.resumeParent(threadId, prompt)
      for (const run of runs) {
        this.delivered.add(run.id)
        this.emit({ type: 'agentRun', run: { ...run, wakeStatus: 'resumed', updatedAtMs: Date.now() } })
      }
      this.queued.delete(threadId)
      if (this.delivered.size > 500) {
        const keep = [...this.delivered].slice(-400)
        this.delivered.clear()
        for (const id of keep) this.delivered.add(id)
      }
      await this.persist()
    } catch (error) {
      console.warn(`failed to auto-resume parent ${threadId}:`, (error as Error).message)
      for (const run of runs) {
        this.emit({ type: 'agentRun', run: { ...run, wakeStatus: 'queued', updatedAtMs: Date.now() } })
      }
    }
  }

  private reconcile(): void {
    for (const threadId of this.queued.keys()) this.scheduleFlush(threadId)
  }

  private async hydrate(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedCoordinator
      for (const id of value.delivered ?? []) this.delivered.add(id)
      for (const run of value.queued ?? []) {
        if (!run.parentThreadId || this.delivered.has(run.id)) continue
        const threadRuns = this.queued.get(run.parentThreadId) ?? new Map<string, AgentRunSnapshot>()
        threadRuns.set(run.id, run)
        this.queued.set(run.parentThreadId, threadRuns)
      }
    } catch {
      // First run or a stale file: begin with an empty outbox.
    } finally {
      this.hydrated = true
      this.reconcile()
    }
  }

  private async persist(): Promise<void> {
    if (!this.hydrated) return
    const value: PersistedCoordinator = {
      delivered: [...this.delivered],
      queued: [...this.queued.values()].flatMap((runs) => [...runs.values()]),
    }
    try {
      await mkdir(dirname(this.statePath), { recursive: true })
      const temporary = `${this.statePath}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await rename(temporary, this.statePath)
    } catch (error) {
      console.warn('failed to persist agent completion outbox:', (error as Error).message)
    }
  }
}

function terminal(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped'
}

function titleFrom(value: string | null, fallback: string): string {
  if (!value) return fallback
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 64 ? `${compact.slice(0, 64).trimEnd()}…` : compact
}

function automaticContinuationPrompt(runs: AgentRunSnapshot[]): string {
  const reports = runs.map((run, index) => {
    const result = run.resultSummary ?? (run.outputPath ? `Output saved at ${run.outputPath}` : 'No summary was provided.')
    return `${index + 1}. ${run.title} [${run.provider}/${run.status}]: ${result}`
  })
  return [
    '[Automatic background-agent continuation]',
    `${runs.length} background agent${runs.length === 1 ? '' : 's'} finished after the previous turn became idle.`,
    ...reports,
    'Continue the original task now. Use these results, verify anything still missing, and answer the user without asking them to wake you again.',
  ].join('\n')
}
