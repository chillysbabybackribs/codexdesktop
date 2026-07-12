import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const script = join(dirname(fileURLToPath(import.meta.url)), 'select-examples.mjs')

test('selects the photographic coffee references and a contrastive baseline', () => {
  const result = spawnSync(process.execPath, [script, 'premium editorial coffee shop with warm photography'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.selected.map((entry) => entry.id), [
    'coffee-editorial-light',
    'coffee-editorial-dark',
    'coffee-css-illustration-baseline'
  ])
})

test('requires a retrieval query', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage:/)
})
