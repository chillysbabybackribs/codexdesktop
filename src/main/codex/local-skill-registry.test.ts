import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js'
import { isPathWithin, LocalSkillRegistry } from './local-skill-registry.js'

const researchSkill: SkillMetadata = {
  name: 'artifact-first-web-research',
  description: 'Research from artifacts',
  path: '/app/skills/artifact-first-web-research/SKILL.md',
  scope: 'user',
  enabled: true
}

test('local skill path containment rejects siblings and traversal', () => {
  assert.equal(isPathWithin('/app/skills', '/app/skills/research/SKILL.md'), true)
  assert.equal(isPathWithin('/app/skills', '/app/skills-other/research/SKILL.md'), false)
  assert.equal(isPathWithin('/app/skills', '/app/skills/../outside/SKILL.md'), false)
})

test('local skill registry composes visible text, attachments, and one skill input', () => {
  const registry = new LocalSkillRegistry('/app', '/app/skills', [researchSkill])
  const input = registry.buildTurnInput(
    '$artifact-first-web-research Research this image',
    false,
    [{
      id: 'image-1',
      kind: 'image',
      name: 'image.png',
      path: '/tmp/image.png',
      mediaType: 'image/png',
      size: 10
    }]
  )

  assert.deepEqual(input.map((item) => item.type), ['text', 'localImage', 'skill'])
  assert.equal(input[0]?.type === 'text' && input[0].text, '$artifact-first-web-research Research this image')
  assert.equal(input[1]?.type === 'localImage' && input[1].detail, 'high')
  assert.equal(input[2]?.type === 'skill' && input[2].name, researchSkill.name)
})
