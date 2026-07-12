import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRequest, ResearchRunContext, ResearchRunner } from '../browser/research-runner.js'
import type { DynamicToolCallParams } from '../../shared/codex-protocol/v2/DynamicToolCallParams.js'
import { routeDynamicToolCall } from './dynamic-tool-router.js'

function params(tool: string, args: DynamicToolCallParams['arguments'], namespace: string | null = null): DynamicToolCallParams {
  return { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', namespace, tool, arguments: args }
}

const unusedBrowser = {} as BrowserAgentController
const unusedResearch = {} as ResearchRunner

function textResult(response: Awaited<ReturnType<typeof routeDynamicToolCall>>): { ok: boolean; error?: string } {
  const item = response.contentItems[0]
  assert.equal(item?.type, 'inputText')
  if (item?.type !== 'inputText') assert.fail('expected inputText response')
  return JSON.parse(item.text) as { ok: boolean; error?: string }
}

test('dynamic tool router rejects provider namespaces', async () => {
  const response = await routeDynamicToolCall(params('browser_run', {}, 'provider'), {
    browserAgent: unusedBrowser,
    researchRunner: unusedResearch
  })

  assert.equal(response.success, false)
  assert.match(textResult(response).error ?? '', /unsupported dynamic tool namespace/)
})

test('dynamic tool router validates required browser_run code', async () => {
  const response = await routeDynamicToolCall(params('browser_run', { code: '   ' }), {
    browserAgent: unusedBrowser,
    researchRunner: unusedResearch
  })

  assert.equal(response.success, false)
  assert.match(textResult(response).error ?? '', /requires a string "code" argument/)
})

test('dynamic tool router normalizes research arguments and forwards run context and progress', async () => {
  let request: ResearchRequest | null = null
  const contexts: ResearchRunContext[] = []
  let progressMessage: string | null = null
  const researchRunner = {
    run: async (next: ResearchRequest, nextContext: ResearchRunContext) => {
      request = next
      contexts.push(nextContext)
      nextContext.onProgress?.({ stage: 'discovering', message: 'Searching source lane 1/1…' })
      return { ok: true }
    }
  } as ResearchRunner
  const response = await routeDynamicToolCall(params('research_web', {
    queries: ['one', 2, 'two'],
    maxResults: 4,
    maxPages: 2,
    maxAttempts: 3,
    snippetChars: 1200
  }), {
    browserAgent: unusedBrowser,
    researchRunner,
    onResearchProgress: (progress) => { progressMessage = progress.message }
  })

  assert.equal(response.success, true)
  assert.deepEqual(request, { queries: ['one', 'two'], maxResults: 4, maxPages: 2, maxAttempts: 3, snippetChars: 1200 })
  const context = contexts[0]
  assert.ok(context)
  assert.equal(context?.runId, 'call-1')
  assert.equal(context?.threadId, 'thread-1')
  assert.equal(context?.turnId, 'turn-1')
  assert.equal(progressMessage, 'Searching source lane 1/1…')
})
