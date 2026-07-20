import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRunner } from '../browser/research-runner.js'
import type { ResearchProgress } from '../../shared/ipc.js'
import type { DynamicToolCallParams } from '../../shared/codex-protocol/v2/DynamicToolCallParams.js'
import type { DynamicToolCallResponse } from '../../shared/codex-protocol/v2/DynamicToolCallResponse.js'
import { runBrowserTool } from '../tools/browser-tool-registry.js'

// Thin Codex adapter over the provider-neutral browser tool registry: maps
// the app-server's item/tool/call shape onto runBrowserTool and folds the
// outcome into Codex content items (JSON text + vision images).

export async function routeDynamicToolCall(
  params: DynamicToolCallParams,
  dependencies: {
    browserAgent: BrowserAgentController
    researchRunner: ResearchRunner
    onResearchProgress?: (progress: ResearchProgress) => void
  }
): Promise<DynamicToolCallResponse> {
  if (params.namespace !== null) {
    return {
      success: false,
      contentItems: [{
        type: 'inputText',
        text: JSON.stringify({ ok: false, error: `unsupported dynamic tool namespace: ${params.namespace}` })
      }]
    }
  }

  const { result, imageUrls } = await runBrowserTool(
    {
      tool: params.tool,
      args: asRecord(params.arguments),
      owner: {
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId
      },
      callId: params.callId
    },
    dependencies
  )

  // The app-server's functions.exec bridge flattens dynamic-tool content into
  // one JavaScript string. A metadata text item followed by an image item
  // therefore becomes `{...}\ndata:image/...`, which is not a valid image URL
  // when passed to image(). Screenshot tools have exactly one image, so return
  // that image alone and preserve a directly usable data URI across the bridge.
  const isSingleImageScreenshot =
    (params.tool === 'app_screenshot' || params.tool === 'browser_screenshot') && imageUrls.length === 1

  return {
    success: result.ok,
    contentItems: isSingleImageScreenshot
      ? [{ type: 'inputImage', imageUrl: imageUrls[0] }]
      : [
          { type: 'inputText', text: JSON.stringify(result) },
          ...imageUrls.map((imageUrl) => ({ type: 'inputImage' as const, imageUrl }))
        ]
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
