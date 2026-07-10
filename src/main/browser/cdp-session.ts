import type { WebContents } from 'electron'

const sessions = new WeakMap<WebContents, CdpSession>()

export class CdpSession {
  private attached = false

  constructor(private readonly webContents: WebContents) {
    webContents.debugger.on('detach', () => {
      this.attached = false
    })
    webContents.once('destroyed', () => {
      this.attached = false
    })
  }

  async send(method: string, params: object = {}): Promise<unknown> {
    this.ensureAttached()
    return this.webContents.debugger.sendCommand(method, params)
  }

  async terminateExecution(): Promise<void> {
    if (this.webContents.isDestroyed()) return

    try {
      this.ensureAttached()
      await this.webContents.debugger.sendCommand('Runtime.terminateExecution')
    } catch {
      // The target may already have navigated, detached, or completed.
    }
  }

  detach(): void {
    if (!this.webContents.isDestroyed() && this.webContents.debugger.isAttached()) {
      try {
        this.webContents.debugger.detach()
      } catch {
        // Best-effort cleanup while a tab is closing.
      }
    }
    this.attached = false
  }

  private ensureAttached(): void {
    if (this.webContents.isDestroyed()) {
      throw new Error('CDP target is no longer available')
    }

    if (!this.webContents.debugger.isAttached()) {
      this.webContents.debugger.attach()
    }
    this.attached = true
  }
}

export function cdpSessionFor(webContents: WebContents): CdpSession {
  let session = sessions.get(webContents)
  if (!session) {
    session = new CdpSession(webContents)
    sessions.set(webContents, session)
  }
  return session
}
