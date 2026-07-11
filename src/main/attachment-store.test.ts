import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AttachmentStore } from './attachment-store.ts'

const onePixelPng = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137
])

test('attachment store validates, persists, and previews an owned image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexdesktop-attachments-'))
  try {
    const store = new AttachmentStore(directory)
    const [attachment] = await store.persistFiles([{ name: '../shot.png', mediaType: 'image/png', data: onePixelPng }])
    assert.ok(attachment)
    assert.equal(attachment.kind, 'image')
    assert.equal(attachment.name, 'shot.png')
    assert.match(attachment.path, /^[\s\S]*--shot\.png$/)
    assert.match(await store.preview(attachment.path) ?? '', /^data:image\/png;base64,/)
    assert.equal(await store.preview(join(directory, '..', 'outside.png')), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('attachment store rejects extension spoofing and unsupported binaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexdesktop-attachments-'))
  try {
    const store = new AttachmentStore(directory)
    await assert.rejects(
      store.persistFiles([{ name: 'fake.pdf', mediaType: 'application/pdf', data: new Uint8Array([1, 2, 3]) }]),
      /not a valid PDF/
    )
    await assert.rejects(
      store.persistFiles([{ name: 'payload.exe', mediaType: 'application/octet-stream', data: new Uint8Array([1, 2, 3]) }]),
      /not a supported file type/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('attachment verification rejects renderer path and identity tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexdesktop-attachments-'))
  try {
    const store = new AttachmentStore(directory)
    const [attachment] = await store.persistFiles([{ name: 'shot.png', mediaType: 'image/png', data: onePixelPng }])
    assert.ok(attachment)
    await assert.rejects(store.verify([{ ...attachment, path: join(directory, '..', 'shot.png') }]), /not owned/)
    await assert.rejects(store.verify([{ ...attachment, id: crypto.randomUUID() }]), /identity does not match/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
