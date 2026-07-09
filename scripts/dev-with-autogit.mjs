#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const binExt = process.platform === 'win32' ? '.cmd' : ''
const electronViteBin = join(repoRoot, 'node_modules', '.bin', `electron-vite${binExt}`)

let shuttingDown = false

const autogit = spawn(process.execPath, [join(scriptDir, 'git-autosnapshot.mjs'), '--watch'], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit'
})

const app = spawn(electronViteBin, ['dev'], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit'
})

autogit.on('exit', (code, signal) => {
  if (shuttingDown || code === 0) {
    return
  }

  process.stderr.write(`[dev] autosnapshot watcher exited (${code ?? signal ?? 'unknown'}); stopping dev server\n`)
  shutdown(code ?? 1)
})

app.on('exit', (code, signal) => {
  if (shuttingDown) {
    return
  }

  shutdown(code ?? signalToCode(signal) ?? 0)
})

app.on('error', (error) => {
  process.stderr.write(`[dev] failed to start electron-vite: ${error.message}\n`)
  shutdown(1)
})

autogit.on('error', (error) => {
  process.stderr.write(`[dev] failed to start autosnapshot watcher: ${error.message}\n`)
  shutdown(1)
})

process.once('SIGINT', () => shutdown(130))
process.once('SIGTERM', () => shutdown(143))

function shutdown(exitCode) {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  killChild(app)
  killChild(autogit)
  process.exitCode = typeof exitCode === 'number' ? exitCode : 1
}

function killChild(child) {
  if (!child.killed && child.exitCode === null) {
    child.kill('SIGTERM')
  }
}

function signalToCode(signal) {
  if (signal === 'SIGINT') {
    return 130
  }

  if (signal === 'SIGTERM') {
    return 143
  }

  return null
}
