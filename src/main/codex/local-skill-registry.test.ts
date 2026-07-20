import assert from 'node:assert/strict';
import test from 'node:test';
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js';
import { isPathWithin, LocalSkillRegistry } from './local-skill-registry.js';

const researchSkill: SkillMetadata = {
  name: 'artifact-first-web-research',
  description: 'Research from artifacts',
  path: '/app/skills/artifact-first-web-research/SKILL.md',
  scope: 'user',
  enabled: true,
};

const planningSkill: SkillMetadata = {
  name: 'planning',
  description: 'Create plans for technical and non-technical work',
  path: '/app/skills/planning/SKILL.md',
  scope: 'user',
  enabled: true,
};

const editorialWaitlistSkill: SkillMetadata = {
  name: 'superdesign-editorial-waitlist',
  description: 'Build editorial waitlist landing pages from a visual contract',
  path: '/app/skills/superdesign-editorial-waitlist/SKILL.md',
  scope: 'user',
  enabled: true,
};

test('local skill path containment rejects siblings and traversal', () => {
  assert.equal(isPathWithin('/app/skills', '/app/skills/research/SKILL.md'), true);
  assert.equal(isPathWithin('/app/skills', '/app/skills-other/research/SKILL.md'), false);
  assert.equal(isPathWithin('/app/skills', '/app/skills/../outside/SKILL.md'), false);
});

test('local skill registry composes visible text, attachments, and one skill input', () => {
  const registry = new LocalSkillRegistry('/app', '/app/skills', [researchSkill]);
  assert.deepEqual(
    registry.list().map((skill) => skill.name),
    [researchSkill.name],
  );
  const input = registry.buildTurnInput('$artifact-first-web-research Research this image', false, [
    {
      id: 'image-1',
      kind: 'image',
      name: 'image.png',
      path: '/tmp/image.png',
      mediaType: 'image/png',
      size: 10,
    },
  ]);

  assert.deepEqual(
    input.map((item) => item.type),
    ['skill', 'text', 'localImage'],
  );
  assert.equal(input[0]?.type === 'skill' && input[0].name, researchSkill.name);
  assert.equal(
    input[1]?.type === 'text' && input[1].text,
    '$artifact-first-web-research Research this image',
  );
  assert.equal(input[2]?.type === 'localImage' && input[2].detail, 'high');
});

test('ordinary turns do not force-attach the planning skill', () => {
  const registry = new LocalSkillRegistry('/app', '/app/skills', [planningSkill]);
  const input = registry.buildTurnInput('Help me decide how to approach this', false);

  assert.deepEqual(
    input.map((item) => item.type),
    ['text'],
  );
  assert.equal(input[0]?.type === 'text' && input[0].text, 'Help me decide how to approach this');
});

test('editorial waitlist turns send the reference skill to the model', () => {
  const registry = new LocalSkillRegistry('/app', '/app/skills', [editorialWaitlistSkill]);
  const input = registry.buildTurnInput(
    'Build an editorial waitlist landing page for a private design salon',
    false,
  );

  assert.deepEqual(
    input.map((item) => item.type),
    ['skill', 'text'],
  );
  assert.equal(input[0]?.type === 'skill' && input[0].name, editorialWaitlistSkill.name);
  assert.equal(
    input[1]?.type === 'text' && input[1].text,
    '$superdesign-editorial-waitlist\nBuild an editorial waitlist landing page for a private design salon',
  );
});
