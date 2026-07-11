import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { CodexConnectionStatus } from '../../shared/ipc.js'
import type { JsonRpcMessage } from './app-server-rpc.js'

type AppServerProcessOptions = {
  onLine: (line: string) => void
  onStopped: (error: Error) => void
  onStatus: (status: CodexConnectionStatus, message?: string) => void
  spawnProcess?: () => ChildProcessWithoutNullStreams
}

function spawnAppServer(): ChildProcessWithoutNullStreams {
  return spawn('codex', ['app-server', '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  })
}

export class AppServerProcess {
  private readonly onLine: AppServerProcessOptions['onLine']
  private readonly onStopped: AppServerProcessOptions['onStopped']
  private readonly onStatus: AppServerProcessOptions['onStatus']
  private readonly spawnProcess: NonNullable<AppServerProcessOptions['spawnProcess']>
  private child: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null

  constructor(options: AppServerProcessOptions) {
    this.onLine = options.onLine
    this.onStopped = options.onStopped
    this.onStatus = options.onStatus
    this.spawnProcess = options.spawnProcess ?? spawnAppServer
  }

  async ensureStarted(initialize: () => Promise<void>): Promise<void> {
    if (this.startPromise) return this.startPromise

    if (this.child && !this.child.killed) {
      this.onStatus('ready')
      return
    }

    this.startPromise = this.start(initialize)
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  write(message: JsonRpcMessage): void {
    if (!this.child) throw new Error('codex app-server is not running')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  dispose(): void {
    this.onStopped(new Error('Codex app-server stopped'))
    const child = this.child
    this.child = null
    child?.kill()
  }

  private async start(initialize: () => Promise<void>): Promise<void> {
    this.onStatus('starting')
    const child = this.spawnProcess()
    this.child = child

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim()
      if (message) console.warn(`codex app-server: ${message}`)
    })

    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      const message = `codex app-server exited (${code ?? signal ?? 'unknown'})`
      this.onStatus('exited', message)
      this.onStopped(new Error(message))
    })

    child.on('error', (error) => {
      if (this.child !== child) return
      this.child = null
      this.onStatus('error', error.message)
      this.onStopped(error)
    })

    const lines = createInterface({ input: child.stdout })
    lines.on('line', this.onLine)

    try {
      await initialize()
      this.onStatus('ready')
    } catch (error) {
      if (this.child === child) {
        this.child = null
        child.kill()
      }
      throw error
    }
  }
}
