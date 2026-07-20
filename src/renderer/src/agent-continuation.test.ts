import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentContinuation } from './agent-continuation.ts'

const prompt = [
  '[Automatic background-agent continuation]',
  '1 background agent finished after the previous turn became idle.',
  '1. Explore [claude/completed]: Found the model list in codex-client.ts.',
  'Continue the original task now. Use these results, verify anything still missing, and answer the user without asking them to wake you again.'
].join('\n')

test('the continuation injection parses into a headline and report without the internal directive', () => {
  const note = parseAgentContinuation(prompt)
  assert.ok(note)
  assert.equal(note.headline, '1 background agent finished after the previous turn became idle.')
  assert.equal(note.report, '1. Explore [claude/completed]: Found the model list in codex-client.ts.')
})

test('multi-agent reports keep every report line', () => {
  const note = parseAgentContinuation([
    '[Automatic background-agent continuation]',
    '2 background agents finished after the previous turn became idle.',
    '1. Explore [claude/completed]: First report.',
    'with a second line.',
    '2. Fixer [codex/failed]: No summary was provided.',
    'Continue the original task now. Use these results, verify anything still missing, and answer the user without asking them to wake you again.'
  ].join('\n'))
  assert.ok(note)
  assert.match(note.report, /First report\.\nwith a second line\./)
  assert.match(note.report, /2\. Fixer \[codex\/failed\]/)
})

test('ordinary user text that merely mentions background agents is untouched', () => {
  assert.equal(parseAgentContinuation('tell me when the background agent finishes'), null)
  assert.equal(parseAgentContinuation(''), null)
})
