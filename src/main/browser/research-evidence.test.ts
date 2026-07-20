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
  assert.deepEqual(
    normalizeResearchFocus([
      { id: 'x', need: 'first' },
      { id: 'x-2', need: 'second' },
      { id: 'x', need: 'third' }
    ]).map(({ id }) => id),
    ['x', 'x-2', 'x-3']
  )
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

test('multi-clause evidence requires the answer-bearing clause instead of lexical overlap alone', () => {
  const source: ResearchEvidenceDocument = {
    ...document('page-01', [
      '# Document: querySelectorAll() method',
      '',
      'The method returns a static (not live) NodeList representing matching elements.',
      '',
      '## Return value',
      '',
      'A non-live NodeList containing one Element object for each match.',
      '',
      'The elements are in document order — parents before children, earlier siblings before later siblings.',
      '',
      'const matches = document.querySelectorAll("p");',
      '',
      'This example returns a list of all div elements.'
    ].join('\n')),
    title: 'Document: querySelectorAll() method'
  }

  const packet = selectResearchEvidence(
    [{
      id: 'ordering',
      need: 'What does Document.querySelectorAll return, and how is the result ordered?',
      minSources: 1
    }],
    [source],
    1_000
  )

  assert.deepEqual(packet.gaps, [])
  assert.match(packet.passages[0]?.text ?? '', /static \(not live\) NodeList/i)
  assert.match(packet.passages[0]?.text ?? '', /document order/i)
  assert.doesNotMatch(packet.passages[0]?.text ?? '', /^const matches[\s\S]*This example returns/i)
})

test('a relevant complaint thread is not rejected because the focus lists alternative symptoms', () => {
  const source: ResearchEvidenceDocument = {
    ...document('page-01', [
      '# Desktop app lagging and maxing CPU usage suddenly',
      '',
      'The desktop process now maxes out CPU and the interface lags during ordinary conversations.',
      'This started after the latest update.'
    ].join('\n')),
    title: 'Desktop app lagging and maxing CPU usage suddenly'
  }

  const packet = selectResearchEvidence(
    [{
      id: 'performance',
      need: 'Firsthand complaints that Claude Desktop uses high CPU, freezes, crashes, or is slow, preferably recent.',
      minSources: 1
    }],
    [source]
  )

  assert.deepEqual(packet.gaps, [])
  assert.match(packet.passages[0]?.text ?? '', /maxes out CPU/i)
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
  assert.equal(selectResearchEvidence(
    [{ id: 'refund', need: 'refund window', minSources: 1 }],
    [document('page-02', 'Browser window dimensions are restored on startup.')]
  ).passages.length, 0)
  assert.equal(selectResearchEvidence(
    [{ id: 'kernel', need: 'Linux kernel version 6.8', minSources: 1 }],
    [document('page-03', 'Linux requires kernel version 5.4 for this feature.')]
  ).passages.length, 0)
})

test('the combined evidence text stays inside the requested result budget', () => {
  const focus = Array.from({ length: 6 }, (_, index) => ({
    id: `claim-${index}`,
    need: `claim${index} evidence`,
    minSources: 3
  }))
  const sourceLabels = ['alpha', 'bravo', 'charlie']
  const sources = Array.from({ length: 3 }, (_, sourceIndex) => document(
    `page-0${sourceIndex + 1}`,
    `${focus.map((item) => `${item.need} from independent source ${sourceLabels[sourceIndex]}.`).join('\n')}\nUnique ${sourceLabels[sourceIndex]}.`
  ))

  const packet = selectResearchEvidence(focus, sources, 1_000)

  assert.deepEqual(packet.gaps, [])
  assert.equal(packet.passages.length, 18)
  assert.ok(packet.passages.reduce((total, passage) => total + passage.text.length, 0) <= 1_000)
})

test('passage windows remain contiguous and bounded when adjacent lines are oversized', () => {
  const lines = [
    'Small context two lines before.',
    'Oversized left context '.repeat(100),
    'Target migration evidence is here.',
    'Oversized right context '.repeat(100),
    'Small context two lines after.'
  ]
  const passage = selectResearchEvidence(
    [{ id: 'target', need: 'migration evidence', minSources: 1 }],
    [document('page-01', lines.join('\n'))],
    1_000
  ).passages[0]

  assert.ok(passage)
  assert.ok(passage.text.length <= 1_000)
  assert.equal(passage.text, lines.slice(passage.lineStart - 1, passage.lineEnd).join('\n'))
})

test('matched terms always occur in a truncated long-line passage', () => {
  const content = `alpha beta gamma ${'filler '.repeat(400)} discount`
  const passage = selectResearchEvidence(
    [{ id: 'spread', need: 'alpha beta gamma discount', minSources: 1 }],
    [document('page-01', content)],
    1_000
  ).passages[0]

  assert.ok(passage)
  assert.ok(passage.text.length <= 1_000)
  assert.equal(passage.text, content.slice(passage.columnStart, passage.columnEnd))
  for (const term of passage.matchedTerms) assert.match(passage.text.toLowerCase(), new RegExp(`\\b${term}\\b`))
})

test('non-Latin evidence remains matchable and distinct', () => {
  const packet = selectResearchEvidence(
    [{ id: 'pricing', need: '価格 年間 割引', minSources: 2 }],
    [
      document('page-01', '法人向けの価格には年間契約の割引があります。東京。'),
      document('page-02', '価格と年間プランの割引を案内します。大阪。')
    ]
  )

  assert.deepEqual(packet.gaps, [])
  assert.equal(packet.passages.length, 2)
})
