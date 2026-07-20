import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBrowserUseGuidance, decideBrowserUse } from './browser-use-policy.ts'

test('quality-max routes implicit current information to background research', () => {
  const decision = decideBrowserUse('Who is the current CEO and what is the latest price?', 'quality-max')
  assert.equal(decision.required, true)
  assert.equal(decision.mode, 'background')
  assert.match(decision.reason, /preserve the visible tab/i)
})

test('quality-max routes broad public research to background', () => {
  assert.equal(decideBrowserUse('Compare the leading deployment platforms', 'quality-max').mode, 'background')
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

test('quality-max guidance preserves task judgment and the visible tab by default', () => {
  const guidance = buildBrowserUseGuidance({ CODEX_DESKTOP_BROWSER_PRESET: 'quality-max' })
  assert.match(guidance, /live browser is the authority/i)
  assert.match(guidance, /ordinary task judgment/i)
  assert.match(guidance, /preserve the user's literal product names and intent/i)
  assert.match(guidance, /Prefer research_web for broad public discovery/i)
  assert.match(guidance, /not an answer/i)
  assert.doesNotMatch(guidance, /three to six semantic query variations/i)
  assert.doesNotMatch(guidance, /should normally use browser_live_search/i)
  assert.match(guidance, /Never navigate the visible tab to a SERP/i)
})

test('claude lane guidance prefixes tools and forbids built-in web tools', () => {
  const guidance = buildBrowserUseGuidance({ CODEX_DESKTOP_BROWSER_PRESET: 'quality-max' }, 'claude')
  assert.match(guidance, /WebSearch and WebFetch tools are disabled/i)
  assert.match(guidance, /Prefer mcp__browser__research_web for broad public discovery/i)
  assert.doesNotMatch(guidance, /Use browser_live_search/)
})
