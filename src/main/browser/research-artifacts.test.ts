import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ResearchMemoryCache, ResearchPruneGate, writeResearchPageArtifacts } from './research-artifacts.ts'

test('research memory cache expires entries and evicts the least recently used value', () => {
  let now = 0
  const cache = new ResearchMemoryCache<string>(100, 2, () => now)
  cache.set('a', 'first')
  cache.set('b', 'second')
  assert.equal(cache.get('a'), 'first')
  cache.set('c', 'third')
  assert.equal(cache.get('b'), null)
  assert.equal(cache.get('a'), 'first')
  now = 100
  assert.equal(cache.get('a'), null)
  assert.equal(cache.get('c'), null)
})

test('research artifacts persist complete cleaned text and raw html concurrently', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-research-artifacts-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const content = `${'Background evidence. '.repeat(700)}\nTail claim remains searchable.`
  assert.ok(content.length > 12_000)

  const paths = await writeResearchPageArtifacts(root, 'page-01', content, '<html><body>source</body></html>')

  assert.equal(await readFile(paths.artifactPath, 'utf8'), `${content}\n`)
  assert.equal(await readFile(paths.htmlPath, 'utf8'), '<html><body>source</body></html>')
})

test('research pruning is scheduled once per cooldown without overlapping scans', async () => {
  let now = 0
  let scans = 0
  let releaseFirst: () => void = () => assert.fail('first prune was not scheduled')
  const first = new Promise<void>((resolve) => { releaseFirst = resolve })
  const gate = new ResearchPruneGate(
    1_000,
    async () => {
      scans += 1
      if (scans === 1) await first
    },
    () => now
  )

  const running = gate.schedule('/research')
  assert.ok(running)
  assert.equal(gate.schedule('/research'), running)
  assert.equal(scans, 1)
  releaseFirst()
  await running

  now = 999
  assert.equal(gate.schedule('/research'), null)
  now = 1_000
  await gate.schedule('/research')
  assert.equal(scans, 2)
})

test('failed pruning still enters cooldown to avoid retry storms', async () => {
  let now = 10
  let scans = 0
  const gate = new ResearchPruneGate(
    500,
    async () => {
      scans += 1
      throw new Error('scan failed')
    },
    () => now
  )

  await assert.rejects(gate.schedule('/research') ?? Promise.resolve(), /scan failed/)
  now = 509
  assert.equal(gate.schedule('/research'), null)
  assert.equal(scans, 1)
})
