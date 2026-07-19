import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanCommand, narrateCommand } from './command-narrate.ts'
import type { CommandAction } from '../../shared/session-protocol'

test('strips bash -lc wrappers for display', () => {
  assert.equal(cleanCommand(`/bin/bash -lc "git status --short"`), 'git status --short')
  assert.equal(cleanCommand(`bash -lc 'ls -la'`), 'ls -la')
  assert.equal(cleanCommand('git status'), 'git status')
})

test('narrates a wrapped git status + log chain', () => {
  const narration = narrateCommand(`/bin/bash -lc 'git status --short && git log -3 --oneline --decorate'`)
  assert.equal(narration.natural, true)
  assert.equal(narration.running, 'Checking git status, viewing recent commits')
  assert.equal(narration.done, 'Checked git status, viewed recent commits')
})

test('narrates a ripgrep sweep with fallback diff (the screenshot case)', () => {
  const narration = narrateCommand(
    `/bin/bash -lc "rg -n \\"\\\\battached\\\\b|throwIfAborted|\\\\bjoin\\\\b\\" src/main/browser/cdp-session.ts src/main/browser/browser-agent.ts src/main/browser/browser-state-store.ts || true && git diff --stat"`
  )
  assert.equal(narration.natural, true)
  assert.equal(narration.done, 'Searched for “attached|throwIfAborted|join” in 3 files, viewed the diff')
})

test('collapses >2 steps into a count', () => {
  const narration = narrateCommand('git status && git log -3 && git branch --show-current && git rev-parse HEAD')
  assert.equal(narration.done, 'Checked git status and 3 more')
})

test('classifies package-manager and build tooling', () => {
  assert.equal(narrateCommand('npm install').done, 'Installed dependencies')
  assert.equal(narrateCommand('npm run typecheck').running, 'Type-checking the code')
  assert.equal(narrateCommand('npx tsc --noEmit -p tsconfig.web.json').done, 'Type-checked the code')
  assert.equal(narrateCommand('npm run build').done, 'Built the app')
  assert.equal(narrateCommand('node scripts/verify-instance.mjs').done, 'Ran verify-instance.mjs')
})

test('ignores plumbing segments and pipe tails', () => {
  assert.equal(narrateCommand('cd /repo && rg -n foo src | head -5').done, 'Searched for “foo” in src')
  assert.equal(narrateCommand('cat notes.md | head -20').done, 'Read notes.md')
})

test('prefers Codex server-parsed actions over heuristics', () => {
  const actions: CommandAction[] = [
    { type: 'read', command: 'cat a.ts', name: 'a.ts', path: '/repo/src/a.ts' },
    { type: 'search', command: 'rg foo', query: 'foo', path: '/repo/src' }
  ]
  const narration = narrateCommand('whatever', actions)
  assert.equal(narration.done, 'Read a.ts, searched for “foo” in src')
})

test('narrates unknown actions nested inside parsed actions', () => {
  const actions: CommandAction[] = [{ type: 'unknown', command: 'git status --short' }]
  assert.equal(narrateCommand('git status --short', actions).done, 'Checked git status')
})

test('conjugates Claude-written Bash descriptions', () => {
  const narration = narrateCommand('npm ci', null, 'Install package dependencies')
  assert.equal(narration.natural, true)
  assert.equal(narration.running, 'Installing package dependencies')
  assert.equal(narration.done, 'Installed package dependencies')
})

test('keeps unrecognized descriptions verbatim', () => {
  const narration = narrateCommand('foo', null, 'Snapshot the working tree')
  assert.equal(narration.running, 'Snapshot the working tree')
  assert.equal(narration.done, 'Snapshot the working tree')
})

test('falls back to the cleaned command when nothing classifies', () => {
  const narration = narrateCommand(`/bin/bash -lc "frobnicate --all"`)
  assert.equal(narration.natural, false)
  assert.equal(narration.done, 'frobnicate --all')
})

test('never narrates dangerous-looking segments as silently dropped', () => {
  // Unknown segments still count toward the "more" tally so the summary
  // never claims the command did less than it did.
  const narration = narrateCommand('rg foo src && ./deploy-prod --yes')
  assert.equal(narration.done, 'Searched for “foo” in src and 1 more')
})
