import assert from 'node:assert/strict'
import test from 'node:test'
import { composerDrafts, discardComposerDraft, type ComposerDraft } from './composer-draft.ts'

test('composerDrafts round-trips a draft by key', () => {
  const key = 'tab-roundtrip'
  const draft: ComposerDraft = { value: 'hello world', attachments: [], mentions: [] }

  composerDrafts.set(key, draft)
  assert.deepEqual(composerDrafts.get(key), draft)

  composerDrafts.delete(key)
})

test('discardComposerDraft removes the stored draft', () => {
  const key = 'tab-discard'
  composerDrafts.set(key, { value: 'draft text', attachments: [] })

  discardComposerDraft(key)

  assert.equal(composerDrafts.has(key), false)
  assert.equal(composerDrafts.get(key), undefined)
})

test('discardComposerDraft is a no-op for unknown keys', () => {
  const key = 'tab-missing'
  assert.equal(composerDrafts.has(key), false)
  discardComposerDraft(key)
  assert.equal(composerDrafts.has(key), false)
})

test('discarding one draft leaves other drafts intact', () => {
  composerDrafts.set('tab-a', { value: 'keep me', attachments: [] })
  composerDrafts.set('tab-b', { value: 'drop me', attachments: [] })

  discardComposerDraft('tab-b')

  assert.deepEqual(composerDrafts.get('tab-a'), { value: 'keep me', attachments: [] })
  assert.equal(composerDrafts.has('tab-b'), false)

  composerDrafts.delete('tab-a')
})
