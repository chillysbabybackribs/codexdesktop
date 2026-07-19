import assert from 'node:assert/strict'
import test from 'node:test'
import { buildClaudeBrowserMcpServer, jsonSchemaToZodShape } from './claude-mcp-tools.ts'
import { browserToolSpecs } from '../tools/browser-tool-specs.ts'

test('every canonical tool spec converts to a zod shape without loss of required-ness', () => {
  const functionSpecs = browserToolSpecs.filter(
    (spec): spec is Extract<typeof spec, { type: 'function' }> => spec.type === 'function'
  )
  assert.ok(functionSpecs.length >= 9, `expected the full tool set, got ${functionSpecs.length}`)

  for (const spec of functionSpecs) {
    const shape = jsonSchemaToZodShape(spec.inputSchema)
    const schema = spec.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
    const propertyNames = Object.keys(schema.properties ?? {})
    assert.deepEqual(Object.keys(shape).sort(), propertyNames.sort(), spec.name)
    for (const required of schema.required ?? []) {
      assert.equal(shape[required].safeParse(undefined).success, false, `${spec.name}.${required} must be required`)
    }
  }
})

test('converted shapes accept valid values and reject wrong primitive types', () => {
  const shape = jsonSchemaToZodShape({
    type: 'object',
    properties: {
      objective: { type: 'string' },
      maxItems: { type: 'number' },
      mode: { enum: ['task', 'content', 'interactive'] },
      steps: { type: 'array' }
    },
    required: ['objective']
  })
  assert.equal(shape.objective.safeParse('find the login form').success, true)
  assert.equal(shape.objective.safeParse(7).success, false)
  assert.equal(shape.maxItems.safeParse(5).success, true)
  assert.equal(shape.maxItems.safeParse(undefined).success, true, 'optional when not required')
  assert.equal(shape.mode.safeParse('content').success, true)
  assert.equal(shape.mode.safeParse('bogus').success, false)
  assert.equal(shape.steps.safeParse([{ find: 'button' }]).success, true)
})

test('the server builder registers every tool and handlers map outcomes to MCP content', async () => {
  const registered: Array<{ name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> = []
  const server = buildClaudeBrowserMcpServer(
    {
      tool: (name, _description, _shape, handler) => {
        registered.push({ name, handler })
        return { name }
      },
      createSdkMcpServer: (options) => ({ serverName: options.name, toolCount: options.tools?.length })
    },
    async (tool, args) => ({
      result: { ok: true, echoedTool: tool, echoedArgs: args },
      imageUrls: ['data:image/png;base64,aGk=']
    })
  )

  assert.deepEqual(server, { serverName: 'browser', toolCount: registered.length })
  assert.ok(registered.some((entry) => entry.name === 'browser_snapshot'))

  const navigate = registered.find((entry) => entry.name === 'browser_navigate')!
  const outcome = await navigate.handler({ url: 'https://example.com' }, {}) as {
    content: Array<{ type: string; text?: string; mimeType?: string }>
    isError: boolean
  }
  assert.equal(outcome.isError, false)
  assert.match(outcome.content[0].text ?? '', /"echoedTool":"browser_navigate"/)
  assert.equal(outcome.content[1].type, 'image')
  assert.equal(outcome.content[1].mimeType, 'image/png')
})
