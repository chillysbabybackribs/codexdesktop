import assert from 'node:assert/strict'
import test from 'node:test'
import { browserToolDefinitions } from '../agent-tools/browser-tool-registry.js'
import { claudeBrowserMcpServerName, claudeBrowserToolNames } from './claude-tools.js'

test('Claude exposes every app browser capability through one SDK MCP namespace', () => {
  assert.equal(claudeBrowserMcpServerName, 'desktop_browser')
  assert.deepEqual(
    claudeBrowserToolNames,
    browserToolDefinitions.map((definition) => `mcp__desktop_browser__${definition.name}`)
  )
  assert.equal(new Set(claudeBrowserToolNames).size, browserToolDefinitions.length)
})

