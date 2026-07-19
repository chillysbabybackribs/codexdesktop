import assert from 'node:assert/strict'
import test from 'node:test'
import { exchangeHasTurn, groupDockExchanges } from './dock-exchanges.ts'
import { buildAuditPrompt } from './audit-trigger.ts'
import type { RenderRow } from './transcript-model.ts'

const userRow = (id: string, text: string, turnId: string | null = null): RenderRow =>
  ({
    kind: 'chat',
    turnId,
    item: { type: 'userMessage', id, clientId: null, content: [{ type: 'text', text, text_elements: [] }] }
  }) as unknown as RenderRow

const agentRow = (id: string, text: string, turnId: string | null = null): RenderRow =>
  ({
    kind: 'chat',
    turnId,
    item: { type: 'agentMessage', id, text, phase: null, memoryCitation: null }
  }) as unknown as RenderRow

const activityRow = (id: string, turnId: string | null = null): RenderRow =>
  ({ kind: 'activity', id, turnId, items: [] }) as unknown as RenderRow

test('groups rows into exchanges split at user messages', () => {
  const rows = [
    userRow('u1', 'first question', 't1'),
    activityRow('a1', 't1'),
    agentRow('m1', 'first answer', 't1'),
    userRow('u2', 'second question', 't2'),
    agentRow('m2', 'second answer', 't2')
  ]
  const exchanges = groupDockExchanges(rows)
  assert.equal(exchanges.length, 2)
  assert.equal(exchanges[0].id, 'u1')
  assert.equal(exchanges[0].rows.length, 3)
  assert.equal(exchanges[0].headline, 'first question')
  assert.equal(exchanges[1].id, 'u2')
  assert.equal(exchanges[1].rows.length, 2)
})

test('leading rows before any user message form their own exchange', () => {
  const rows = [
    agentRow('m0', 'restored greeting'),
    userRow('u1', 'question'),
    agentRow('m1', 'answer')
  ]
  const exchanges = groupDockExchanges(rows)
  assert.equal(exchanges.length, 2)
  assert.equal(exchanges[0].id, 'm0')
  assert.equal(exchanges[0].headline, 'earlier exchange')
})

test('audit exchanges parse the briefing and carry the final verdict', () => {
  const prompt = buildAuditPrompt({
    userText: 'fix the login bug',
    files: ['src/auth.ts', 'src/session.ts'],
    steps: ['$ npm test (exit 0)']
  })
  const rows = [
    userRow('u1', prompt, 't1'),
    agentRow('m1', 'let me look at the diff…', 't1'),
    agentRow('m2', 'Looks risky in one spot.\nVERDICT: flag', 't1')
  ]
  const [exchange] = groupDockExchanges(rows)
  assert.ok(exchange.audit)
  assert.equal(exchange.verdict, 'flag')
  assert.equal(exchange.headline, 'audited auth.ts, session.ts')
})

test('chat-only audit headlines fall back to the reviewed request', () => {
  const prompt = buildAuditPrompt({ userText: 'brainstorm dock ideas with me', files: [] })
  const rows = [userRow('u1', prompt, 't1'), agentRow('m1', 'Sharp angle: …\nVERDICT: pass', 't1')]
  const [exchange] = groupDockExchanges(rows)
  assert.ok(exchange.audit)
  assert.equal(exchange.verdict, 'pass')
  assert.equal(exchange.headline, 'reviewed: brainstorm dock ideas with me')
})

test('interim narration without a verdict does not erase the final one', () => {
  const rows = [
    userRow('u1', 'question', 't1'),
    agentRow('m1', 'Done.\nVERDICT: pass', 't1'),
    agentRow('m2', 'trailing note without verdict', 't1')
  ]
  const [exchange] = groupDockExchanges(rows)
  assert.equal(exchange.verdict, 'pass')
})

test('long manual headlines clip and squash whitespace', () => {
  const text = `this   is a\nvery long question ${'x'.repeat(80)}`
  const [exchange] = groupDockExchanges([userRow('u1', text)])
  assert.ok(exchange.headline.length <= 65)
  assert.ok(exchange.headline.endsWith('…'))
  assert.ok(exchange.headline.startsWith('this is a very long question'))
})

test('exchangeHasTurn matches any row of the exchange', () => {
  const rows = [userRow('u1', 'question', 't1'), activityRow('a1', 't2')]
  const [exchange] = groupDockExchanges(rows)
  assert.equal(exchangeHasTurn(exchange, 't2'), true)
  assert.equal(exchangeHasTurn(exchange, 't3'), false)
  assert.equal(exchangeHasTurn(exchange, null), false)
})
