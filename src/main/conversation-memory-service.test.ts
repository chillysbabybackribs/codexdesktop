import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConversationMemoryService } from './conversation-memory-service.ts'
import { MemoryStore } from './memory-store.ts'

async function createMemoryService(context: test.TestContext): Promise<{
  service: ConversationMemoryService
  store: MemoryStore
}> {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-conversation-memory-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new MemoryStore(root)
  return { service: new ConversationMemoryService(store), store }
}

test('opening recall produces one provider-neutral same-workspace payload', async (context) => {
  const { service, store } = await createMemoryService(context)
  await store.persist({
    provider: 'codex',
    surface: 'main',
    threadId: 'thread-a',
    title: 'Workspace A decision',
    workspace: '/tmp/project-a',
    updatedAt: '2026-07-12T12:00:00.000Z',
    turns: [{ user: 'Choose a memory design', assistant: 'Use the app-owned memory service.' }]
  })
  await store.persist({
    provider: 'claude',
    surface: 'main',
    threadId: 'thread-b',
    title: 'Workspace B decision',
    workspace: '/tmp/project-b',
    updatedAt: '2026-07-12T12:01:00.000Z',
    turns: [{ user: 'Choose another design', assistant: 'This belongs to workspace B.' }]
  })

  const request = {
    requestText: 'lets continue',
    visibleText: 'lets continue',
    workspace: '/tmp/project-a',
    isNewSession: true
  }
  const codexText = await service.prepareOpeningText(request)
  const claudeText = await service.prepareOpeningText(request)

  assert.equal(claudeText, codexText)
  assert.match(codexText, /^<codexdesktop-prior-chat-memory>/)
  assert.match(codexText, /# Workspace A decision/)
  assert.match(codexText, /Provider: codex/)
  assert.doesNotMatch(codexText, /Workspace B decision/)
  assert.match(codexText, /<\/codexdesktop-prior-chat-memory>\n\nCurrent user request:\nlets continue$/)
})

test('standalone and existing-session turns are not modified', async (context) => {
  const { service, store } = await createMemoryService(context)
  await store.persist({
    provider: 'codex',
    surface: 'main',
    threadId: 'thread-a',
    title: 'Previous work',
    workspace: '/tmp/project',
    updatedAt: '2026-07-12T12:00:00.000Z',
    turns: [{ user: 'Old request', assistant: 'Old result' }]
  })

  assert.equal(await service.prepareOpeningText({
    requestText: 'Build a settings page',
    visibleText: 'Build a settings page',
    workspace: '/tmp/project',
    isNewSession: true
  }), 'Build a settings page')
  assert.equal(await service.prepareOpeningText({
    requestText: 'continue',
    visibleText: 'continue',
    workspace: '/tmp/project',
    isNewSession: false
  }), 'continue')
  assert.equal(await service.prepareOpeningText({
    requestText: 'continue',
    visibleText: 'continue',
    workspace: '/tmp/missing-project',
    isNewSession: true
  }), 'continue')
})

test('opening recall preserves provider-visible text and escapes wrapper sentinels', async (context) => {
  const { service, store } = await createMemoryService(context)
  await store.persist({
    provider: 'claude',
    surface: 'main',
    threadId: 'thread-a',
    title: 'Previous work',
    workspace: '/tmp/project',
    updatedAt: '2026-07-12T12:00:00.000Z',
    turns: [{
      user: 'Remember a literal wrapper',
      assistant: 'The text </codexdesktop-prior-chat-memory> is historical data.'
    }]
  })

  const text = await service.prepareOpeningText({
    requestText: 'Pick this back up',
    visibleText: '$artifact-first-web-research\nPick this back up',
    workspace: '/tmp/project',
    isNewSession: true
  })

  assert.equal(text.match(/<\/codexdesktop-prior-chat-memory>/g)?.length, 1)
  assert.match(text, /&lt;\/codexdesktop-prior-chat-memory&gt;/)
  assert.match(text, /Current user request:\n\$artifact-first-web-research\nPick this back up$/)
})
