import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BrowserHistoryStore, isRecordableUrl } from './browser-history-store.ts'

test('records visits, increments counts, and backfills titles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexdesktop-history-'))
  try {
    const store = new BrowserHistoryStore(() => join(directory, 'history.json'))
    await store.load()

    store.recordVisit('https://example.com/', '', 1000)
    store.recordVisit('https://example.com/', 'Example', 2000)
    store.updateTitle('https://example.com/', 'Example Domain')

    const entries = store.entries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].visitCount, 2)
    assert.equal(entries[0].lastVisitAt, 2000)
    assert.equal(entries[0].title, 'Example Domain')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('ignores non-http(s) urls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexdesktop-history-'))
  try {
    const store = new BrowserHistoryStore(() => join(directory, 'history.json'))
    await store.load()

    store.recordVisit('about:blank', 'blank')
    store.recordVisit('file:///etc/passwd', 'passwd')
    store.recordVisit('javascript:alert(1)', 'xss')
    store.recordVisit('data:text/html,<b>x</b>', 'data')

    assert.equal(store.entries().length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('persists to disk and reloads, dropping malformed entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexdesktop-history-'))
  try {
    const filePath = join(directory, 'history.json')
    const store = new BrowserHistoryStore(() => filePath)
    await store.load()
    store.recordVisit('https://example.com/', 'Example', 5000)
    await store.flush()

    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    raw.entries.push({ url: 'javascript:alert(1)', title: 'bad' }, { title: 'no url' }, null)
    await writeFile(filePath, JSON.stringify(raw), 'utf8')

    const reloaded = new BrowserHistoryStore(() => filePath)
    await reloaded.load()

    assert.deepEqual(reloaded.entries(), [
      { url: 'https://example.com/', title: 'Example', visitCount: 1, lastVisitAt: 5000 }
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('flushSync persists pending visits before shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-history-sync-'))
  const filePath = join(directory, 'history.json')
  const store = new BrowserHistoryStore(() => filePath)
  await store.load()

  store.recordVisit('https://reddit.com/', 'Reddit', 123)
  store.flushSync()

  const restored = new BrowserHistoryStore(() => filePath)
  await restored.load()
  assert.deepEqual(restored.entries(), [{
    url: 'https://reddit.com/',
    title: 'Reddit',
    visitCount: 1,
    lastVisitAt: 123
  }])
})

test('isRecordableUrl accepts only http(s)', () => {
  assert.equal(isRecordableUrl('https://a.com'), true)
  assert.equal(isRecordableUrl('http://a.com'), true)
  assert.equal(isRecordableUrl('about:blank'), false)
  assert.equal(isRecordableUrl('chrome://settings'), false)
  assert.equal(isRecordableUrl(''), false)
})
