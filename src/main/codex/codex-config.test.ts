import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js'
import { selectTurnSkills } from './codex-config.js'

const extractionSkill: SkillMetadata = {
  name: 'web-page-extraction',
  description: 'Extract web evidence',
  path: '/app/skills/web-page-extraction/SKILL.md',
  scope: 'user',
  enabled: true
}

test('web research turns attach the extraction skill', () => {
  assert.deepEqual(
    selectTurnSkills('Research the latest Electron navigation guidance', [extractionSkill]),
    [extractionSkill]
  )
})

test('unrelated implementation turns do not load the extraction skill', () => {
  assert.deepEqual(
    selectTurnSkills('Refactor the tab manager and run its tests', [extractionSkill]),
    []
  )
})

test('an explicit skill mention always attaches it', () => {
  assert.deepEqual(
    selectTurnSkills('Use $web-page-extraction for this task', [extractionSkill]),
    [extractionSkill]
  )
})
