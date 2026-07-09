import { app, session } from 'electron'

export const browserPartition = 'persist:codex-browser'

// Google rejects user agents containing "Electron" — sign-in pages go blank.
export function chromeLikeUserAgent(): string {
  return app.userAgentFallback.replace(/\sElectron\/\S+/g, '').trim()
}

export function configureBrowserSession(): void {
  session.fromPartition(browserPartition).setUserAgent(chromeLikeUserAgent())
}
