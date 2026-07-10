import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js'
import {
  browserDynamicTools,
  formatSkillInvocationText,
  resolveTurnPolicy,
  selectTurnSkills
} from './codex-config.js'

const webResearchSkill: SkillMetadata = {
  name: 'artifact-first-web-research',
  description: 'Research the web from saved artifacts',
  path: '/app/skills/artifact-first-web-research/SKILL.md',
  scope: 'user',
  enabled: true
}

test('web research turns attach the extraction skill', () => {
  assert.deepEqual(
    selectTurnSkills('Research the latest Electron navigation guidance', [webResearchSkill]),
    [webResearchSkill]
  )
})

test('unrelated implementation turns do not load the extraction skill', () => {
  assert.deepEqual(
    selectTurnSkills('Refactor the tab manager and run its tests', [webResearchSkill]),
    []
  )
})

test('an explicit skill mention always attaches it', () => {
  assert.deepEqual(
    selectTurnSkills('Use $artifact-first-web-research for this task', [webResearchSkill]),
    [webResearchSkill]
  )
})

test('automatic skill invocation adds the app-server text marker', () => {
  assert.equal(
    formatSkillInvocationText('Research Electron navigation', [webResearchSkill]),
    '$artifact-first-web-research\nResearch Electron navigation'
  )
})

test('explicit skill invocation does not duplicate its marker', () => {
  const text = '$artifact-first-web-research Research Electron navigation'
  assert.equal(formatSkillInvocationText(text, [webResearchSkill]), text)
})

test('research turns keep the configured reasoning effort', () => {
  const policy = resolveTurnPolicy('Find recent firsthand Linux migration reports with sources')

  assert.deepEqual(policy, { summary: 'concise' })
  assert.equal('effort' in policy, false)
})

test('implementation turns use automatic reasoning summaries', () => {
  assert.deepEqual(resolveTurnPolicy('Refactor the tab manager and run its tests'), { summary: 'auto' })
})

test('the dynamic tool surface includes verified research primitives', () => {
  assert.deepEqual(
    browserDynamicTools.map((tool) => tool.name),
    ['browser_run', 'browser_extract_page', 'browser_cdp', 'research_web']
  )
})
