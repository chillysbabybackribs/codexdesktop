import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { DownloadItem, WebContents } from 'electron'
import { BrowserDownloadCaptureBroker } from './browser-download-capture.ts'
import { CdpArtifactStore } from './cdp-artifact-store.ts'

test('download capture broker claims one targeted download and materializes it as an artifact', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-download-capture-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const broker = new BrowserDownloadCaptureBroker()
  const webContents = {} as WebContents
  let savePath = ''
  const item = Object.assign(new EventEmitter(), {
    getURL: () => 'https://example.com/exports/report.pdf',
    getFilename: () => '../report.pdf',
    getMimeType: () => 'application/pdf',
    getTotalBytes: () => 7,
    getReceivedBytes: () => 7,
    setSavePath: (value: string) => { savePath = value },
    isDestroyed: () => false,
    cancel: () => {}
  }) as unknown as DownloadItem

  const { capture: waiting } = await broker.prepareDownload(
    webContents,
    '/exports/report',
    new CdpArtifactStore(root),
    1_000
  )
  assert.equal(broker.handleWillDownload(item, webContents), true)
  assert.match(savePath, /download-.+\.pdf$/)
  await writeFile(savePath, 'PDFDATA')
  item.emit('done', {}, 'completed')

  const capture = await waiting
  assert.equal(capture.suggestedFilename, 'report.pdf')
  assert.equal(capture.artifact.kind, 'download')
  assert.equal(capture.artifact.mediaType, 'application/pdf')
  assert.equal(await readFile(capture.artifact.artifactPath, 'utf8'), 'PDFDATA')
})

test('download capture broker ignores other tabs and supports cancellation before a download starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-download-cancel-'))
  const controller = new AbortController()
  const broker = new BrowserDownloadCaptureBroker()
  const webContents = {} as WebContents
  const { capture: waiting } = await broker.prepareDownload(
    webContents,
    '/target',
    new CdpArtifactStore(root),
    5_000,
    controller.signal
  )
  const item = { getURL: () => 'https://example.com/target' } as DownloadItem
  assert.equal(broker.handleWillDownload(item, {} as WebContents), false)
  controller.abort()
  await assert.rejects(waiting, /cancelled/)
  await rm(root, { recursive: true, force: true })
})
