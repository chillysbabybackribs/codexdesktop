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

  return {
    success: result.ok,
    contentItems: [
      { type: 'inputText', text: JSON.stringify(result) },
      ...imageUrls.map((imageUrl) => ({ type: 'inputImage' as const, imageUrl }))
    ]
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
