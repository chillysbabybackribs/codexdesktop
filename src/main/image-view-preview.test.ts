import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readImageViewDataUrl } from './image-view-preview.js'

const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZJwAAAABJRU5ErkJggg==', 'base64')

test('image view preview reads a bounded local image and rejects non-images', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexdesktop-image-view-'))
  try {
    const imagePath = join(directory, 'screenshot.png')
    const textPath = join(directory, 'notes.txt')
    await writeFile(imagePath, onePixelPng)
    await writeFile(textPath, 'not an image')

    assert.match(await readImageViewDataUrl(imagePath) ?? '', /^data:image\/png;base64,/)
    assert.equal(await readImageViewDataUrl(textPath), null)
    assert.equal(await readImageViewDataUrl('relative.png'), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
