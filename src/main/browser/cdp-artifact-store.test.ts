import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CdpArtifactStore } from './cdp-artifact-store.ts'

const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WAAAAABJRU5ErkJggg=='

test('CDP artifact store persists a screenshot with image metadata', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-cdp-artifacts-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new CdpArtifactStore(root)

  const artifact = await store.persistScreenshot(onePixelPng, 'png')
  const dataUrl = await store.readImageDataUrl(artifact.artifactPath)

  assert.match(artifact.fileName, /^screenshot-.*\.png$/)
  assert.equal(artifact.mediaType, 'image/png')
  assert.equal(artifact.width, 1)
  assert.equal(artifact.height, 1)
  assert.equal(artifact.bytes > 0, true)
  assert.equal(dataUrl, `data:image/png;base64,${onePixelPng}`)
})

test('CDP artifact store rejects screenshot paths outside its owned directory', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-cdp-artifacts-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new CdpArtifactStore(root)

  assert.equal(await store.readImageDataUrl('/tmp/not-owned.png'), null)
})

test('CDP artifact store persists PDFs and drains trace streams without keeping them in memory', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-cdp-artifacts-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new CdpArtifactStore(root)
  const pdf = await store.persistPdf(Buffer.from('%PDF-1.4\nminimal\n%%EOF').toString('base64'))
  const chunks = [
    { data: '{"traceEvents":[', eof: false },
    { data: '{"name":"first"}]}', eof: true }
  ]
  const trace = await store.persistTraceStream(async () => chunks.shift() ?? { data: '', eof: true })

  assert.equal(pdf.kind, 'pdf')
  assert.equal(pdf.mediaType, 'application/pdf')
  assert.match(pdf.artifactPath, /\.pdf$/)
  assert.equal(trace.kind, 'trace')
  assert.equal(trace.mediaType, 'application/json')
  assert.equal(await readFile(trace.artifactPath, 'utf8'), '{"traceEvents":[{"name":"first"}]}')
})

test('CDP artifact store persists decoded response bodies with a safe extension', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-cdp-artifacts-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new CdpArtifactStore(root)
  const artifact = await store.persistResponseBody(
    Buffer.from('{"ok":true}').toString('base64'),
    true,
    'application/json; charset=utf-8',
    'https://example.com/api/data'
  )

  assert.equal(artifact.kind, 'response-body')
  assert.equal(artifact.mediaType, 'application/json')
  assert.match(artifact.artifactPath, /\.json$/)
  assert.equal(await readFile(artifact.artifactPath, 'utf8'), '{"ok":true}')
})
