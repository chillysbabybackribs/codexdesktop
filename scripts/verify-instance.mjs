#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const sessionId = randomUUID()
const userData = join(tmpdir(), `codexdesktop-verify-${sessionId}`)
const electronBin = join(repoRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const env = {
  ...process.env,
  CODEX_DESKTOP_INSTANCE_ROLE: 'verification',
  CODEX_DESKTOP_HOST_SESSION_ID: sessionId,
  CODEX_DESKTOP_USER_DATA: userData
}

// A production build must never inherit the host development renderer URL.
delete env.ELECTRON_RENDERER_URL

const child = spawn(electronBin, [repoRoot], {
  cwd: repoRoot,
  env,
  stdio: 'inherit'
})

process.stdout.write(`[verify-instance] session=${sessionId} pid=${child.pid ?? 'pending'} userData=${userData}\n`)

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true
    if (child.exitCode === null && !child.killed) child.kill(signal)
  })
}

child.on('error', (error) => {
  process.stderr.write(`[verify-instance] failed to launch: ${error.message}\n`)
  process.exitCode = 1
})

child.on('exit', async (code, signal) => {
  await rm(userData, { recursive: true, force: true })
  process.stdout.write(`[verify-instance] closed (${code ?? signal ?? 'unknown'}); removed ${userData}\n`)
  process.exitCode = stopping ? 0 : (code ?? 1)
})
