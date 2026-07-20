import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import { app, session, webContents, type WebContents } from 'electron'
import type { BrowserVpnStatus } from '../../shared/ipc.js'
import { browserPartition } from './browser-session.js'

/**
 * Built-in VPN for the embedded browser, implemented the way Brave ships its
 * private-window tunnel: a bundled Tor client exposing a loopback SOCKS5 port
 * that only the guest browser partition routes through. Free for every user,
 * no account, no third-party proxy operator reading traffic.
 *
 * Scope: guest tabs/popups on `persist:codex-browser` only. App UI, chat, and
 * agent traffic stay direct. Chromium sends hostnames to the SOCKS5 proxy for
 * remote resolution, so tab DNS does not leak while the tunnel is on. WebRTC
 * is restricted to proxied transports on the guest session, closing the
 * classic real-IP leak that survives an otherwise healthy proxy.
 */

const bootstrapTimeoutMs = 120_000
const offStatus: BrowserVpnStatus = { state: 'off', bootstrapProgress: 0, detail: null }

type VpnStateFile = { enabled?: boolean }

export class TorVpnManager {
  private current: BrowserVpnStatus = { ...offStatus }
  private child: ChildProcessWithoutNullStreams | null = null
  private startNonce = 0
  private changeListener: (() => void) | null = null
  private disposed = false
  private killOnExit: (() => void) | null = null

  constructor() {
    // New guest surfaces (tabs, popups) created while the tunnel is up must
    // inherit the WebRTC restriction before any page script runs in them.
    app.on('web-contents-created', (_event, contents) => {
      if (this.current.state === 'on' && this.ownsWebContents(contents)) {
        applyWebRtcPolicy(contents, true)
      }
    })
  }

  status(): BrowserVpnStatus {
    return { ...this.current }
  }

  onChange(listener: () => void): void {
    this.changeListener = listener
  }

  async toggle(): Promise<BrowserVpnStatus> {
    if (this.current.state === 'off' || this.current.state === 'error') {
      await this.start()
    } else {
      await this.stop()
    }
    return this.status()
  }

