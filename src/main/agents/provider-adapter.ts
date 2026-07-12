import type { ChatAttachment } from '../../shared/ipc.js'
import type {
  AgentEffort,
  AgentEvent,
  AgentModel,
  AgentModelRef,
  AgentProvider,
  AgentSessionRef,
  AgentSessionSummary,
  AgentTranscriptMessage,
  AgentTurnRef
} from '../../shared/agent.js'

export type AgentSessionOptions = {
  /** Stable app-owned identity, available before a provider assigns a session id. */
  clientSessionId: string
  cwd: string
  model: AgentModelRef | null
  effort: AgentEffort | null
  collaborationMode: 'default' | 'plan'
}

export type AgentSessionHandle = AgentSessionOptions & {
  session: AgentSessionRef | null
}

export type AgentTurnInput = {
  clientSessionId: string
  session: AgentSessionRef | null
  text: string
  attachments: ChatAttachment[]
  cwd: string
  model: AgentModelRef | null
  effort: AgentEffort | null
  collaborationMode: 'default' | 'plan'
}

export type AgentTurnHandle = {
  clientSessionId: string
  session: AgentSessionRef
  turn: AgentTurnRef
  model: AgentModelRef | null
  effort: AgentEffort | null
}

export interface AgentProviderAdapter {
  readonly provider: AgentProvider
  getAuthStatus(cwd?: string | null): Promise<{ authenticated: boolean; source: string | null }>
  listModels(cwd?: string | null): Promise<AgentModel[]>
  listSessions(cwd?: string | null): Promise<{ data: AgentSessionSummary[]; nextCursor: string | null }>
  readSession(session: AgentSessionRef, cwd?: string | null): Promise<AgentTranscriptMessage[]>
  startSession(options: AgentSessionOptions): Promise<AgentSessionHandle>
  resumeSession(clientSessionId: string, session: AgentSessionRef, cwd?: string | null): Promise<AgentSessionHandle>
  sendTurn(input: AgentTurnInput): Promise<AgentTurnHandle>
  steerTurn(turn: AgentTurnRef, text: string): Promise<void>
  interruptTurn(turn: AgentTurnRef): Promise<void>
  unsubscribeSession(session: AgentSessionRef): Promise<void> | void
  onEvent(listener: (event: AgentEvent) => void): () => void
}

/** Owns the authoritative mapping from provider ids to their runtime adapters. */
export class AgentProviderRegistry {
  private readonly adapters = new Map<AgentProvider, AgentProviderAdapter>()

  constructor(adapters: AgentProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: AgentProviderAdapter): void {
    if (this.adapters.has(adapter.provider)) {
      throw new Error(`Agent provider is already registered: ${adapter.provider}`)
    }
    this.adapters.set(adapter.provider, adapter)
  }

  has(provider: AgentProvider): boolean {
    return this.adapters.has(provider)
  }

  get(provider: AgentProvider): AgentProviderAdapter {
    const adapter = this.adapters.get(provider)
    if (!adapter) throw new Error(`Agent provider is not registered: ${provider}`)
    return adapter
  }

  list(): AgentProviderAdapter[] {
    return [...this.adapters.values()]
  }
}
