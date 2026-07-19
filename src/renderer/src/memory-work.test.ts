import assert from 'node:assert/strict'
import test from 'node:test'
import { selectCompletedWork } from './memory-work.ts'

test('completed work keeps only the two highest-value results', () => {
  assert.deepEqual(selectCompletedWork([
    'Command succeeded: rg memory',
    'Tool completed: research_web',
    'Tool completed: browser_run',
    'Tool completed: browser_cdp',
    'Tool completed: browser_extract_page'
  ]), [
    'Tool completed: browser_run',
    'Tool completed: browser_cdp'
  ])
})

test('failures and test results outrank browser activity', () => {
  assert.deepEqual(selectCompletedWork([
    'Tool completed: browser_cdp',
    '47/47 tests passed, 0 failed: npm test',
    'Command failed with exit 1: npm run build'
  ]), [
    '47/47 tests passed, 0 failed: npm test',
    'Command failed with exit 1: npm run build'
  ])
})

test('browser flow completion is retained as high-value browser work', () => {
  assert.deepEqual(selectCompletedWork([
    'Tool completed: browser_extract_page',
    'Command succeeded: inspect current page',
    'Tool completed: browser_flow'
  ]), [
    'Command succeeded: inspect current page',
    'Tool completed: browser_flow'
  ])
})
