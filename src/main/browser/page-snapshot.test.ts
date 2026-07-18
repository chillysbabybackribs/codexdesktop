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

test('task snapshot treats selected custom inbox rows as auditable unread state', () => {
  const result = executeSnapshot(`<!doctype html><html><head><title>Inbox</title></head><body>
    <main><h1>Notifications</h1>
      <notification-item><rpl-inbox-row selected role="none"><a href="/new"><span>Newest reply</span><time datetime="2026-07-18T10:00:00Z">now</time></a></rpl-inbox-row></notification-item>
      <notification-item><rpl-inbox-row role="none"><a href="/old"><span>Earlier reply</span><time datetime="2026-07-17T10:00:00Z">yesterday</time></a></rpl-inbox-row></notification-item>
    </main>
  </body></html>`, {
    mode: 'task',
    objective: 'tell me the notifications and whether each is read or unread',
    maxItems: 2,
    maxChars: 4_000
  }, (document) => {
    for (const row of document.querySelectorAll('rpl-inbox-row')) {
      Object.defineProperty(row, 'selected', {
        configurable: true,
        value: row.hasAttribute('selected')
      })
    }
  })

  assert.equal(result.items.length, 2)
  assert.deepEqual(result.items.map(({ state }) => state.read), [false, true])
  assert.match(result.items[0]?.state.evidence?.join(' ') ?? '', /selected-unread/)
  assert.match(result.items[1]?.state.evidence?.join(' ') ?? '', /unselected-read/)
  assert.deepEqual(result.items.map(({ datetime }) => datetime), [
    '2026-07-18T10:00:00Z',
    '2026-07-17T10:00:00Z'
  ])
  assert.equal(result.coverage.complete, true)
})

test('task snapshot infers a requested count, stays compact, and preserves source order', () => {
  const rows = Array.from({ length: 5 }, (_, index) =>
    `<notification-item><rpl-inbox-row ${index === 0 ? 'selected' : ''} role="none"><a href="/${index}">Notification ${index + 1}</a></rpl-inbox-row></notification-item>`
  ).join('')
  const result = executeSnapshot(`<!doctype html><html><head><title>Inbox</title></head><body><main>${rows}</main></body></html>`, {
    mode: 'task',
    objective: 'latest 3 Reddit notifications and whether each is read or unread',
    maxChars: 4_000
  }, (document) => {
    for (const row of document.querySelectorAll('rpl-inbox-row')) {
      Object.defineProperty(row, 'selected', { value: row.hasAttribute('selected') })
    }
  })

  assert.deepEqual(result.items.map(({ text }) => text), ['Notification 1', 'Notification 2', 'Notification 3'])
  assert.deepEqual(result.items.map(({ state }) => state.read), [false, true, true])
  assert.equal(result.content, '')
  assert.deepEqual(result.passages, [])
  assert.equal(result.items.every(({ name }) => name === null), true)
  assert.equal(result.truncated, false)
  assert.equal(result.coverage.omittedItems, 0)
})

test('reverse-document ordering selects records from the end when the planner requests it', () => {
  const rows = Array.from({ length: 100 }, (_, index) => `<div class="result-row">Result ${index + 1}</div>`).join('')
  const result = executeSnapshot(`<!doctype html><html><head><title>Results</title></head><body><main>${rows}</main></body></html>`, {
    mode: 'task',
    objective: '2 results',
    order: 'reverse-document',
    maxChars: 3_000
  })

  assert.deepEqual(result.items.map(({ text }) => text), ['Result 100', 'Result 99'])
})

test('task mode preserves explicitly scoped navigation and menu controls', () => {
  const result = executeSnapshot(`<!doctype html><html><head><title>Account</title></head><body>
    <nav id="account-menu"><a href="/profile">Profile</a><a href="/settings">Settings</a><a href="/billing">Billing</a></nav>
  </body></html>`, {
    mode: 'task',
    objective: 'show the 3 account menu links',
    selector: '#account-menu',
    maxChars: 3_000
  })

  assert.equal(result.scope.matched, true)
  assert.deepEqual(result.items.map(({ text }) => text), ['Profile', 'Settings', 'Billing'])
})

