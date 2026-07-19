import type { ThreadItem } from '../../shared/session-protocol'
import type { WorkItem } from './activity-model'

type DynamicToolCallItem = Extract<ThreadItem, { type: 'dynamicToolCall' }>

export type CdpScreenshotArtifact = {
  artifactPath: string
  fileName: string
  mediaType: string
  bytes: number
  width: number | null
  height: number | null
}

export type CdpFileArtifact = {
  artifactPath: string
  fileName: string
  mediaType: string
  kind: 'pdf' | 'trace' | 'snapshot' | 'response-body'
  bytes: number
}

export function cdpScreenshotArtifact(item: DynamicToolCallItem): CdpScreenshotArtifact | null {
  if (item.tool !== 'browser_cdp' && item.tool !== 'browser_screenshot' && item.tool !== 'app_screenshot') return null

  for (const content of item.contentItems ?? []) {
    if (content.type !== 'inputText') continue
    try {
      const parsed = JSON.parse(content.text) as { result?: unknown; screenshot?: Partial<CdpScreenshotArtifact> }
      const payload = parsed.result && typeof parsed.result === 'object' ? parsed.result as { screenshot?: Partial<CdpScreenshotArtifact> } : parsed
      const screenshot = payload.screenshot
      if (!screenshot || typeof screenshot.artifactPath !== 'string' || typeof screenshot.fileName !== 'string') continue
      if (typeof screenshot.mediaType !== 'string' || typeof screenshot.bytes !== 'number') continue
      return {
        artifactPath: screenshot.artifactPath,
        fileName: screenshot.fileName,
        mediaType: screenshot.mediaType,
        bytes: screenshot.bytes,
        width: typeof screenshot.width === 'number' ? screenshot.width : null,
        height: typeof screenshot.height === 'number' ? screenshot.height : null
      }
    } catch {
      // A failed or non-JSON CDP result is not an image artifact.
    }
  }
  return null
}

export function cdpScreenshotArtifacts(items: WorkItem[]): CdpScreenshotArtifact[] {
  const artifacts = new Map<string, CdpScreenshotArtifact>()
  for (const item of items) {
    if (item.type !== 'dynamicToolCall') continue
    const artifact = cdpScreenshotArtifact(item)
    if (artifact && !artifacts.has(artifact.artifactPath)) {
      artifacts.set(artifact.artifactPath, artifact)
    }
  }
  return [...artifacts.values()]
}

export function cdpFileArtifact(item: DynamicToolCallItem): CdpFileArtifact | null {
  if (item.tool !== 'browser_cdp') return null

  for (const content of item.contentItems ?? []) {
    if (content.type !== 'inputText') continue
    try {
      const parsed = JSON.parse(content.text) as {
        result?: unknown
        pdf?: Partial<CdpFileArtifact>
        trace?: Partial<CdpFileArtifact>
        snapshot?: Partial<CdpFileArtifact>
        responseBody?: Partial<CdpFileArtifact>
      }
      const result = parsed.result && typeof parsed.result === 'object'
        ? parsed.result as typeof parsed
        : parsed
      const artifact = result.pdf ?? result.trace ?? result.snapshot ?? result.responseBody
      if (!artifact || typeof artifact.artifactPath !== 'string' || typeof artifact.fileName !== 'string') continue
      if ((artifact.kind !== 'pdf' && artifact.kind !== 'trace' && artifact.kind !== 'snapshot' && artifact.kind !== 'response-body') || typeof artifact.bytes !== 'number') continue
      return {
        artifactPath: artifact.artifactPath,
        fileName: artifact.fileName,
        mediaType: typeof artifact.mediaType === 'string' ? artifact.mediaType : '',
        kind: artifact.kind,
        bytes: artifact.bytes
      }
    } catch {
      // A failed or non-JSON CDP result is not a file artifact.
    }
  }
  return null
}
