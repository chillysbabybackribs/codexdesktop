import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRunner } from '../browser/research-runner.js'
import { browserToolDefinitions, browserToolInputSchema, executeBrowserTool } from './browser-tool-registry.js'

test('browser tool registry has unique provider-neutral definitions with strict schemas', () => {
  assert.equal(browserToolDefinitions.length, 6)
  assert.equal(new Set(browserToolDefinitions.map((definition) => definition.name)).size, 6)
  const browserRun = browserToolDefinitions.find((definition) => definition.name === 'browser_run')!
  assert.equal(browserToolInputSchema(browserRun).safeParse({ code: 'return document.title' }).success, true)
  assert.equal(browserToolInputSchema(browserRun).safeParse({ code: 'ok', unexpected: true }).success, false)
})

test('shared browser tool execution validates before touching provider dependencies', async () => {
  const execution = await executeBrowserTool('browser_run', { code: '   ' }, {
    browserAgent: {} as BrowserAgentController,
    researchRunner: {} as ResearchRunner
  })
  assert.equal(execution.result.ok, false)
  assert.match(String(execution.result.error), /requires a string "code" argument/)
})
