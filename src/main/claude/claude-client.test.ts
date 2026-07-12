import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent } from '../../shared/agent.ts'
import { ClaudeClient } from './claude-client.ts'

function createClient(): ClaudeClient {
  return new ClaudeClient(
    {} as never,
    {} as never,
    { prepareOpeningText: async ({ requestText }: { requestText: string }) => requestText } as never
  )
}

test('starting and resuming Claude sessions stay cold until the first turn', async () => {
  const client = createClient()
  const events: AgentEvent[] = []
  client.on('event', (event: AgentEvent) => events.push(event))

  assert.deepEqual(
    await client.startThread('/tmp/project', 'claude-sonnet', 'high', 'default'),
    { threadId: null, model: 'claude-sonnet', effort: 'high' }
  )
  assert.deepEqual(
    await client.resumeThread('session-1', '/tmp/project'),
    { threadId: 'session-1', model: null, effort: null }
  )
  assert.deepEqual(events, [])

  client.dispose()
})
