import { z, type ZodType } from 'zod'
import { allToolSpecs } from '../tools/browser-tool-specs.js'
import type { BrowserToolOutcome } from '../tools/browser-tool-registry.js'

// In-process MCP browser tools for Claude sessions (the step-6 fast-follow):
// the SAME canonical specs and dispatch the codex dynamic tools and the unix
// socket use, exposed to the Agent SDK via createSdkMcpServer — no shim, no
// socket hop; handlers run inside Electron's main process.
//
// The SDK's tool() helper takes a Zod shape while the canonical specs are
// JSON Schema, so the subset our specs use is converted here. Precision is
// informative, not protective — runBrowserTool re-validates every argument.

type JsonSchema = Record<string, unknown>

export function jsonSchemaPropertyToZod(property: unknown): ZodType {
  const schema = asRecord(property)
  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === 'string')) {
    return schema.enum.length > 0
      ? z.enum(schema.enum as [string, ...string[]])
      : z.string()
  }
  switch (schema.type) {
    case 'string':
      return z.string()
    case 'number':
    case 'integer':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'array': {
      const items = schema.items === undefined ? z.any() : jsonSchemaPropertyToZod(schema.items)
      return z.array(items)
    }
    case 'object':
      return z.record(z.string(), z.any())
    default:
      return z.any()
  }
}

export function jsonSchemaToZodShape(schema: unknown): Record<string, ZodType> {
  const record = asRecord(schema)
  const properties = asRecord(record.properties)
  const required = new Set(Array.isArray(record.required) ? record.required : [])
  const shape: Record<string, ZodType> = {}
  for (const [name, property] of Object.entries(properties)) {
    const type = jsonSchemaPropertyToZod(property)
    shape[name] = required.has(name) ? type : type.optional()
  }
  return shape
}

export type ClaudeMcpToolDispatch = (tool: string, args: Record<string, unknown>) => Promise<BrowserToolOutcome>

type SdkToolFactory = (
  name: string,
  description: string,
  inputSchema: Record<string, ZodType>,
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>
) => unknown

type SdkServerFactory = (options: { name: string; version?: string; tools?: unknown[] }) => unknown

export function buildClaudeBrowserMcpServer(
  sdk: { tool: SdkToolFactory; createSdkMcpServer: SdkServerFactory },
  dispatch: ClaudeMcpToolDispatch
): unknown {
  const tools = allToolSpecs
    .filter((spec): spec is Extract<typeof spec, { type: 'function' }> => spec.type === 'function')
    .map((spec) =>
      sdk.tool(
        spec.name,
        spec.description,
        jsonSchemaToZodShape(spec.inputSchema as JsonSchema),
        async (args) => {
          const outcome = await dispatch(spec.name, args)
          return {
            content: [
              { type: 'text', text: JSON.stringify(outcome.result) },
              ...outcome.imageUrls
                .map(imageContent)
                .filter((item): item is NonNullable<typeof item> => item !== null)
            ],
            isError: !outcome.result.ok
          }
        }
      )
    )

  return sdk.createSdkMcpServer({
    name: 'browser',
    version: '0.1.0',
    tools
  })
}

function imageContent(dataUrl: string): { type: 'image'; data: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl)
  if (!match) return null
  return { type: 'image', data: match[2], mimeType: match[1] }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
