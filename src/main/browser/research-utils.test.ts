import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSerpExtractionProgram, googleSearchUrl } from './research-utils.ts'

test('research search URLs are deterministic and encoded', () => {
  assert.equal(
    googleSearchUrl('DeepSeek V4 Pro review', 5),
    'https://www.google.com/search?num=10&q=DeepSeek%20V4%20Pro%20review'
  )
})

test('SERP extraction program is bounded and syntactically valid', () => {
  const program = buildSerpExtractionProgram(5)

  assert.match(program, /const maxResults = 5/)
  assert.match(program, /new Set/)
  assert.match(program, /parsed\.hostname/)
  assert.doesNotThrow(() => new Function(program))
})
