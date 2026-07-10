import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js'
import { formatSkillInvocationText, selectTurnSkills } from './codex-config.js'

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
