import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessExtractedPage,
  bingSearchFeedUrl,
  buildResearchQueryVariants,
  buildSerpExtractionProgram,
  duckDuckGoLiteSearchUrl,
  extractBingSearchFeedCandidates,
  extractDuckDuckGoLiteCandidates,
  extractSameHostNavLinks,
  googleSearchUrl,
  isCrossHostLanding,
  isPublicResearchAddress,
  normalizeResearchUrls,
  preferExtractableHost,
  rankSerpCandidates,
  type SerpCandidate
} from './research-utils.ts'

test('reddit fetches are rewritten to the server-rendered old.reddit.com mirror', () => {
  assert.equal(
    preferExtractableHost('https://www.reddit.com/r/ClaudeAI/comments/abc/some_thread/'),
    'https://old.reddit.com/r/ClaudeAI/comments/abc/some_thread/'
  )
  assert.equal(
    preferExtractableHost('https://reddit.com/r/codex/comments/xyz/'),
    'https://old.reddit.com/r/codex/comments/xyz/'
  )
  assert.equal(preferExtractableHost('https://old.reddit.com/r/codex/'), 'https://old.reddit.com/r/codex/')
  assert.equal(preferExtractableHost('https://example.com/reddit.com'), 'https://example.com/reddit.com')
  assert.equal(preferExtractableHost('not a url'), 'not a url')
})

test('direct research URLs are canonicalized, bounded, and restricted to public web schemes', () => {
  assert.deepEqual(normalizeResearchUrls([
    ' https://example.com/docs?utm_source=test&version=2#install ',
    'https://example.com/docs?version=2',
    'file:///tmp/private.txt',
    'javascript:alert(1)',
    'http://127.0.0.1/private',
    'http://localhost/private',
    'http://[::ffff:7f00:1]/private',
    'https://user:secret@example.com/private',
    42
  ]), ['https://example.com/docs?version=2'])
  assert.equal(isPublicResearchAddress('8.8.8.8'), true)
  assert.equal(isPublicResearchAddress('127.0.0.1'), false)
  assert.equal(isPublicResearchAddress('::ffff:7f00:1'), false)
  assert.equal(isPublicResearchAddress('::ffff:0808:0808'), true)
  assert.equal(isPublicResearchAddress('2606:4700:4700::1111'), true)
  assert.equal(isPublicResearchAddress('fd00::1'), false)
})

test('research search URLs are deterministic and encoded', () => {
  assert.equal(
    googleSearchUrl('DeepSeek V4 Pro review', 5),
    'https://www.google.com/search?num=10&q=DeepSeek%20V4%20Pro%20review'
  )
  assert.equal(
    duckDuckGoLiteSearchUrl('DeepSeek V4 Pro review'),
    'https://lite.duckduckgo.com/lite/?q=DeepSeek%20V4%20Pro%20review'
  )
  assert.equal(
    bingSearchFeedUrl('DeepSeek V4 Pro review', 5),
    'https://www.bing.com/search?format=rss&count=10&q=DeepSeek%20V4%20Pro%20review'
  )
})

test('DuckDuckGo Lite results decode destinations and keep adjacent snippets', () => {
  const html = `<!doctype html><html><body><table>
    <tr><td>1.</td><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fopenai%2Fcodex%2Fissues%2F10432%3Futm_source%3Dsearch&amp;rut=ignored">High GPU usage in Codex Desktop</a></td></tr>
    <tr><td></td><td class="result-snippet">Users report 70–90% GPU usage on macOS.</td></tr>
    <tr><td></td><td><span class="link-text">github.com/openai/codex/issues/10432</span></td></tr>
    <tr><td>2.</td><td><a class="result-link" href="https://example.com/report">Independent report</a></td></tr>
    <tr><td></td><td class="result-snippet">A second source.</td></tr>
  </table></body></html>`

  assert.deepEqual(extractDuckDuckGoLiteCandidates(html, 2), [
    {
      url: 'https://github.com/openai/codex/issues/10432',
      title: 'High GPU usage in Codex Desktop',
      snippet: 'Users report 70–90% GPU usage on macOS.',
      rank: 1
    },
    {
      url: 'https://example.com/report',
      title: 'Independent report',
      snippet: 'A second source.',
      rank: 2
    }
  ])
})

