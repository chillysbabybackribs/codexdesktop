import assert from 'node:assert/strict'
import test from 'node:test'
import { resumeHistoryPageFor } from './resume-history.ts'

test('resume history is bounded and tailored to each renderer consumer', () => {
  assert.deepEqual(resumeHistoryPageFor('main'), {
    limit: 48,
    sortDirection: 'desc',
    itemsView: 'full'
  })
  assert.deepEqual(resumeHistoryPageFor('agent'), {
    limit: 6,
    sortDirection: 'desc',
    itemsView: 'full'
  })
  assert.deepEqual(resumeHistoryPageFor('background'), {
    limit: 1,
    sortDirection: 'desc',
    itemsView: 'summary'
  })
})

test('resume history settings are returned as fresh values', () => {
  const page = resumeHistoryPageFor('main')
  page.limit = 1
  assert.equal(resumeHistoryPageFor('main').limit, 48)
})
