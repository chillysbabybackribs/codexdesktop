import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeResearchFocus,
  selectResearchEvidence,
  type ResearchEvidenceDocument
} from './research-evidence.ts'

function document(sourceId: string, content: string): ResearchEvidenceDocument {
  return {
    sourceId,
    title: `Source ${sourceId}`,
    url: `https://example.com/${sourceId}`,
    artifactPath: `/research/${sourceId}.txt`,
    content,
    observedAt: '2026-07-12T12:00:00.000Z',
    sourceTier: 'primary'
  }
}

test('focus normalization bounds values and makes duplicate ids deterministic', () => {
  assert.deepEqual(normalizeResearchFocus([
    { id: 'price', need: 'Enterprise annual price', minSources: 2 },
    { id: 'price', need: 'Independent price confirmation', minSources: 99 },
    { id: '', need: 'Fallback identifier' },
    { id: 'empty', need: '   ' }
  ]), [
    { id: 'price', need: 'Enterprise annual price', minSources: 2 },
    { id: 'price-2', need: 'Independent price confirmation', minSources: 3 },
    { id: 'focus-3', need: 'Fallback identifier', minSources: 1 }
  ])
})

test('evidence selection returns an exact bounded passage with artifact line locators', () => {
  const lines = [
    '# Plans',
    'Starter is intended for small teams.',
    '',
    '# Enterprise',
    'The Enterprise plan costs $99 per seat.',
    'Annual billing includes a 20 percent discount.',
    '',
    'Priority support is included.'
  ]
  const packet = selectResearchEvidence(
    [{ id: 'enterprise', need: 'enterprise annual price discount', minSources: 1 }],
    [document('page-01', lines.join('\n'))],
    1_000
  )

  assert.deepEqual(packet.gaps, [])
  assert.equal(packet.passages.length, 1)
  const passage = packet.passages[0]
  assert.ok(passage)
  assert.equal(passage.lineStart, 4)
  assert.equal(passage.lineEnd, 8)
  assert.equal(passage.text, lines.slice(passage.lineStart - 1, passage.lineEnd).join('\n'))
  assert.deepEqual(passage.matchedTerms, ['enterprise', 'annual', 'discount'])
})

test('evidence selection finds claims beyond the former artifact prefix', () => {
  const filler = Array.from({ length: 600 }, (_, index) => `Background paragraph ${index} with ordinary context.`)
  const content = [...filler, 'The migration requires kernel version 6.8 on Linux.'].join('\n')
  assert.ok(content.indexOf('kernel version') > 8_000)

  const packet = selectResearchEvidence(
    [{ id: 'kernel', need: 'Linux kernel version 6.8', minSources: 1 }],
    [document('page-01', content)],
    1_000
  )

  assert.deepEqual(packet.gaps, [])
  assert.match(packet.passages[0]?.text ?? '', /kernel version 6\.8/)
  assert.equal(packet.passages[0]?.lineStart, 599)
})

test('evidence selection reports missing and insufficient independent source coverage', () => {
  const matching = document('page-01', 'Refunds are available within a 30 day window.')
  const duplicate = document('page-02', matching.content)
  const insufficient = selectResearchEvidence(
    [{ id: 'refund', need: 'refund window', minSources: 2 }],
    [matching, duplicate]
  )

  assert.equal(insufficient.passages.length, 1)
  assert.deepEqual(insufficient.gaps, [{
    focusId: 'refund',
    need: 'refund window',
    requiredSources: 2,
    matchedSources: 1,
    reason: 'insufficient-source-coverage'
  }])

  const missing = selectResearchEvidence(
    [{ id: 'export', need: 'data export format', minSources: 1 }],
    [matching]
  )
  assert.deepEqual(missing.passages, [])
  assert.equal(missing.gaps[0]?.reason, 'no-relevant-passage')
})

test('focus matching uses whole tokens and treats stopword-only needs as gaps', () => {
  const source = document('page-01', 'Trust is central to the security model.')
  assert.equal(selectResearchEvidence(
    [{ id: 'language', need: 'rust', minSources: 1 }],
    [source]
  ).passages.length, 0)
  assert.equal(selectResearchEvidence(
    [{ id: 'empty', need: 'the and of', minSources: 1 }],
    [source]
  ).gaps[0]?.reason, 'no-relevant-passage')
})

test('the combined evidence text stays inside the requested result budget', () => {
  const focus = Array.from({ length: 6 }, (_, index) => ({
    id: `claim-${index}`,
    need: `claim${index} evidence`,
    minSources: 3
  }))
  const sources = Array.from({ length: 3 }, (_, sourceIndex) => document(
    `page-0${sourceIndex + 1}`,
    `${focus.map((item) => `${item.need} from independent source ${sourceIndex}.`).join('\n')}\nUnique ${sourceIndex}.`
  ))

  const packet = selectResearchEvidence(focus, sources, 1_000)

  assert.deepEqual(packet.gaps, [])
  assert.equal(packet.passages.length, 18)
  assert.ok(packet.passages.reduce((total, passage) => total + passage.text.length, 0) <= 1_000)
})
