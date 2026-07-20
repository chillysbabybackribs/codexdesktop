// The app-native session protocol: the ONLY module the renderer may import
// conversation/model types from (Claude-prep step 3 — see
// docs/phase2-session-store-2026-07-19.md and the provider-adapter plan).
//
// Today every type re-exports the Codex app-server shape unchanged, because
// the renderer already renders that shape. When a second provider adapter
// lands and a type needs to diverge from Codex's, it gets DEFINED here (and
// the adapter maps into it) — the renderer's imports never change again.
//
// Boundary rule (grep-enforced): `codex-protocol` may appear only under
// src/main/codex/ and in this file.

import type { Model as CodexModel } from '../codex-protocol/v2/Model'
import type { ProviderId } from './provider'

export type { ProviderCapabilities, ProviderId } from './provider'
export type { ReasoningEffort } from '../codex-protocol/ReasoningEffort'
export type { ServerNotification } from '../codex-protocol/ServerNotification'
export type { AppSummary } from '../codex-protocol/v2/AppSummary'
export type { CodexErrorInfo } from '../codex-protocol/v2/CodexErrorInfo'
export type { CommandAction } from '../codex-protocol/v2/CommandAction'
export type { FileUpdateChange } from '../codex-protocol/v2/FileUpdateChange'
// Provider-neutral extension of the app-server model row. Codex rows remain
// valid unchanged; external providers can attach the routing/runtime metadata
// the shared picker needs without editing generated protocol files.
export type Model = CodexModel & {
  providerId?: ProviderId
  runtimeModel?: string
  resolvedModel?: string
  supportsFastMode?: boolean
  supportsAdaptiveThinking?: boolean
}
export type { ModelRerouteReason } from '../codex-protocol/v2/ModelRerouteReason'
export type { PluginAuthPolicy } from '../codex-protocol/v2/PluginAuthPolicy'
export type { PluginMarketplaceEntry } from '../codex-protocol/v2/PluginMarketplaceEntry'
export type { PluginSummary } from '../codex-protocol/v2/PluginSummary'
export type { SkillMetadata } from '../codex-protocol/v2/SkillMetadata'
export type { Thread } from '../codex-protocol/v2/Thread'
export type { ThreadGoal } from '../codex-protocol/v2/ThreadGoal'
export type { ThreadGoalStatus } from '../codex-protocol/v2/ThreadGoalStatus'
export type { ThreadItem } from '../codex-protocol/v2/ThreadItem'
export type { ThreadTokenUsage } from '../codex-protocol/v2/ThreadTokenUsage'
export type { TokenUsageBreakdown } from '../codex-protocol/v2/TokenUsageBreakdown'
export type { Turn } from '../codex-protocol/v2/Turn'
export type { TurnError } from '../codex-protocol/v2/TurnError'
export type { TurnPlanStep } from '../codex-protocol/v2/TurnPlanStep'
export type { UserInput } from '../codex-protocol/v2/UserInput'
export type { WebSearchAction } from '../codex-protocol/v2/WebSearchAction'
