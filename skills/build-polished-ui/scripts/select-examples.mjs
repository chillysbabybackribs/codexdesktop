#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const manifestPath = join(here, '..', 'examples', 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const query = process.argv.slice(2).join(' ').trim().toLowerCase()

if (!query) {
  console.error('usage: node select-examples.mjs <product and desired visual direction>')
  process.exitCode = 2
} else {
  const tokens = new Set(query.split(/[^a-z0-9]+/).filter((token) => token.length > 2))
  const scored = manifest.examples.map((example) => {
    const fields = [
      ...example.productTypes,
      ...example.aestheticTags,
      ...example.compositionTags,
      ...example.mediaTags
    ].map((value) => value.toLowerCase())
    const score = fields.reduce((total, field) => {
      const fieldTokens = field.split(/[^a-z0-9]+/).filter(Boolean)
      return total + fieldTokens.filter((token) => tokens.has(token)).length
    }, 0)
    return { example, score }
  })

  const rank = (quality, limit) => scored
    .filter(({ example }) => example.quality === quality)
    .sort((a, b) => b.score - a.score || a.example.id.localeCompare(b.example.id))
    .slice(0, limit)
    .map(({ example, score }) => ({
      id: example.id,
      quality: example.quality,
      score,
      reference: join(dirname(manifestPath), example.reference),
      brief: join(dirname(manifestPath), example.brief),
      critique: join(dirname(manifestPath), example.critique)
    }))

  process.stdout.write(`${JSON.stringify({
    query,
    selected: [
      ...rank('good', manifest.selectionPolicy.maxGood),
      ...rank('needs-improvement', manifest.selectionPolicy.maxCounterexamples)
    ]
  }, null, 2)}\n`)
}
