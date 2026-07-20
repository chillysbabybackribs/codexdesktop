import type { Model } from '../../shared/session-protocol'
import type { ReasoningEffort } from '../../shared/session-protocol'
import type { ChatAttachment } from '../../shared/ipc'
import type { AgentSession } from './agent-session-model.js'
import type { LiveTurnGlance } from './audit-trigger.js'
import type { SessionStore } from './session-store.js'

export type AgentWindowProps = {
  session: AgentSession
  isSelected: boolean
  isExtended: boolean
  sessionStore: SessionStore
  workspace: string | null
  models: Model[]
  mainModel: string | null
  mainReasoningEffort: ReasoningEffort | null
  liveMainTurn: LiveTurnGlance | null
  onSetModel: (key: string, model: string) => void
  onSetModelEffort: (key: string, model: string, effort: ReasoningEffort) => void
  onSelect: (key: string) => void
  onMinimize: (key: string) => void
  onCloseSession: (key: string) => void
  onResetSession: (key: string) => void
  onPromote: (key: string) => void
  onSetRole: (key: string, role: 'reviewer' | 'helper') => void
  onToggleReport: (key: string) => void
  onSendFeedback: (key: string) => void
  onDecideSendPolicy: (key: string, policy: 'always' | 'keep') => void
  onToggleExtend: (key: string) => void
  onSend: (key: string, text: string, attachments?: ChatAttachment[]) => Promise<boolean>
  onSteer: (key: string, text: string) => Promise<boolean>
  onStop: (key: string) => Promise<void>
  onCompact: (key: string) => Promise<void>
}

export function areAgentWindowPropsEqual(
  previous: AgentWindowProps,
  next: AgentWindowProps
): boolean {
  return previous.session === next.session &&
    previous.isSelected === next.isSelected &&
    previous.isExtended === next.isExtended &&
    previous.models === next.models &&
    previous.mainModel === next.mainModel &&
    previous.mainReasoningEffort === next.mainReasoningEffort &&
    // Only auditors render the live glance; everyone else skips those updates.
    (!next.session.auditsMain || isSameLiveGlance(previous.liveMainTurn, next.liveMainTurn))
}

export function isSameLiveGlance(a: LiveTurnGlance | null, b: LiveTurnGlance | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.turnId === b.turnId &&
    a.stepCount === b.stepCount &&
    a.fileCount === b.fileCount &&
    a.lastStep === b.lastStep
}
