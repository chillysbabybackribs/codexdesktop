import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMentionContext,
  fuzzyScore,
  rankMentionCandidates,
  stripMentionContext
} from './mention-model.ts'

test('fuzzy matching: subsequence required, basename hits rank first', () => {
  assert.equal(fuzzyScore('zzz', 'src/App.tsx'), null, 'non-subsequence is rejected')
  assert.ok(fuzzyScore('app', 'src/App.tsx') !== null)

  const ranked = rankMentionCandidates(
    'app',
    ['src/renderer/src/App.tsx', 'src/main/app-server.ts', 'docs/roadmap.md'],
    ['src/app-utils']
  )
  assert.ok(ranked.length >= 2)
  // Basename-starting matches beat matches buried mid-path; non-matches are gone.
  assert.equal(ranked[0].path, 'src/renderer/src/App.tsx')
  assert.ok(!ranked.some((candidate) => candidate.path === 'docs/roadmap.md'))
})

test('empty query lists candidates; files outrank folders on ties', () => {
  const ranked = rankMentionCandidates('', ['a.ts'], ['a-dir'], 8)
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].kind, 'file')
})

test('mention context builds and strips round-trip', () => {
  const block = buildMentionContext([
    { path: 'src/a.ts', kind: 'file', content: 'const a = 1', truncated: false },
    { path: 'src/lib', kind: 'folder', content: '- lib/x.ts\n- lib/y.ts', truncated: true },
    { path: 'gone.ts', kind: 'file', content: null, truncated: false }
  ])
  assert.ok(block.includes('[file: src/a.ts]'))
  assert.ok(block.includes('[folder: src/lib] (truncated)'))
  assert.ok(block.includes('unreadable'))

  const sent = `Fix the bug in the parser${block}`
  assert.equal(stripMentionContext(sent), 'Fix the bug in the parser')
  assert.equal(stripMentionContext('no mentions here'), 'no mentions here')
})

test('no resolvable content yields an empty block', () => {
  assert.equal(buildMentionContext([]), '')
})
