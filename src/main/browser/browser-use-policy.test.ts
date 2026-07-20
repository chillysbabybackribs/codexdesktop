import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBrowserUseGuidance, decideBrowserUse } from './browser-use-policy.ts'

test('quality-max chooses dual for implicit current information', () => {
  const decision = decideBrowserUse('Who is the current CEO and what is the latest price?', 'quality-max')
  assert.equal(decision.required, true)
  assert.equal(decision.mode, 'dual')
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

test('guidance names the first-class dual tool', () => {
  assert.match(buildBrowserUseGuidance({ CODEX_DESKTOP_BROWSER_PRESET: 'quality-max' }), /browser_research_dual/)
})
