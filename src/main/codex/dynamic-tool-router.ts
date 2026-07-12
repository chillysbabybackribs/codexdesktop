import type { DynamicToolCallParams } from '../../shared/codex-protocol/v2/DynamicToolCallParams.js'
import type { DynamicToolCallResponse } from '../../shared/codex-protocol/v2/DynamicToolCallResponse.js'
import {
  executeBrowserTool,
  type BrowserToolDependencies
} from '../agent-tools/browser-tool-registry.js'

export async function routeDynamicToolCall(
  params: DynamicToolCallParams,
  dependencies: BrowserToolDependencies
): Promise<DynamicToolCallResponse> {
  try {
    if (params.namespace !== null) {
      return textResponse(false, { ok: false, error: `unsupported dynamic tool namespace: ${params.namespace}` })
    }

    const execution = await executeBrowserTool(params.tool, params.arguments, dependencies, { turnId: params.turnId })
    return {
      success: execution.result.ok,
      contentItems: [
        { type: 'inputText', text: JSON.stringify(execution.result) },
        ...execution.imageUrls.map((imageUrl) => ({ type: 'inputImage' as const, imageUrl }))
      ]
    }
  } catch (error) {
    return {
      success: false,
      contentItems: [{
        type: 'inputText',
        text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }]
    }
  }
}

function textResponse(success: boolean, result: unknown): DynamicToolCallResponse {
  return {
    success,
    contentItems: [{ type: 'inputText', text: JSON.stringify(result) }]
  }
}
