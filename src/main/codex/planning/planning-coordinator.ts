import type { JsonValue } from '../../../shared/codex-protocol/serde_json/JsonValue.js'
import type { PlanningState, PlanningStateListener, StructuredPlan } from './planning-state.js'

const readOnlyDynamicTools = new Set([
  'browser_screenshot',
  'browser_extract_page',
  'research_web',
  'ui_review',
  'submit_plan'
])

export class PlanningCoordinator {
  private readonly states = new Map<string, PlanningState>()

  constructor(private readonly onStateChanged: PlanningStateListener = () => {}) {}

  get(threadId: string): PlanningState | null {
    return this.states.get(threadId) ?? null
  }

  begin(threadId: string): PlanningState {
    const current = this.states.get(threadId)
    if (current && current.phase !== 'completed' && current.phase !== 'needsReplan') return current
    return this.save({
      threadId,
      phase: 'discovery',
      plan: null,
      revision: current?.revision ?? 0,
      approvedRevision: null,
      approvedAt: null
    })
  }

  submit(threadId: string, value: JsonValue): PlanningState {
    const current = this.begin(threadId)
    if (current.phase === 'executing') throw new Error('Cannot replace a plan while its approved revision is executing.')
    const plan = parseStructuredPlan(value)
    return this.save({
      ...current,
      phase: 'awaitingApproval',
      plan,
      revision: current.revision + 1,
      approvedRevision: null,
      approvedAt: null
    })
  }

  approve(threadId: string, revision: number): PlanningState {
    const current = this.require(threadId)
    if (current.phase !== 'awaitingApproval' || !current.plan) {
      throw new Error('There is no submitted plan awaiting approval.')
    }
    if (revision !== current.revision) throw new Error('That plan revision is stale.')
    return this.save({
      ...current,
      phase: 'executing',
      approvedRevision: revision,
      approvedAt: Date.now()
    })
  }

  requestChanges(threadId: string, revision: number): PlanningState {
    const current = this.require(threadId)
    if (current.phase !== 'awaitingApproval' || revision !== current.revision) {
      throw new Error('That plan revision is not awaiting changes.')
    }
    return this.save({ ...current, phase: 'discovery', approvedRevision: null, approvedAt: null })
  }

  finishExecution(threadId: string, succeeded: boolean): PlanningState | null {
    const current = this.states.get(threadId)
    if (!current || current.phase !== 'executing') return current ?? null
    return this.save({ ...current, phase: succeeded ? 'completed' : 'needsReplan' })
  }

  clear(threadId: string): void {
    this.states.delete(threadId)
  }

  isReadOnly(threadId: string): boolean {
    const phase = this.states.get(threadId)?.phase
    return phase === 'discovery' || phase === 'awaitingApproval'
  }

  allowsDynamicTool(threadId: string, tool: string): boolean {
    return !this.isReadOnly(threadId) || readOnlyDynamicTools.has(tool)
  }

  approvedPlanContext(threadId: string): string | null {
    const state = this.states.get(threadId)
    if (!state?.plan || state.phase !== 'executing' || state.approvedRevision !== state.revision) return null
    return JSON.stringify({ revision: state.revision, plan: state.plan })
  }

  private require(threadId: string): PlanningState {
    const state = this.states.get(threadId)
    if (!state) throw new Error('This thread has no planning session.')
    return state
  }

  private save(state: PlanningState): PlanningState {
    this.states.set(state.threadId, state)
    this.onStateChanged(state)
    return state
  }
}

function parseStructuredPlan(value: JsonValue): StructuredPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plan input must be an object.')
  const record = value as Record<string, unknown>
  const objective = requiredString(record.objective, 'objective')
  return {
    objective,
    decisions: stringArray(record.decisions, 'decisions'),
    steps: nonEmptyStringArray(record.steps, 'steps'),
    affectedFiles: stringArray(record.affectedFiles, 'affectedFiles'),
    nonGoals: stringArray(record.nonGoals, 'nonGoals'),
    acceptanceCriteria: nonEmptyStringArray(record.acceptanceCriteria, 'acceptanceCriteria'),
    risks: stringArray(record.risks, 'risks')
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`)
  return value.trim()
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings.`)
  }
  return value.map((item) => item.trim())
}

function nonEmptyStringArray(value: unknown, name: string): string[] {
  const items = stringArray(value, name)
  if (!items.length) throw new Error(`${name} must contain at least one item.`)
  return items
}
