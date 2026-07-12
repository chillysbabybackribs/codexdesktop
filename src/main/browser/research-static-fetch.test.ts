import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchStaticResearchPage } from './research-static-fetch.ts'

const article = `<!doctype html><html><head><title>Static report</title></head><body><main><h1>Migration report</h1><p>${
  'Concrete environment, reproduction steps, observed behavior, and verification details. '.repeat(30)
}</p><script>globalThis.staticScriptExecuted = true</script></main></body></html>`

function options(fetch: (url: string, init: RequestInit) => Promise<Response>) {
  return {
    fetch,
    validateUrl: async (url: string) => url,
    signal: new AbortController().signal
  }
}

test('static research accepts a substantial inert html article', async () => {
  const result = await fetchStaticResearchPage('https://example.com/report', options(async (_url, init) => {
    assert.equal(init.redirect, 'manual')
    assert.equal(init.credentials, 'include')
    return new Response(article, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }))

  assert.equal(result.kind, 'accepted')
  assert.equal(result.page?.status, 200)
  assert.match(result.page?.content ?? '', /Migration report/)
  assert.doesNotMatch(result.page?.content ?? '', /staticScriptExecuted/)
  assert.equal(result.page?.html, article)
})

test('static research validates every manual redirect hop', async () => {
  const validated: string[] = []
  const fetched: string[] = []
  const result = await fetchStaticResearchPage('https://example.com/start', {
    ...options(async (url) => {
      fetched.push(url)
      return url.endsWith('/start')
        ? new Response('', { status: 302, headers: { location: '/report' } })
        : new Response(article, { status: 200, headers: { 'content-type': 'text/html' } })
    }),
    validateUrl: async (url) => {
      validated.push(url)
      return url
    }
  })

  assert.equal(result.kind, 'accepted')
  assert.equal(result.redirects, 1)
  assert.deepEqual(validated, ['https://example.com/start', 'https://example.com/report'])
  assert.deepEqual(fetched, ['https://example.com/start', 'https://example.com/report'])
})

test('static research never falls back after a security-blocked redirect', async () => {
  const result = await fetchStaticResearchPage('https://example.com/start', {
    ...options(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } })),
    validateUrl: async (url) => {
      if (url.includes('127.0.0.1')) throw new Error('non-public address')
      return url
    }
  })

  assert.equal(result.kind, 'blocked')
  assert.match(result.reason ?? '', /redirect blocked/)
})

test('static research falls back for shells, non-html, and oversized bodies', async () => {
  const shell = await fetchStaticResearchPage('https://example.com/app', options(async () =>
    new Response('<html><body><div id="root">Loading...</div></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })
  ))
  assert.equal(shell.kind, 'fallback')
  assert.match(shell.reason ?? '', /content root/)

  const json = await fetchStaticResearchPage('https://example.com/api', options(async () =>
    new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  ))
  assert.equal(json.kind, 'fallback')
  assert.match(json.reason ?? '', /content type/)

  const oversized = await fetchStaticResearchPage('https://example.com/large', {
    ...options(async () => new Response(`<main>${'x'.repeat(110_000)}</main>`, {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })),
    maxBytes: 100_000
  })
  assert.equal(oversized.kind, 'fallback')
  assert.match(oversized.reason ?? '', /byte limit/)
})
