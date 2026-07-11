import assert from 'node:assert/strict'
import test from 'node:test'
import type { HistoryEntry } from './browser-history-store.ts'
import { buildSuggestions, inlineCompletion, MAX_OMNIBOX_ROWS } from './omnibox-suggestions.ts'

const NOW = 1_000_000_000_000

function entry(url: string, title: string, visitCount: number, ageHours = 1): HistoryEntry {
  return { url, title, visitCount, lastVisitAt: NOW - ageHours * 3_600_000 }
}

test('empty input returns top sites by frecency', () => {
  const rows = buildSuggestions(
    '',
    [
      entry('https://rare.com/', 'Rare', 1, 24 * 40),
      entry('https://daily.com/', 'Daily', 30),
      entry('https://weekly.com/', 'Weekly', 10, 24 * 3)
    ],
    NOW
  )

  assert.deepEqual(
    rows.map((row) => row.url),
    ['https://daily.com/', 'https://weekly.com/', 'https://rare.com/']
  )
  assert.ok(rows.every((row) => row.kind === 'history'))
})

test('typed input puts interpretation first, then history matches', () => {
  const rows = buildSuggestions('git', [entry('https://github.com/', 'GitHub', 20), entry('https://gitlab.com/', 'GitLab', 5)], NOW)

  assert.equal(rows[0].kind, 'search')
  assert.equal(rows[0].text, 'git')
  assert.equal(rows[1].url, 'https://github.com/')
  assert.equal(rows[2].url, 'https://gitlab.com/')
})

test('url-like input yields a navigate row and dedupes the identical history row', () => {
  const rows = buildSuggestions('https://github.com/', [entry('https://github.com/', 'GitHub', 20)], NOW)

  assert.equal(rows[0].kind, 'navigate')
  assert.equal(rows[0].url, 'https://github.com/')
  assert.equal(rows.length, 1)
})

test('host prefix beats title substring', () => {
  const rows = buildSuggestions(
    'news',
    [entry('https://example.com/', 'The news site with the same visits', 10), entry('https://news.ycombinator.com/', 'Hacker News', 10)],
    NOW
  )

  assert.equal(rows[1].url, 'https://news.ycombinator.com/')
  assert.equal(rows[2].url, 'https://example.com/')
})

test('all tokens must match somewhere', () => {
  const rows = buildSuggestions('hacker rust', [entry('https://news.ycombinator.com/', 'Hacker News', 10)], NOW)

  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'search')
})

test('inlineCompletion completes a host prefix, stripping www and preserving typed case', () => {
  const entries = [entry('https://www.wikipedia.org/', 'Wikipedia', 5)]

  assert.equal(inlineCompletion('wik', entries, NOW), 'wikipedia.org')
  assert.equal(inlineCompletion('WIK', entries, NOW), 'WIKipedia.org')
  assert.equal(inlineCompletion('www.wik', entries, NOW), 'www.wikipedia.org')
})

test('inlineCompletion completes deeper URL forms when typed past the host', () => {
  const entries = [entry('https://news.ycombinator.com/item?id=1', 'HN', 3)]

  assert.equal(inlineCompletion('news.ycombinator.com/it', entries, NOW), 'news.ycombinator.com/item?id=1')
  assert.equal(inlineCompletion('https://news.y', entries, NOW), 'https://news.ycombinator.com/item?id=1')
})

test('inlineCompletion prefers the most frecent match', () => {
  const entries = [entry('https://github.io/', 'Pages', 3, 24 * 30), entry('https://github.com/', 'GitHub', 30)]

  assert.equal(inlineCompletion('git', entries, NOW), 'github.com')
})

test('inlineCompletion never fires for searches, single visits, or exact text', () => {
  const entries = [entry('https://wikipedia.org/', 'Wikipedia', 1), entry('https://example.com/', 'Example', 9)]

  assert.equal(inlineCompletion('wik', entries, NOW), null, 'single visit must not complete')
  assert.equal(inlineCompletion('how to wik', entries, NOW), null, 'spaces mean search')
  assert.equal(inlineCompletion('example.com', entries, NOW), null, 'nothing left to complete')
  assert.equal(inlineCompletion('', entries, NOW), null)
  assert.equal(inlineCompletion('wik ', entries, NOW), null, 'trailing space means the user is not typing a url')
})

test('row count is capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => entry(`https://site${i}.com/`, `Site ${i}`, i + 1))

  assert.equal(buildSuggestions('', many, NOW).length, MAX_OMNIBOX_ROWS)
  assert.equal(buildSuggestions('site', many, NOW).length, MAX_OMNIBOX_ROWS)
})