  /** Re-enable at launch when the user last left the VPN on. */
  async restoreFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.stateFilePath(), 'utf8')
      const parsed = JSON.parse(raw) as VpnStateFile
      if (parsed?.enabled === true) {
        await this.start({ persist: false })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Failed to read saved VPN state', error)
      }
    }
  }

  async start(options: { persist?: boolean } = {}): Promise<void> {
    if (this.disposed || this.current.state === 'starting' || this.current.state === 'on') {
      return
    }

    const nonce = ++this.startNonce
    this.setStatus({ state: 'starting', bootstrapProgress: 0, detail: 'Locating Tor' })
    if (options.persist !== false) {
      void this.persistEnabled(true)
    }

    let candidates: string[]
    try {
      candidates = await resolveTorBinaryCandidates()
    } catch (error) {
      this.failStart(nonce, String(error))
      return
    }

    let port: number
    const dataDirectory = join(app.getPath('userData'), 'tor')
    try {
      port = await freeLoopbackPort()
      await mkdir(dataDirectory, { recursive: true })
    } catch (error) {
      this.failStart(nonce, `Could not prepare the Tor tunnel: ${String(error)}`)
      return
    }

    let lastFailure = 'Tor binary not found'
    for (const binary of candidates) {
      if (nonce !== this.startNonce) return
      try {
        await this.runTorUntilBootstrapped(binary, port, dataDirectory, nonce)
        return
      } catch (error) {
        lastFailure = String((error as Error).message ?? error)
      }
    }

    this.failStart(
      nonce,
      `${lastFailure}. Run "npm run fetch:tor" to bundle Tor, or install a system tor.`
    )
  }

  async stop(): Promise<void> {
    this.startNonce += 1
    void this.persistEnabled(false)
    this.killChild()
    await this.clearProxy()
    this.setStatus({ ...offStatus })
  }

  /** Kill the tor child on shutdown. Safe to call repeatedly. */
  dispose(): void {
    this.disposed = true
    this.startNonce += 1
    this.killChild()
  }

  private runTorUntilBootstrapped(
    binary: string,
    port: number,
    dataDirectory: string,
    nonce: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '--SocksPort',
        `127.0.0.1:${port}`,
        '--DataDirectory',
        dataDirectory,
        '--ClientOnly',
        '1',
        '--Log',
        'notice stdout',
        // Tor polls this pid and exits when the app dies, so an app crash can
        // never strand a detached tor process. Same dashless form tor-launcher
        // (Tor Browser) passes on the command line.
        '__OwningControllerProcess',
        String(process.pid)
      ]

      // Bundled tor ships its shared libraries next to the executable.
      const spawnEnv = { ...process.env }
      let cwd: string | undefined
      if (isAbsolute(binary)) {
        const binaryDirectory = dirname(binary)
        cwd = binaryDirectory
        spawnEnv.LD_LIBRARY_PATH = prependPath(binaryDirectory, spawnEnv.LD_LIBRARY_PATH)
        spawnEnv.DYLD_LIBRARY_PATH = prependPath(binaryDirectory, spawnEnv.DYLD_LIBRARY_PATH)
      }

      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(binary, args, { env: spawnEnv, cwd, windowsHide: true })
      } catch (error) {
        reject(new Error(`Could not launch ${binary}: ${String(error)}`))
        return
      }

      this.child = child
      this.installExitKill(child)

      let settled = false
      let lastWarning: string | null = null
      const settle = (outcome: { ok: boolean; error?: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (outcome.ok) {
          resolve()
        } else {
          if (this.child === child) this.child = null
          try {
            child.kill()
          } catch {
            // Already gone.
          }
          reject(new Error(outcome.error ?? 'Tor exited unexpectedly'))
        }
      }
      const timer = setTimeout(
        () => settle({ ok: false, error: 'Tor bootstrap timed out' }),
        bootstrapTimeoutMs
      )

      const onLine = (line: string): void => {
        const warn = /\[(?:warn|err)\]\s*(.*)$/.exec(line)
        if (warn?.[1]) lastWarning = warn[1].slice(0, 300)

        const bootstrapped = /Bootstrapped (\d+)%[^:]*(?::\s*(.*))?$/.exec(line)
        if (!bootstrapped || nonce !== this.startNonce) return
        const progress = Math.min(100, Number(bootstrapped[1]) || 0)
        if (progress >= 100) {
          void this.applyProxy(port).then(
            () => {
              this.setStatus({ state: 'on', bootstrapProgress: 100, detail: null })
              settle({ ok: true })
            },
            (error) => settle({ ok: false, error: `Could not apply the proxy: ${String(error)}` })
          )
        } else {
          this.setStatus({
            state: 'starting',
            bootstrapProgress: progress,
            detail: (bootstrapped[2] ?? '').slice(0, 120) || 'Connecting'
          })
        }
      }

      let buffered = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffered += chunk
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines) onLine(line)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        lastWarning = chunk.trim().slice(0, 300) || lastWarning
      })

      child.on('error', (error) => {
        settle({ ok: false, error: `Could not launch ${binary}: ${error.message}` })
      })
      child.on('exit', (code) => {
        // Bootstrap-phase exit: reject so the next binary candidate is tried.
        settle({ ok: false, error: lastWarning ?? `Tor exited with code ${code ?? 'unknown'}` })
        // Post-bootstrap exit: the live tunnel died out from under the user.
        if (this.child === child) {
          this.child = null
          if (this.current.state === 'on' && nonce === this.startNonce) {
            void this.clearProxy()
            this.setStatus({
              state: 'error',
              bootstrapProgress: 0,
              detail: lastWarning ?? 'The Tor tunnel stopped unexpectedly'
            })
          }
        }
      })
    })
  }

  private failStart(nonce: number, detail: string): void {
    if (nonce !== this.startNonce) return
    this.setStatus({ state: 'error', bootstrapProgress: 0, detail: detail.slice(0, 300) })
  }

  private async applyProxy(port: number): Promise<void> {
    const browserSession = session.fromPartition(browserPartition)
    await browserSession.setProxy({
      proxyRules: `socks5://127.0.0.1:${port}`,
      proxyBypassRules: '<local>'
    })
    // Sockets opened before the toggle would keep speaking from the real IP.
    await browserSession.closeAllConnections()
    this.forEachGuestContents((contents) => applyWebRtcPolicy(contents, true))
  }

  private async clearProxy(): Promise<void> {
    try {
      const browserSession = session.fromPartition(browserPartition)
      await browserSession.setProxy({ mode: 'direct' })
      await browserSession.closeAllConnections()
    } catch (error) {
      console.warn('Failed to restore a direct connection after disabling the VPN', error)
    }
    this.forEachGuestContents((contents) => applyWebRtcPolicy(contents, false))
  }

  private forEachGuestContents(apply: (contents: WebContents) => void): void {
    for (const contents of webContents.getAllWebContents()) {
      if (this.ownsWebContents(contents)) apply(contents)
    }
  }

  private ownsWebContents(contents: WebContents): boolean {
    try {
      return !contents.isDestroyed() && contents.session === session.fromPartition(browserPartition)
    } catch {
      return false
    }
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    if (this.killOnExit) {
      process.off('exit', this.killOnExit)
      this.killOnExit = null
    }
    if (!child) return
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }

  /** Last-resort cleanup if the main process dies without before-quit. */
  private installExitKill(child: ChildProcessWithoutNullStreams): void {
    if (this.killOnExit) process.off('exit', this.killOnExit)
    this.killOnExit = (): void => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    process.once('exit', this.killOnExit)
  }

  private setStatus(next: BrowserVpnStatus): void {
    this.current = next
    this.changeListener?.()
  }

  private stateFilePath(): string {
    return join(app.getPath('userData'), 'vpn-state.json')
  }

  private async persistEnabled(enabled: boolean): Promise<void> {
    try {
      await writeFile(this.stateFilePath(), `${JSON.stringify({ enabled })}\n`, 'utf8')
    } catch (error) {
      console.warn('Failed to persist VPN state', error)
    }
  }
}