test('Bing RSS fallback extracts bounded destination records', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Official release notes</title><link>https://example.com/releases?utm_medium=rss</link><description>Current product changes &amp; fixes.</description></item>
    <item><title>Issue report</title><link>https://github.com/example/app/issues/42</link><description>A reproducible desktop failure.</description></item>
  </channel></rss>`

  assert.deepEqual(extractBingSearchFeedCandidates(xml, 1), [
    {
      url: 'https://example.com/releases',
      title: 'Official release notes',
      snippet: 'Current product changes & fixes.',
      rank: 1
    }
  ])
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

test('multiple model-authored semantic variants are preserved without deterministic additions', () => {
  assert.deepEqual(
    buildResearchQueryVariants([
      'Electron WebContentsView official migration guide',
      'Electron WebContentsView Linux rendering regressions',
      'Electron WebContentsView developer migration experience'
    ], 6),
    [
      'Electron WebContentsView official migration guide',
      'Electron WebContentsView Linux rendering regressions',
      'Electron WebContentsView developer migration experience'
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
  assert.deepEqual(
    assessExtractedPage({
      title: 'Sign in to Example',
      url: 'https://example.com/login',
      content: 'Account access help and product navigation. '.repeat(30),
      wordCount: 150
    }),
    { verified: false, reason: 'login-page' }
  )
  assert.deepEqual(
    assessExtractedPage({
      title: 'Sign in to Example',
      url: 'https://example.com/login',
      content: 'Account access help and product navigation. '.repeat(80),
      wordCount: 400
    }),
    { verified: false, reason: 'login-page' }
  )
  assert.deepEqual(
    assessExtractedPage({
      title: 'Application',
      url: 'https://example.com/app',
      content: Array.from({ length: 40 }, () => 'Loading…').join('\n'),
      wordCount: 40
    }),
    { verified: false, reason: 'insufficient-content' }
  )
})

test('cross-host landings are detected without treating www as a host change', () => {
  assert.equal(isCrossHostLanding('https://developers.openai.com/codex', 'https://learn.chatgpt.com/docs'), true)
  assert.equal(isCrossHostLanding('https://docs.roocode.com/', 'https://roocodeinc.github.io/Roo-Code/'), true)
  assert.equal(isCrossHostLanding('https://example.com/docs', 'https://www.example.com/docs/latest'), false)
  assert.equal(isCrossHostLanding('https://example.com/docs', 'https://example.com/other'), false)
  assert.equal(isCrossHostLanding('not a url', 'https://example.com/'), false)
  assert.equal(isCrossHostLanding('https://example.com/', ''), false)
})

test('redirect-hub link harvesting keeps bounded, deduplicated same-host navigation links', () => {
  const html = `
    <nav>
      <a href="/codex/app">Desktop <b>app</b></a>
      <a href="/codex/app#features">App features anchor</a>
      <a href='/codex/cli'>CLI</a>
      <a href="https://learn.chatgpt.com/codex/cloud">Cloud</a>
      <a href="https://www.learn.chatgpt.com/codex/ide">IDE</a>
      <a href="https://other-host.example/away">External</a>
      <a href="mailto:docs@example.com">Mail</a>
      <a href="javascript:void(0)">Noop</a>
      <a href="#top">Top</a>
      <a href="/docs">Self</a>
      <a href="/codex/changelog">Changelog</a>
    </nav>`
  const links = extractSameHostNavLinks(html, 'https://learn.chatgpt.com/docs', 4)

  assert.deepEqual(links, [
    { url: 'https://learn.chatgpt.com/codex/app', title: 'Desktop app' },
    { url: 'https://learn.chatgpt.com/codex/cli', title: 'CLI' },
    { url: 'https://learn.chatgpt.com/codex/cloud', title: 'Cloud' },
    { url: 'https://www.learn.chatgpt.com/codex/ide', title: 'IDE' }
  ])
  assert.deepEqual(extractSameHostNavLinks('<p>no links</p>', 'https://learn.chatgpt.com/docs', 4), [])
  assert.deepEqual(extractSameHostNavLinks(html, 'not a url', 4), [])
})
