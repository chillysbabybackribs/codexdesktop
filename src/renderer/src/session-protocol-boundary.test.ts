import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Claude-prep step 3 ratchet: the renderer imports conversation/model types
// only from src/shared/session-protocol, never from the generated Codex
// protocol directly. This is what lets a future provider adapter change the
// wire types without touching a single renderer file.

const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path
  }
}

test('renderer never imports codex-protocol directly', () => {
  const offenders: string[] = []
  for (const file of sourceFiles(rendererRoot)) {
    if (file.endsWith('session-protocol-boundary.test.ts')) continue
    if (readFileSync(file, 'utf8').includes('codex-protocol')) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `import these types via shared/session-protocol instead: ${offenders.join(', ')}`)
})
