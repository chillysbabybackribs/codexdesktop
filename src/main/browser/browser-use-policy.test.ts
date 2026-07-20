import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBrowserUseGuidance, decideBrowserUse } from './browser-use-policy.ts'

test('quality-max routes implicit current information to dual', () => {
  const decision = decideBrowserUse('Who is the current CEO and what is the latest price?', 'quality-max')
  assert.equal(decision.required, true)
  assert.equal(decision.mode, 'dual')
  assert.match(decision.reason, /parallel background research/i)
})

test('quality-max routes broad research to dual', () => {
  assert.equal(decideBrowserUse('Compare the leading deployment platforms', 'quality-max').mode, 'dual')
})

test('quality-max keeps referenced pages live-only', () => {
  const decision = decideBrowserUse('Summarize the API docs page for me', 'quality-max')
  assert.equal(decision.mode, 'live')
  assert.match(decision.reason, /referenced page/i)
})

test('interactive browser state remains live-only', () => {
  assert.equal(decideBrowserUse('Check my inbox in the current tab', 'quality-max').mode, 'live')
})

test('balanced uses the background lane for broad public research', () => {
  assert.equal(decideBrowserUse('Compare the leading deployment platforms', 'balanced').mode, 'background')
})

test('manual does not infer browsing', () => {
  assert.equal(decideBrowserUse('What is the latest release?', 'manual').mode, 'none')
})

test('quality-max guidance makes unified search with background evidence the normal path', () => {
  const guidance = buildBrowserUseGuidance({ CODEX_DESKTOP_BROWSER_PRESET: 'quality-max' })
  assert.match(guidance, /live browser is the authority/i)
  assert.match(guidance, /should normally use browser_live_search with background=true/i)
  assert.match(guidance, /complements visible verification instead of replacing it/i)
  assert.match(guidance, /three to six semantic query variations/i)
  assert.match(guidance, /Never navigate the visible tab to a SERP/i)
  assert.doesNotMatch(guidance, /browser_research_dual/i)
})

test('claude lane guidance prefixes tools and forbids built-in web tools', () => {
  const guidance = buildBrowserUseGuidance({ CODEX_DESKTOP_BROWSER_PRESET: 'quality-max' }, 'claude')
  assert.match(guidance, /WebSearch and WebFetch tools are disabled/i)
  assert.match(guidance, /should normally use mcp__browser__browser_live_search with background=true/i)
  assert.doesNotMatch(guidance, /browser_research_dual/i)
  assert.doesNotMatch(guidance, /Use browser_live_search/)
})
