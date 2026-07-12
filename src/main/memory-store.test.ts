import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryStore } from './memory-store.ts'

function workspaceDirectory(root: string, workspace: string | null): string {
  const identity = workspace ?? 'no-workspace'
  const key = createHash('sha256').update(identity).digest('hex')
  return join(root, 'workspaces', key)
}

test('MemoryStore writes the bounded checkpoint and full transcript', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-memory-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new MemoryStore(root)

  await store.persist({
    provider: 'codex',
    surface: 'main',
    threadId: 'thread-1',
    title: 'Simple memory',
    workspace: '/tmp/project',
    updatedAt: '2026-07-11T12:00:00.000Z',
    turns: [{ user: 'Remember this?', assistant: 'The checkpoint was saved.' }]
  })

  const lastChat = await readFile(join(root, 'last-chat.md'), 'utf8')
  assert.match(lastChat, /# Simple memory/)
  assert.match(lastChat, /Workspace: \/tmp\/project/)
  assert.match(lastChat, /Provider: codex/)

  const scopedRoot = workspaceDirectory(root, '/tmp/project')
  const scopedLastChat = await readFile(join(scopedRoot, 'last-chat.md'), 'utf8')
  assert.equal(scopedLastChat, lastChat)

  const transcript = await readFile(join(scopedRoot, 'chats', 'codex', 'thread-1.md'), 'utf8')
  assert.match(transcript, /<!-- codexdesktop-turn:codex:thread-1:C01:start -->/)
  assert.match(transcript, /## Turn C01 — Remember this\?/)
})

test('MemoryStore namespaces matching provider session ids', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-memory-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new MemoryStore(root)
  const workspace = '/tmp/shared-project'

  await store.persist({
    provider: 'codex',
    surface: 'main',
    threadId: 'same-session',
    title: 'Codex memory',
    workspace,
    updatedAt: '2026-07-11T12:00:00.000Z',
    turns: [{ user: 'Codex request', assistant: 'Codex result' }]
  })
  await store.persist({
    provider: 'claude',
    surface: 'main',
    threadId: 'same-session',
    title: 'Claude memory',
    workspace,
    updatedAt: '2026-07-11T12:01:00.000Z',
    turns: [{ user: 'Claude request', assistant: 'Claude result' }]
  })

  const scopedRoot = workspaceDirectory(root, workspace)
  const codex = await readFile(join(scopedRoot, 'chats', 'codex', 'same-session.md'), 'utf8')
  const claude = await readFile(join(scopedRoot, 'chats', 'claude', 'same-session.md'), 'utf8')
  assert.match(codex, /Codex result/)
  assert.match(claude, /Claude result/)
})

test('MemoryStore keeps last-chat checkpoints isolated by workspace', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-memory-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new MemoryStore(root)

  await store.persist({
    provider: 'codex',
    surface: 'main',
    threadId: 'thread-a',
    title: 'Workspace A',
    workspace: '/tmp/project-a',
    updatedAt: '2026-07-11T12:00:00.000Z',
    turns: [{ user: 'Request A', assistant: 'Result A' }]
  })
  await store.persist({
    provider: 'claude',
    surface: 'main',
    threadId: 'thread-b',
    title: 'Workspace B',
    workspace: '/tmp/project-b',
    updatedAt: '2026-07-11T12:01:00.000Z',
    turns: [{ user: 'Request B', assistant: 'Result B' }]
  })

  const workspaceA = await readFile(
    join(workspaceDirectory(root, '/tmp/project-a'), 'last-chat.md'),
    'utf8'
  )
  const workspaceB = await readFile(
    join(workspaceDirectory(root, '/tmp/project-b'), 'last-chat.md'),
    'utf8'
  )
  assert.match(workspaceA, /# Workspace A/)
  assert.doesNotMatch(workspaceA, /Workspace B/)
  assert.match(workspaceB, /# Workspace B/)
  assert.doesNotMatch(workspaceB, /Workspace A/)
})

test('background agent transcripts do not replace the main last-chat checkpoint', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-memory-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new MemoryStore(root)
  const workspace = '/tmp/project'

  await store.persist({
    provider: 'codex',
    surface: 'main',
    threadId: 'main-thread',
    title: 'Main conversation',
    workspace,
    updatedAt: '2026-07-11T12:00:00.000Z',
    turns: [{ user: 'Main request', assistant: 'Main result' }]
  })
  await store.persist({
    provider: 'claude',
    surface: 'agent',
    threadId: 'agent-thread',
    title: 'Background agent',
    workspace,
    updatedAt: '2026-07-11T12:01:00.000Z',
    turns: [{ user: 'Agent request', assistant: 'Agent result' }]
  })

  const lastChat = await readFile(join(workspaceDirectory(root, workspace), 'last-chat.md'), 'utf8')
  const legacyLastChat = await readFile(join(root, 'last-chat.md'), 'utf8')
  const agentTranscript = await readFile(
    join(workspaceDirectory(root, workspace), 'chats', 'claude', 'agent-thread.md'),
    'utf8'
  )
  assert.match(lastChat, /# Main conversation/)
  assert.equal(legacyLastChat, lastChat)
  assert.match(agentTranscript, /Agent result/)
})

test('MemoryStore serializes concurrent writes without temp-file collisions', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-memory-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new MemoryStore(root)
  const workspace = '/tmp/project'

  await Promise.all(Array.from({ length: 20 }, (_, index) => store.persist({
    provider: 'codex',
    surface: 'main',
    threadId: 'same-thread',
    title: `Write ${index}`,
    workspace,
    updatedAt: new Date(1_700_000_000_000 + index).toISOString(),
    turns: [{ user: `Request ${index}`, assistant: `Result ${index}` }]
  })))

  const lastChat = await readFile(join(workspaceDirectory(root, workspace), 'last-chat.md'), 'utf8')
  assert.match(lastChat, /^# Write 19$/m)
})
