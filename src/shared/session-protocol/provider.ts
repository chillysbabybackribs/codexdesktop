// Provider identity and capability descriptor (Claude-prep step 4).
//
// The app never branches on "is this codex?" — it branches on capabilities.
// Divergences discovered in the first Claude integration attempt are encoded
// here up front so adapter #2 declares them instead of patching call sites.

export type ProviderId = 'codex' | 'claude'

export type ProviderCapabilities = {
  /** Mid-turn steering: text sent while a turn runs lands INSIDE that turn. */
  steering: boolean
  /** Models expose selectable reasoning-effort levels (vs thinking budgets). */
  reasoningEfforts: boolean
  /** Provider-side context compaction the app can trigger between turns. */
  compaction: 'remote' | 'none'
  /** How app tools reach the model: provider-native dynamic tools, or MCP. */
  toolTransport: 'dynamic-tools' | 'mcp'
  /** Threads persist provider-side and support resume with history pages. */
  resume: boolean
  /** Thread goal APIs (get/set/clear). */
  goals: boolean
  /** Plugin / app marketplace APIs. */
  plugins: boolean
  /** One shared server child for all sessions, or one child per session. */
  processModel: 'shared-server' | 'per-session'
  /** Emits per-model-call token usage notifications. */
  tokenTelemetry: boolean
}
