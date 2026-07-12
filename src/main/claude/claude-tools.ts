import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition
} from '@anthropic-ai/claude-agent-sdk'
import {
  browserToolDefinitions,
  executeBrowserTool,
  type BrowserToolDependencies
} from '../agent-tools/browser-tool-registry.js'

export const claudeBrowserMcpServerName = 'desktop_browser'

export const claudeBrowserToolNames = browserToolDefinitions.map(
  (definition) => `mcp__${claudeBrowserMcpServerName}__${definition.name}`
)

export function createClaudeBrowserMcpServer(
  dependencies: BrowserToolDependencies,
  getTurnId: () => string | undefined
): McpSdkServerConfigWithInstance {
  const tools = browserToolDefinitions.map((definition) => tool(
    definition.name,
    definition.description,
    definition.inputShape,
    async (args) => {
      const execution = await executeBrowserTool(definition.name, args, dependencies, {
        turnId: getTurnId()
      })

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(execution.result) },
          ...execution.imageUrls.flatMap(dataUrlToImageContent)
        ],
        structuredContent: execution.result,
        isError: !execution.result.ok
      }
    },
    { annotations: definition.annotations }
  )) as SdkMcpToolDefinition[]

  return createSdkMcpServer({
    name: claudeBrowserMcpServerName,
    version: '1.0.0',
    tools
  })
}

function dataUrlToImageContent(dataUrl: string): Array<{
  type: 'image'
  data: string
  mimeType: string
}> {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  return match ? [{ type: 'image', mimeType: match[1], data: match[2] }] : []
}