/**
 * `disable_non_proxied_udp` keeps WebRTC off any transport that bypasses the
 * proxy. SOCKS carries no UDP here, so this effectively disables WebRTC while
 * the tunnel is on — the same tradeoff Tor Browser makes.
 */
function applyWebRtcPolicy(contents: WebContents, vpnActive: boolean): void {
  try {
    contents.setWebRTCIPHandlingPolicy(vpnActive ? 'disable_non_proxied_udp' : 'default')
  } catch {
    // The contents can be mid-teardown; the next created surface gets the policy.
  }
}

async function resolveTorBinaryCandidates(): Promise<string[]> {
  const executable = process.platform === 'win32' ? 'tor.exe' : 'tor'
  const platformDirectory = `${process.platform}-${process.arch}`
  const bundledRoots = [
    // Packaged app (extraResources) first, then the repo checkout in dev.
    join(process.resourcesPath ?? '', 'tor'),
    join(app.getAppPath(), 'resources', 'tor')
  ]

  const candidates: string[] = []
  const override = process.env.CODEX_DESKTOP_TOR_BINARY
  if (override) candidates.push(override)
  for (const root of bundledRoots) {
    // Tor Expert Bundle extracts to <root>/<platform>/tor/<executable>.
    candidates.push(join(root, platformDirectory, 'tor', executable))
    candidates.push(join(root, platformDirectory, executable))
  }

  const existing: string[] = []
  for (const candidate of candidates) {
    try {
      await access(candidate)
      existing.push(candidate)
    } catch {
      // Not bundled here.
    }
  }

  // A system-wide tor on PATH is the dev-machine fallback.
  existing.push(executable)
  return existing
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close(() => {
        if (port) {
          resolve(port)
        } else {
          reject(new Error('Could not allocate a loopback port'))
        }
      })
    })
  })
}

function prependPath(entry: string, existing: string | undefined): string {
  return existing ? `${entry}:${existing}` : entry
}
