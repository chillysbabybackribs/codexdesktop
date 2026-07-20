// Barrel: re-exports the full IPC surface from domain modules in ./ipc/.
// Keep the exported names byte-identical to the pre-split ipc.ts.
export type {
  BrowserBounds,
  BrowserTabState,
  BrowserFindResult,
  BrowserState,
  BrowserVpnStatus,
  OmniboxSuggestion,
  OmniboxAnchor,
  OmniboxRenderPayload,
  OmniboxQueryResult,
  BrowserMenuCommand,
  BrowserMenuItem,
  BrowserMenuAnchor,
  BrowserMenuRenderPayload,
  TitlebarCalendarAnchor
} from './ipc/browser-types.js'
export type {
  CodexConnectionStatus,
  CodexStatusEvent,
  CodexNotificationEvent,
  ResearchProgressStage,
  ResearchProgress,
  CodexResearchProgressEvent,
  AgentSpawnedEvent,
  SessionEvent,
  CodexEvent,
  CodexSendMessageParams,
  CodexStartThreadParams,
  CodexResumeThreadParams,
  CodexListThreadTurnsParams,
  CodexSetGoalParams,
  CodexInterruptTurnParams,
  CodexSteerTurnParams,
  CodexListThreadsParams,
  CodexPluginQueryParams,
  CodexPluginInstallParams,
  CodexPluginReadParams,
  CodexPluginAppStatusParams,
  CodexPluginAppStatus,
  CodexPluginAppStatusResponse
} from './ipc/session-types.js'
export type {
  ChatAttachment,
  AttachmentSaveInput,
  AttachmentPreviewParams,
  AttachmentPreviewResult,
  ImageViewPreviewParams,
  ImageViewPreviewResult
} from './ipc/attachment-types.js'
export type {
  MemoryPersistParams,
  TraceSaveParams,
  TraceSaveResult,
  TracePersistParams,
  ArtifactReadImageParams,
  ArtifactReadImageResult,
  BackgroundTurnNotificationParams,
  TraceLoadParams,
  TranscriptCachePersistParams,
  CheckpointSummary,
  CheckpointRevertParams,
  CheckpointChangedFilesParams,
  CheckpointRevertFilesParams,
  MentionIndexParams,
  MentionIndexResult,
  MentionReadParams,
  MentionReadIpcResult
} from './ipc/feature-types.js'
export { ipcChannels } from './ipc/channels.js'
