import assert from 'node:assert/strict'
import test from 'node:test'
import { buildClaudeOptions, claudeBuiltInTools } from './claude-options.ts'
import { claudeBrowserMcpServerName, claudeBrowserToolNames } from './claude-tools.ts'

const baseOptions = {
  resume: null,
  cwd: '/tmp/project',
  model: 'claude-haiku-4-5-20251001',
  effort: 'medium' as const,
  collaborationMode: 'default' as const
}

test('Claude sessions disable implicit skills and expose only the explicit built-in surface', () => {
  const options = buildClaudeOptions(baseOptions)

  assert.deepEqual(options.skills, [])
  assert.deepEqual(options.tools, claudeBuiltInTools)
  assert.ok(!claudeBuiltInTools.includes('Skill'))
  assert.ok(!claudeBuiltInTools.includes('Agent'))
  assert.ok(options.disallowedTools?.includes('Skill'))
  assert.deepEqual(options.settings, {
    autoMemoryEnabled: false,
    autoDreamEnabled: false,
    autoCompactEnabled: true
  })
})

test('Claude browser MCP tools remain first-class with the bounded built-in surface', () => {
  const mcpServer = { type: 'sdk', name: 'test' } as never
  const options = buildClaudeOptions(baseOptions, mcpServer)

  assert.equal(options.mcpServers?.[claudeBrowserMcpServerName], mcpServer)
  assert.deepEqual(options.allowedTools, claudeBrowserToolNames)
  assert.deepEqual(options.tools, claudeBuiltInTools)
})
