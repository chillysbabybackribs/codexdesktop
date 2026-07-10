import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildResearchQueryVariants,
  buildSerpExtractionProgram,
  googleSearchUrl,
  rankSerpCandidates,
  type SerpCandidate
} from './research-utils.ts'

test('research search URLs are deterministic and encoded', () => {
  assert.equal(
    googleSearchUrl('DeepSeek V4 Pro review', 5),
    'https://www.google.com/search?num=10&q=DeepSeek%20V4%20Pro%20review'
  )
})

test('SERP extraction program is bounded and syntactically valid', () => {
  const program = buildSerpExtractionProgram(5)

  assert.match(program, /const maxResults = 5/)
  assert.match(program, /anchor\.querySelector\('h3'\)/)
  assert.match(program, /new Set/)
  assert.match(program, /parsed\.hostname/)
  assert.doesNotThrow(() => new Function(program))
})

test('single-query research expands into bounded deterministic variants', () => {
  assert.deepEqual(
    buildResearchQueryVariants(['DeepSeek V4 Pro']),
    ['DeepSeek V4 Pro', 'DeepSeek V4 Pro official documentation', 'DeepSeek V4 Pro technical details']
  )
})

test('candidate ranking boosts primary sources and lowers video results', () => {
  const candidates: SerpCandidate[] = [
    {
      url: 'https://www.youtube.com/watch?v=123',
      title: 'DeepSeek V4 Pro review',
      snippet: 'DeepSeek V4 Pro review and analysis',
      rank: 1,
      query: 'DeepSeek V4 Pro review'
    },
    {
      url: 'https://docs.deepseek.com/v4/reference',
      title: 'DeepSeek V4 Pro official documentation',
      snippet: 'DeepSeek V4 Pro technical reference and API documentation',
      rank: 3,
      query: 'DeepSeek V4 Pro official documentation'
    },
    {
      url: 'https://example.com/deepseek-v4-pro',
      title: 'DeepSeek V4 Pro overview',
      snippet: 'A general overview of DeepSeek V4 Pro',
      rank: 2,
      query: 'DeepSeek V4 Pro'
    }
  ]

  const ranked = rankSerpCandidates(candidates, candidates.map((candidate) => candidate.query), 3)
  const video = ranked.find((candidate) => candidate.sourceTier === 'video')

  assert.equal(ranked[0].sourceTier, 'official')
  assert.equal(ranked[0].domain, 'docs.deepseek.com')
  assert.ok(video)
  assert.ok(video.score < ranked[0].score)
})
