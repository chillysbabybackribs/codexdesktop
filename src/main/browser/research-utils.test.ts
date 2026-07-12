import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessExtractedPage,
  buildResearchQueryVariants,
  buildSerpExtractionProgram,
  googleSearchUrl,
  normalizeResearchUrls,
  rankSerpCandidates,
  type SerpCandidate
} from './research-utils.ts'

test('direct research URLs are canonicalized, bounded, and restricted to public web schemes', () => {
  assert.deepEqual(normalizeResearchUrls([
    ' https://example.com/docs?utm_source=test&version=2#install ',
    'https://example.com/docs?version=2',
    'file:///tmp/private.txt',
    'javascript:alert(1)',
    'http://127.0.0.1/private',
    'http://localhost/private',
    'https://user:secret@example.com/private',
    42
  ]), ['https://example.com/docs?version=2'])
})

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

test('firsthand research expands into developer-report source lanes', () => {
  assert.deepEqual(
    buildResearchQueryVariants(['Electron WebContentsView firsthand Linux reports']),
    [
      'Electron WebContentsView firsthand Linux reports',
      'Electron WebContentsView firsthand Linux reports GitHub issues discussions',
      'Electron WebContentsView firsthand Linux reports developer forum report'
    ]
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

test('firsthand queries prioritize issue and discussion reports', () => {
  const query = 'Electron WebContentsView Linux firsthand migration reports'
  const candidates: SerpCandidate[] = [
    {
      url: 'https://www.electronjs.org/docs/latest/api/web-contents-view',
      title: 'WebContentsView API documentation',
      snippet: 'Official API reference for WebContentsView',
      rank: 1,
      query
    },
    {
      url: 'https://github.com/electron/electron/issues/44567',
      title: 'Linux rendering regression after migrating to WebContentsView',
      snippet: 'I migrated from BrowserView and reproduced this on Ubuntu with Electron 34',
      rank: 2,
      query
    }
  ]

  const ranked = rankSerpCandidates(candidates, [query], 2)

  assert.equal(ranked[0].sourceTier, 'community')
  assert.equal(ranked[0].domain, 'github.com')
})

test('page assessment accepts substantial content and rejects extraction failures', () => {
  assert.deepEqual(
    assessExtractedPage({
      title: 'Migration report',
      url: 'https://example.com/report',
      content: 'A developer migration report with concrete environment and reproduction details. '.repeat(12),
      wordCount: 96
    }),
    { verified: true }
  )
  assert.deepEqual(
    assessExtractedPage({
      title: 'Just a moment',
      url: 'https://example.com/report',
      content: 'Checking your browser before accessing the site. Verify you are human.',
      wordCount: 11
    }),
    { verified: false, reason: 'challenge-page' }
  )
  assert.deepEqual(
    assessExtractedPage({
      title: 'Empty shell',
      url: 'https://example.com/report',
      content: 'Loading...',
      wordCount: 1
    }),
    { verified: false, reason: 'insufficient-content' }
  )
  assert.deepEqual(
    assessExtractedPage({
      title: 'Documentation',
      url: 'https://example.com/missing',
      content: 'A verbose branded error page with navigation and support links. '.repeat(20),
      wordCount: 120,
      status: 404
    }),
    { verified: false, reason: 'http-error' }
  )
  assert.deepEqual(
    assessExtractedPage({
      title: '404: Page not found',
      url: 'https://example.com/missing',
      content: 'A verbose branded error page with navigation and support links. '.repeat(20),
      wordCount: 120
    }),
    { verified: false, reason: 'error-page' }
  )
})
