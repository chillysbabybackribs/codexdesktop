export type MemoryPersistParams = {
  threadId: string
  title: string
  workspace: string | null
  updatedAt: string
  turns: Array<{
    user: string
    assistant: string
    completedWork?: string[]
  }>
}

export type TraceSaveParams = {
  suggestedName: string
  content: string
}

export type TraceSaveResult = {
  saved: boolean
  path?: string
}

export type TracePersistParams = {
  threadId: string
  turnId: string
  content: string
}

export type ArtifactReadImageParams = {
  artifactPath: string
}

export type ArtifactReadImageResult = {
  dataUrl: string | null
}

export type BackgroundTurnNotificationParams = {
  threadId: string
  title: string
  status: 'completed' | 'failed'
  message?: string | null
}

export type TraceLoadParams = {
  threadId: string
  turnId: string
}

export type TranscriptCachePersistParams = {
  threadId: string
  snapshot: unknown
}

export type CheckpointSummary = {
  id: string
  threadId: string
  turnId: string | null
  label: string
  createdAt: number
}

export type CheckpointRevertParams = {
  checkpointId: string
}

export type CheckpointChangedFilesParams = {
  threadId: string
  turnId: string
}

export type CheckpointRevertFilesParams = {
  checkpointId: string
  paths: string[]
}

export type MentionIndexParams = {
  workspace: string
}

export type MentionIndexResult = {
  files: string[]
  dirs: string[]
}

export type MentionReadParams = {
  workspace: string
  path: string
  kind: 'file' | 'folder'
}

export type MentionReadIpcResult = {
  content: string | null
  truncated: boolean
}
