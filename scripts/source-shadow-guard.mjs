#!/usr/bin/env node
import { readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv.includes('--fix') ? 'fix' : 'check'
const scanRoots = ['src/main', 'src/preload', 'src/shared'].map((path) => join(repoRoot, path))
const protocolRoot = join(repoRoot, 'src/shared/codex-protocol')

const candidates = []
for (const root of scanRoots) await walk(root, candidates)

const shadows = []
for (const path of candidates) {
  if (path === protocolRoot || path.startsWith(`${protocolRoot}/`)) continue
  const sourcePath = sourceForGeneratedPath(path)
  if (sourcePath && await exists(sourcePath)) shadows.push(path)
}

if (shadows.length === 0) {
  process.stdout.write('[source-shadows] clean\n')
  process.exit(0)
}

if (mode === 'fix') {
  await Promise.all(shadows.map((path) => unlink(path)))
  process.stdout.write(`[source-shadows] removed ${shadows.length} generated source shadow(s)\n`)
  for (const path of shadows) process.stdout.write(`- ${relative(repoRoot, path)}\n`)
  process.exit(0)
}

process.stderr.write('[source-shadows] generated files are shadowing TypeScript sources:\n')
for (const path of shadows) process.stderr.write(`- ${relative(repoRoot, path)}\n`)
process.stderr.write('Run npm run clean:source-shadows before building or starting the app.\n')
process.exit(1)

async function walk(path, files) {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await walk(child, files)
    else if (/\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(entry.name)) files.push(child)
  }
}

function sourceForGeneratedPath(path) {
  if (path.endsWith('.d.ts.map')) return path.slice(0, -9) + '.ts'
  if (path.endsWith('.js.map')) return path.slice(0, -7) + '.ts'
  if (path.endsWith('.d.ts')) return path.slice(0, -5) + '.ts'
  if (path.endsWith('.js')) return path.slice(0, -3) + '.ts'
  return null
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
