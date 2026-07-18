import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import {
  buildPageSnapshotProgram,
  expandPageSnapshotObjectiveTerms,
  type PageSnapshotOptions,
  type PageSnapshotResult
} from './page-snapshot.ts'

function executeSnapshot(
  html: string,
  options: PageSnapshotOptions,
  prepare?: (document: Document) => void
): PageSnapshotResult {
  const parsed = parseHTML(html)
  prepare?.(parsed.document)
  const program = buildPageSnapshotProgram(options)
  const execute = new Function('document', 'location', 'Node', program) as (
    document: Document,
    location: { href: string },
    node: typeof Node
  ) => PageSnapshotResult
  return execute(parsed.document, { href: 'https://www.reddit.com/notifications' }, parsed.Node)
}

test('objective expansion groups notification and state synonyms', () => {
  assert.deepEqual(
    expandPageSnapshotObjectiveTerms('Tell me the latest alerts that are viewed or unseen'),
    [
      {
        term: 'notification',
        alternatives: ['notification', 'notifications', 'alert', 'alerts', 'activity', 'activities', 'inbox', 'update', 'updates']
      },
      { term: 'read', alternatives: ['read', 'seen', 'viewed', 'opened'] },
      { term: 'unread', alternatives: ['unread', 'unseen', 'unviewed', 'new'] }
    ]
  )
})

test('task snapshot ranks Reddit-like notification rows but returns them in document order', () => {
  const result = executeSnapshot(`<!doctype html><html lang="en"><head><title>Notifications</title></head><body>
    <main>
      <h1>Notifications</h1>
      <div class="notification-row unread" data-read="false" aria-selected="true">
        <a href="/r/codex/comments/1">Alice replied to your browser audit</a>
        <time datetime="2026-07-18T10:01:00Z">one minute ago</time>
      </div>
      <div class="notification-row read" data-read="true">
        <a href="/r/codex/comments/2">Bob mentioned you in a performance thread</a>
        <time datetime="2026-07-18T09:55:00Z">seven minutes ago</time>
      </div>
      <div class="notification-row unread" data-read="false">
        <a href="/message/3">Carol sent a new message</a>
      </div>
    </main>
  </body></html>`, {
    mode: 'task',
    objective: 'tell me the last notifications and whether each is read or unread',
    maxItems: 2,
    maxChars: 4_000
  })

  assert.equal(result.items.length, 2)
  assert.deepEqual(result.items.map(({ order }) => order), [...result.items.map(({ order }) => order)].sort((a, b) => a - b))
  assert.match(result.items[0]?.text ?? '', /Alice replied/)
  assert.equal(result.items[0]?.state.read, false)
  assert.equal(result.items[0]?.state.selected, true)
  assert.match(result.items[0]?.state.evidence?.join(' ') ?? '', /data-read:false/)
  assert.equal(result.items[0]?.datetime, '2026-07-18T10:01:00Z')
  assert.equal(result.items[0]?.href, 'https://www.reddit.com/r/codex/comments/1')
  assert.match(result.items[1]?.text ?? '', /Bob mentioned/)
  assert.equal(result.items[1]?.state.read, true)
  assert.equal(result.items[1]?.datetime, '2026-07-18T09:55:00Z')
  assert.equal(result.items[0]?.nearbyHeading, 'Notifications')
  assert.equal(result.coverage.complete, true)
  assert.deepEqual(result.coverage.gaps, [])
  assert.equal(JSON.stringify(result).length <= 4_000, true)
})

test('content mode preserves primary article text nested inside a fixed-sidebar wrapper', () => {
  const result = executeSnapshot(`<!doctype html><html><head><title>Report</title></head><body>
    <div class="fixed-sidebar">
      Fixed sidebar navigation should not leak into the article.
      <aside>Sponsored sidebar recommendations and newsletter signup.</aside>
      <main>
        <article>
          <h1>Browser extraction report</h1>
          <p>The primary article explains the measured traversal improvement and preserves its evidence.</p>
        </article>
      </main>
    </div>
    <div class="sidebar">Unrelated promotional sidebar content.</div>
  </body></html>`, {
    mode: 'content',
    maxItems: 10,
    maxChars: 3_000
  })

  assert.match(result.content, /Browser extraction report/)
  assert.match(result.content, /primary article explains the measured traversal improvement/)
  assert.doesNotMatch(result.content, /Sponsored sidebar|newsletter signup|Unrelated promotional|Fixed sidebar navigation/)
  assert.equal(result.passages.some(({ text }) => /primary article/.test(text)), true)
})

test('composed traversal reaches task content in an open shadow root', () => {
  const result = executeSnapshot(
    '<!doctype html><html><head><title>Shadow inbox</title></head><body><main><h1>Activity</h1><notification-list></notification-list></main></body></html>',
    {
      mode: 'task',
      objective: 'find unread notifications',
      maxItems: 5,
      maxChars: 2_500
    },
    (document) => {
      const host = document.querySelector('notification-list')
      assert.ok(host)
      const shadow = host.attachShadow({ mode: 'open' })
      shadow.innerHTML = '<div class="notification-row unread" data-read="false"><a href="/shadow/1">Shadow notification is unread</a></div>'
    }
  )

  assert.equal(result.items.length, 1)
  assert.match(result.items[0]?.text ?? '', /Shadow notification is unread/)
  assert.equal(result.items[0]?.state.read, false)
  assert.equal(result.items[0]?.href, 'https://www.reddit.com/shadow/1')
  assert.equal(result.coverage.complete, true)
})

test('large DOM traversal and returned JSON remain bounded while retaining a late relevant item', () => {
  const ordinaryRows = Array.from(
    { length: 6_000 },
    (_, index) => `<div class="result-row">Ordinary result ${index} with unrelated text</div>`
  ).join('')
  const program = buildPageSnapshotProgram({
    mode: 'task',
    objective: 'special unread notification',
    maxItems: 3,
    maxChars: 1_800
  })
  assert.doesNotMatch(program, /cloneNode|outerHTML/)

  const result = executeSnapshot(`<!doctype html><html><head><title>Large results</title></head><body><main>
    ${ordinaryRows}
    <div class="notification-row unread" data-read="false">Special notification remains unread</div>
  </main></body></html>`, {
    mode: 'task',
    objective: 'special unread notification',
    maxItems: 3,
    maxChars: 1_800
  })

  assert.equal(result.items.length, 1)
  assert.match(result.items[0]?.text ?? '', /Special notification remains unread/)
  assert.equal(result.items[0]?.state.read, false)
  assert.equal(result.coverage.visitedNodes <= 50_000, true)
  assert.equal(JSON.stringify(result).length <= 1_800, true)
  assert.equal(result.truncated, true)
})
