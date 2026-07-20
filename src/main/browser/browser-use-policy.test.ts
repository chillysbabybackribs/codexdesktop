import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBrowserUseGuidance, decideBrowserUse, formatBrowserDecisionNote } from './browser-use-policy.ts'

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

test('quality-max guidance makes dual the normal search path', () => {
  const guidance = buildBrowserUseGuidance({ CODEX_DESKTOP_BROWSER_PRESET: 'quality-max' })
  assert.match(guidance, /live browser is the authority/i)
  assert.match(guidance, /should normally use browser_research_dual/i)
  assert.match(guidance, /complements visible verification instead of replacing it/i)
  assert.match(guidance, /three to six semantic query variations/i)
  assert.match(guidance, /Never navigate the visible tab to a SERP/i)
  assert.doesNotMatch(guidance, /browser_research_dual only for/i)
})

test('claude lane guidance prefixes tools and forbids built-in web tools', () => {
  const guidance = buildBrowserUseGuidance({ CODEX_DESKTOP_BROWSER_PRESET: 'quality-max' }, 'claude')
  assert.match(guidance, /WebSearch and WebFetch tools are disabled/i)
  assert.match(guidance, /should normally use mcp__browser__browser_research_dual/i)
  assert.match(guidance, /mcp__browser__browser_live_search/)
  assert.doesNotMatch(guidance, /Use browser_live_search/)
})

test('decision note names the starting tool for the chosen lane', () => {
  const dual = formatBrowserDecisionNote(decideBrowserUse('search the web for the latest release', 'quality-max'))
  assert.match(dual!, /mode=dual/)
  assert.match(dual!, /Start with browser_research_dual/)

  const claudeLive = formatBrowserDecisionNote(
    decideBrowserUse('Check my inbox in the current tab', 'quality-max'),
    'claude',
  )
  assert.match(claudeLive!, /mcp__browser__browser_live_search or mcp__browser__browser_snapshot/)

  assert.equal(formatBrowserDecisionNote(decideBrowserUse('refactor this function', 'quality-max')), null)
  assert.equal(formatBrowserDecisionNote(decideBrowserUse('What is the latest release?', 'manual')), null)
})
