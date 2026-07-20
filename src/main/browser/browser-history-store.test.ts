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
    assert.equal(entries[0].favicon, null)
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
    store.recordVisit('https://example.com/', 'Example', 5000, 'https://example.com/favicon.ico')
    store.recordVisit('https://example.com/', 'Example Domain', 6000)
    await store.flush()

    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    raw.entries.push({ url: 'javascript:alert(1)', title: 'bad' }, { title: 'no url' }, null)
    await writeFile(filePath, JSON.stringify(raw), 'utf8')

    const reloaded = new BrowserHistoryStore(() => filePath)
    await reloaded.load()

    assert.deepEqual(reloaded.entries(), [
      {
        url: 'https://example.com/',
        title: 'Example Domain',
        favicon: 'https://example.com/favicon.ico',
        visitCount: 2,
        lastVisitAt: 6000
      }
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('backfills only trusted, bounded favicons', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexdesktop-history-'))
  try {
    const store = new BrowserHistoryStore(() => join(directory, 'history.json'))
    await store.load()
    store.recordVisit('https://example.com/', 'Example', 5000)

    store.updateFavicon('https://example.com/', 'https://cdn.example.com/favicon.png')
    assert.equal(store.entries()[0].favicon, 'https://cdn.example.com/favicon.png')

    store.updateFavicon('https://example.com/', 'javascript:alert(1)')
    store.updateFavicon('https://example.com/', `data:image/png;base64,${'a'.repeat(128 * 1024)}`)
    assert.equal(store.entries()[0].favicon, 'https://cdn.example.com/favicon.png')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('shares a restored tab favicon across same-site history and future visits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexdesktop-history-'))
  try {
    const store = new BrowserHistoryStore(() => join(directory, 'history.json'))
    await store.load()
    store.recordVisit('https://example.com/first', 'First', 1000)
    store.recordVisit('https://www.example.com/second', 'Second', 2000)
    store.recordVisit('https://docs.example.com/', 'Docs', 3000)

    const favicon = 'https://example.com/assets/favicon.png'
    store.updateFavicon('https://www.example.com/current', favicon)
    store.recordVisit('https://example.com/future', 'Future', 4000)

    const byUrl = new Map(store.entries().map((entry) => [entry.url, entry]))
    assert.equal(byUrl.get('https://example.com/first')?.favicon, favicon)
    assert.equal(byUrl.get('https://www.example.com/second')?.favicon, favicon)
    assert.equal(byUrl.get('https://example.com/future')?.favicon, favicon)
    assert.equal(byUrl.get('https://docs.example.com/')?.favicon, null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('removes one exact history url durably without deleting sibling pages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexdesktop-history-'))
  try {
    const filePath = join(directory, 'history.json')
    const store = new BrowserHistoryStore(() => filePath)
    await store.load()
    store.recordVisit('https://example.com/first', 'First', 1000)
    store.recordVisit('https://example.com/second', 'Second', 2000)

    assert.equal(store.remove('https://example.com/first'), true)
    assert.equal(store.remove('https://example.com/first'), false)
    assert.equal(store.remove('javascript:alert(1)'), false)
    await store.flush()

    const reloaded = new BrowserHistoryStore(() => filePath)
    await reloaded.load()
    assert.deepEqual(reloaded.entries().map((entry) => entry.url), ['https://example.com/second'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('flush reports a failed write and leaves the save queue reusable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexdesktop-history-'))
  try {
    let filePath = directory
    const store = new BrowserHistoryStore(() => filePath)
    await store.load()
    store.recordVisit('https://example.com/', 'Example', 5000)

    await assert.rejects(store.flush())

    filePath = join(directory, 'history.json')
    await store.flush()
    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    assert.equal(persisted.entries[0].url, 'https://example.com/')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('isRecordableUrl accepts only http(s)', () => {
  assert.equal(isRecordableUrl('https://a.com'), true)
  assert.equal(isRecordableUrl('http://a.com'), true)
  assert.equal(isRecordableUrl('about:blank'), false)
  assert.equal(isRecordableUrl('chrome://settings'), false)
  assert.equal(isRecordableUrl(''), false)
})
