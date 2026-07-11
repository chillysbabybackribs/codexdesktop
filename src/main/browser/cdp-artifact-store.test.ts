import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
