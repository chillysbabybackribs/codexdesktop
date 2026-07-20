import type { SessionEvent } from '../../shared/ipc.js'
import type { BrowserUseDecision, BrowserUseMode } from './browser-use-policy.js'

type Enforce = (threadId: string, prompt: string) => Promise<void>

type TurnPolicyState = {
  threadId: string
  turnId: string
  decision: BrowserUseDecision | null
  liveUsed: boolean
  backgroundUsed: boolean
  completed: boolean
  enforcementStarted: boolean
  attempts: number
  timer: NodeJS.Timeout | null
}

export class BrowserPolicyCoordinator {
  private readonly turns = new Map<string, TurnPolicyState>()
  private readonly enforce: Enforce

  constructor(enforce: Enforce) {
    this.enforce = enforce
  }

  register(threadId: string, turnId: string, decision: BrowserUseDecision): void {
    const state = this.state(threadId, turnId)
    state.decision = decision
    this.maybeSchedule(state)
  }

  observe(event: SessionEvent): void {
    if (event.type !== 'notification') return
    const notification = asRecord(event.notification)
    const params = asRecord(notification.params)
    const threadId = readString(params.threadId)
    if (!threadId) return

    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      const turnId = readString(params.turnId)
      if (!turnId) return
      const state = this.state(threadId, turnId)
      const lanes = browserLanesFromItem(params.item)
      if (lanes.live) state.liveUsed = true
      if (lanes.background) state.backgroundUsed = true
      return
    }

    if (notification.method === 'turn/completed') {
      const turn = asRecord(params.turn)
      const turnId = readString(turn.id)
      if (!turnId) return
      const state = this.state(threadId, turnId)
      state.completed = true
      this.maybeSchedule(state)
    }
  }

  dispose(): void {
    for (const state of this.turns.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    this.turns.clear()
  }

  private state(threadId: string, turnId: string): TurnPolicyState {
    const key = `${threadId}:${turnId}`
    let state = this.turns.get(key)
    if (!state) {
      state = {
        threadId,
        turnId,
        decision: null,
        liveUsed: false,
        backgroundUsed: false,
        completed: false,
        enforcementStarted: false,
        attempts: 0,
        timer: null,
      }
      this.turns.set(key, state)
    }
    return state
  }

  private maybeSchedule(state: TurnPolicyState): void {
    if (!state.completed || !state.decision || state.timer || state.enforcementStarted) return
    const missing = missingLanes(state.decision.mode, state.liveUsed, state.backgroundUsed)
    if (!state.decision.required || missing.length === 0) {
      this.turns.delete(`${state.threadId}:${state.turnId}`)
      return
    }
    state.timer = setTimeout(() => {
      state.timer = null
      void this.runEnforcement(state, missing)
    }, 300)
  }

  private async runEnforcement(state: TurnPolicyState, missing: string[]): Promise<void> {
    if (state.enforcementStarted) return
    state.enforcementStarted = true
    state.attempts += 1
    try {
      await this.enforce(state.threadId, enforcementPrompt(state.decision!, missing))
      this.turns.delete(`${state.threadId}:${state.turnId}`)
    } catch (error) {
      state.enforcementStarted = false
      if (state.attempts < 3) {
        state.timer = setTimeout(() => {
          state.timer = null
          void this.runEnforcement(state, missing)
        }, 500)
      } else {
        console.warn(`browser policy enforcement failed for ${state.threadId}/${state.turnId}:`, (error as Error).message)
        this.turns.delete(`${state.threadId}:${state.turnId}`)
      }
    }
  }
}

function browserLanesFromItem(value: unknown): { live: boolean; background: boolean } {
  const item = asRecord(value)
  if (item.type !== 'dynamicToolCall' && item.type !== 'mcpToolCall') return { live: false, background: false }
  const haystack = [item.tool, item.name, item.server, item.arguments]
    .map((part) => typeof part === 'string' ? part : JSON.stringify(part ?? ''))
    .join(' ')
    .toLowerCase()
  if (haystack.includes('browser_research_dual')) return { live: true, background: true }
  if (haystack.includes('research_web')) return { live: false, background: true }
  const live = /browser_(?:live_search|snapshot|navigate|flow|network|run|extract_page|cdp|screenshot)/.test(haystack)
  return { live, background: false }
}

function missingLanes(mode: BrowserUseMode, live: boolean, background: boolean): string[] {
  if (mode === 'live') return live ? [] : ['visible live browser']
  if (mode === 'background') return background ? [] : ['background research']
  if (mode === 'dual') {
    return [
      ...(!live ? ['visible live browser'] : []),
      ...(!background ? ['background research'] : []),
    ]
  }
  return []
}

function enforcementPrompt(decision: BrowserUseDecision, missing: string[]): string {
  return [
    '[Automatic browser-policy continuation]',
    `The previous turn was classified as ${decision.mode} browsing under the ${decision.preset} preset but completed without running: ${missing.join(' and ')}.`,
    `Policy reason: ${decision.reason}.`,
    'Run the missing browser lane now before answering. Use browser_research_dual when both lanes are missing. Do not answer from memory or ask the user to repeat the request.',
  ].join('\n')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
