import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBrowserUseGuidance, decideBrowserUse } from './browser-use-policy.ts'

test('quality-max chooses live browser for implicit current information', () => {
  const decision = decideBrowserUse('Who is the current CEO and what is the latest price?', 'quality-max')
  assert.equal(decision.required, true)
  assert.equal(decision.mode, 'live')
  assert.match(decision.reason, /live browser/i)
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

test('quality-max guidance prioritizes the live browser without mandatory dual research', () => {
  const guidance = buildBrowserUseGuidance({ CODEX_DESKTOP_BROWSER_PRESET: 'quality-max' })
  assert.match(guidance, /live browser is the authority/i)
  assert.match(guidance, /prefer the live browser first/i)
  assert.match(guidance, /browser_research_dual only/i)
  assert.match(guidance, /three to six semantic query variations/i)
  assert.match(guidance, /Never navigate the visible tab to a SERP/i)
  assert.doesNotMatch(guidance, /should normally use browser_research_dual/i)
  assert.doesNotMatch(guidance, /requires visible verification plus independent/i)
})
