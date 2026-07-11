import assert from 'node:assert/strict'
import test from 'node:test'
import { safeDownloadName } from './download-policy.ts'

test('safeDownloadName keeps a plain filename', () => {
  assert.equal(safeDownloadName('report.pdf'), 'report.pdf')
})

test('safeDownloadName removes paths and control characters', () => {
  assert.equal(safeDownloadName('../folder/\u0000report.pdf'), 'report.pdf')
})

test('safeDownloadName provides a fallback', () => {
  assert.equal(safeDownloadName(''), 'download')
})