test('custom list containers do not collapse their repeated child rows', () => {
  const result = executeSnapshot(`<!doctype html><html><head><title>Inbox</title></head><body><main>
    <notification-list>
      <notification-row data-read="false">One</notification-row>
      <notification-row data-read="true">Two</notification-row>
      <notification-row data-read="true">Three</notification-row>
    </notification-list>
  </main></body></html>`, {
    mode: 'task',
    objective: '3 notifications and whether each is read or unread',
    maxChars: 3_000
  })

  assert.deepEqual(result.items.map(({ text }) => text), ['One', 'Two', 'Three'])
  assert.deepEqual(result.items.map(({ state }) => state.read), [false, true, true])
  assert.equal(result.coverage.complete, true)
})

test('coverage reports per-item state gaps and does not infer read state from generic selection', () => {
  const result = executeSnapshot(`<!doctype html><html><head><title>Inbox</title></head><body><main>
    <div class="notification-item" data-read="true">Known</div>
    <div class="notification-item" aria-selected="false">Unknown two</div>
    <div class="notification-item">Unknown three</div>
  </main></body></html>`, {
    mode: 'task',
    objective: '3 notifications and whether each is read or unread',
    maxChars: 3_000
  })

  assert.deepEqual(result.items.map(({ state }) => state.read), [true, undefined, undefined])
  assert.equal(result.coverage.complete, false)
  assert.equal(result.coverage.gaps.includes('read-state-missing:2'), true)
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

test('content mode removes low-value descendants nested inside main', () => {
  const result = executeSnapshot(`<!doctype html><html><head><title>Report</title></head><body><main>
    <article><h1>Measured browser result</h1><p>The verified article evidence remains intact for extraction.</p></article>
    <aside>Sponsored related recommendations should be excluded.</aside>
    <nav>Pagination and newsletter controls should be excluded.</nav>
  </main></body></html>`, { mode: 'content', maxChars: 3_000 })

  assert.match(result.content, /verified article evidence remains intact/)
  assert.doesNotMatch(result.content, /Sponsored related|Pagination and newsletter/)
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

test('scoped snapshot selectors resolve inside open shadow roots', () => {
  const result = executeSnapshot(
    '<!doctype html><html><head><title>Shadow inbox</title></head><body><notification-list></notification-list></body></html>',
    { mode: 'task', objective: 'unread notification', selector: '.notification-row', maxItems: 1, maxChars: 2_000 },
    (document) => {
      const host = document.querySelector('notification-list')
      assert.ok(host)
      host.attachShadow({ mode: 'open' }).innerHTML = '<div class="notification-row" data-read="false">Scoped unread item</div>'
    }
  )

  assert.equal(result.scope.matched, true)
  assert.equal(result.items.length, 1)
  assert.match(result.items[0]?.text ?? '', /Scoped unread item/)
})

test('result-budget fallback invalidates coverage when all evidence must be removed', () => {
  const longPath = `/${'x'.repeat(2_000)}`
  const result = executeSnapshot(`<!doctype html><html><head><title>Inbox</title></head><body><main>
    <div class="notification-row unread" data-read="false"><a href="${longPath}">${'Long notification evidence '.repeat(40)}</a></div>
  </main></body></html>`, {
    mode: 'task',
    objective: 'notification read or unread',
    maxItems: 1,
    maxChars: 1_000
  })

  assert.deepEqual(result.items, [])
  assert.equal(result.coverage.complete, false)
  assert.equal(result.coverage.gaps.includes('result-budget'), true)
  assert.equal(result.coverage.omittedItems, 1)
  assert.equal(JSON.stringify(result).length <= 1_000, true)
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
  assert.equal(result.truncated, false)
})
