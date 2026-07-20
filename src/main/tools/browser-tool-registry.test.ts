import assert from 'node:assert/strict'
import test from 'node:test'
import { runBrowserTool, type BrowserToolDeps } from './browser-tool-registry.ts'
import type { RankedSerpCandidate } from '../browser/research-utils.ts'

function candidate(url: string, rank: number, score: number): RankedSerpCandidate {
  return {
    url,
    title: `Result ${rank}`,
    snippet: '',
    rank,
    query: 'example query',
    score,
    domain: new URL(url).hostname,
    sourceTier: 'general'
  }
}

const early = candidate('https://early.example/page', 1, 0.6)
const best = candidate('https://best.example/page', 1, 0.9)
const alternate = candidate('https://alternate.example/page', 2, 0.5)

type FakeOptions = {
  fireEarly: boolean
  events: string[]
}

function fakeDeps({ fireEarly, events }: FakeOptions): BrowserToolDeps {
  const researchRunner = {
    async discover(_request: unknown, context: { onFirstCandidates?: (candidates: RankedSerpCandidate[]) => void }) {
      events.push('discover-start')
      if (fireEarly) context.onFirstCandidates?.([early, alternate])
      await new Promise((resolve) => setTimeout(resolve, 20))
      events.push('discover-done')
      return {
        ok: true,
        queries: ['example query'],
        candidates: [best, early, alternate],
        discoveredCount: 3,
        metrics: {
          durationMs: 20,
          searchesAttempted: 1,
          cacheHits: 0,
          navigation: { count: 1, domReadyMs: 5, settleMs: 5, settleReasons: {} }
        }
      }
    },
    async run(request: { urls?: string[] }) {
      events.push('background-run')
      events.push(`background-urls:${request.urls?.join(',') ?? ''}`)
      return { ok: true, pages: [] }
    }
  }
  const browserAgent = {
    async snapshot(options: { url?: string }) {
      events.push(`snapshot:${options.url}`)
      return { ok: true, url: options.url }
    },
    blockedTurnBrowserResult: () => null,
    blockTurnBrowserWork: () => {}
  }
  return {
    browserAgent: browserAgent as unknown as BrowserToolDeps['browserAgent'],
    researchRunner: researchRunner as unknown as BrowserToolDeps['researchRunner']
  }
}

test('browser_live_search navigates on the earliest lane candidate before discovery completes', async () => {
  const events: string[] = []
  const { result } = await runBrowserTool(
    { tool: 'browser_live_search', args: { objective: 'facts', query: 'example query' }, owner: null, callId: 'c1' },
    fakeDeps({ fireEarly: true, events })
  )

  assert.ok(events.indexOf(`snapshot:${early.url}`) < events.indexOf('discover-done'),
    `navigation must start before discovery finishes: ${events.join(' -> ')}`)
  const destination = result.destination as { url: string }
  assert.equal(destination.url, early.url)
  const alternates = result.alternates as Array<{ url: string }>
  assert.deepEqual(alternates.map(({ url }) => url), [best.url, alternate.url])
})

test('browser_live_search falls back to the top-ranked candidate when no lane fires early', async () => {
  const events: string[] = []
  const { result } = await runBrowserTool(
    { tool: 'browser_live_search', args: { objective: 'facts', query: 'example query' }, owner: null, callId: 'c2' },
    fakeDeps({ fireEarly: false, events })
  )

  const destination = result.destination as { url: string }
  assert.equal(destination.url, best.url)
  assert.ok(events.indexOf(`snapshot:${best.url}`) > events.indexOf('discover-done'))
  const alternates = result.alternates as Array<{ url: string }>
  assert.deepEqual(alternates.map(({ url }) => url), [early.url, alternate.url])
})

test('browser_live_search background mode starts live and independent evidence work on the first candidate batch', async () => {
  const events: string[] = []
  const { result } = await runBrowserTool(
    { tool: 'browser_live_search', args: { objective: 'facts', query: 'example query', background: true }, owner: null, callId: 'c3' },
    fakeDeps({ fireEarly: true, events })
  )

  assert.ok(events.indexOf(`snapshot:${early.url}`) < events.indexOf('discover-done'),
    `live lane must start before discovery finishes: ${events.join(' -> ')}`)
  assert.ok(events.indexOf('background-run') < events.indexOf('discover-done'),
    `background lane must start before discovery finishes: ${events.join(' -> ')}`)
  assert.ok(events.includes(`background-urls:${alternate.url}`),
    `background lane should verify an independent early candidate: ${events.join(' -> ')}`)
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'hidden-discovery-direct-navigation-plus-research')
  const destination = result.destination as { url: string }
  assert.equal(destination.url, early.url)
  const alternates = result.alternates as Array<{ url: string }>
  assert.deepEqual(alternates.map(({ url }) => url), [best.url, alternate.url])
  const timings = result.timings as { firstUrlMs: number; totalMs: number }
  assert.ok(timings.firstUrlMs < 20, `first URL dispatch regressed: ${JSON.stringify(timings)}`)
})

test('browser_research_dual remains an unadvertised compatibility alias', async () => {
  const events: string[] = []
  const { result } = await runBrowserTool(
    { tool: 'browser_research_dual', args: { objective: 'facts', query: 'example query' }, owner: null, callId: 'c4' },
    fakeDeps({ fireEarly: true, events })
  )

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'hidden-discovery-direct-navigation-plus-research')
  assert.equal((result.live as { ok: boolean }).ok, true)
})
