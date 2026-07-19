import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chunkMarkdownSegments,
  markdownSegmentChunkSize,
  splitMarkdownSegments
} from './streaming-markdown.ts'

test('empty text produces no segments', () => {
  assert.deepEqual(splitMarkdownSegments(''), [])
})

test('segments concatenate back to the exact original text', () => {
  const cases = [
    'one paragraph',
    'para one\n\npara two\n\npara three',
    'trailing newline\n\nsecond\n',
    'many\n\n\n\nblank lines\n\n\nbetween',
    '# Heading\n\ntext under it\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nafter fence',
    '- item one\n\n- item two\n\nparagraph\n\n1. first\n\n2. second'
  ]
  for (const text of cases) {
    assert.equal(splitMarkdownSegments(text).join(''), text)
  }
})

test('plain paragraphs split into one segment each', () => {
  const segments = splitMarkdownSegments('alpha\n\nbeta\n\ngamma')
  assert.equal(segments.length, 3)
  assert.equal(segments[0], 'alpha\n\n')
  assert.equal(segments[2], 'gamma')
})

test('blank lines inside a code fence never split the fence', () => {
  const text = 'before\n\n```py\nprint(1)\n\nprint(2)\n```\n\nafter'
  const segments = splitMarkdownSegments(text)
  assert.equal(segments.length, 3)
  assert.ok(segments[1].includes('print(1)\n\nprint(2)'))
})

test('tilde fences and longer closing fences are respected', () => {
  const text = '~~~\na\n\nb\n~~~~\n\nnext'
  const segments = splitMarkdownSegments(text)
  assert.equal(segments.length, 2)
  assert.equal(segments[1], 'next')
})

test('an unclosed fence keeps everything after it in the last segment', () => {
  const text = 'intro\n\n```\nstreaming code\n\nstill code'
  const segments = splitMarkdownSegments(text)
  assert.equal(segments.length, 2)
  assert.equal(segments[1], '```\nstreaming code\n\nstill code')
})

test('loose ordered lists stay in one segment so numbering survives', () => {
  const text = 'intro\n\n1. first\n\n2. second\n\n3. third\n\noutro'
  const segments = splitMarkdownSegments(text)
  assert.equal(segments.length, 3)
  assert.equal(segments[1], '1. first\n\n2. second\n\n3. third\n\n')
})

test('indented continuation merges with the preceding segment', () => {
  const text = 'lead\n\n    indented code\n\nplain'
  const segments = splitMarkdownSegments(text)
  assert.equal(segments.length, 2)
  assert.equal(segments[0], 'lead\n\n    indented code\n\n')
})

test('earlier segments are stable as streamed text grows', () => {
  const base = 'first paragraph\n\nsecond paragraph\n\nthird'
  const grown = `${base} keeps growing\n\nfourth paragraph`
  const baseSegments = splitMarkdownSegments(base)
  const grownSegments = splitMarkdownSegments(grown)
  assert.deepEqual(grownSegments.slice(0, baseSegments.length - 1), baseSegments.slice(0, -1))
})

test('chunking passes small documents through untouched', () => {
  const segments = ['a\n\n', 'b\n\n', 'c']
  assert.deepEqual(chunkMarkdownSegments(segments), segments)
})

test('chunking bounds component count and preserves content and boundaries', () => {
  const segments = Array.from({ length: 100 }, (_, index) => `p${index}\n\n`)
  const chunks = chunkMarkdownSegments(segments)
  assert.equal(chunks.length, Math.ceil(100 / markdownSegmentChunkSize))
  assert.equal(chunks.join(''), segments.join(''))
  // Filled chunks keep identical content when the document grows.
  const grownChunks = chunkMarkdownSegments([...segments, 'p100\n\n', 'p101'])
  assert.deepEqual(grownChunks.slice(0, chunks.length - 1), chunks.slice(0, -1))
})
