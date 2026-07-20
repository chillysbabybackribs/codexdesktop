import type { Session } from 'electron'

/**
 * Google's "this browser or app may not be secure" gate on accounts.google.com
 * inspects the User-Agent Client Hints, not just the UA string. Electron's
 * native `Sec-CH-UA` advertises an `"Electron"` brand and omits `"Google
 * Chrome"`, so Chromium's own hints identify the embedder even after
 * `browserUserAgentFallback` cleans the UA string (which does not touch hints).
 *
 * We rewrite the low-entropy `Sec-CH-UA*` request headers to a plain-Chrome
 * brand list, but ONLY for the Google sign-in hosts the OAuth flow touches.
 * Every other site keeps its native hints. This is a request-header rewrite on
 * the wire — no debugger is attached and CDP is untouched — because Google's
 * check reads these headers server-side. (In-page `navigator.userAgentData`
 * still reflects native brands; that value is not read by this gate.)
 */

// Hosts the Google sign-in flow navigates through. Sign-in bounces between
// accounts.google.com and a few static/consent hosts; each is matched by exact
// host or subdomain suffix.
const googleAuthHostSuffixes = [
  'accounts.google.com',
  'accounts.youtube.com',
  'accounts.gstatic.com',
  'oauthaccountmanager.googleapis.com'
] as const

export function isGoogleAuthHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '')
  return googleAuthHostSuffixes.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`)
  )
}

export function isGoogleAuthUrl(url: string): boolean {
  try {
    return isGoogleAuthHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Parse the Chromium major version out of a UA string's `Chrome/<version>`
 * token so the forged brand list stays consistent with the UA Google also
 * sees. Returns null when the token is absent, so callers can skip the rewrite
 * rather than advertise a guessed version that contradicts the UA.
 */
export function chromiumMajorVersion(userAgent: string): number | null {
  const match = /Chrome\/(\d+)\./.exec(userAgent)
  if (!match) return null
  const major = Number.parseInt(match[1]!, 10)
  return Number.isInteger(major) && major > 0 ? major : null
}

export type ClientHintHeaders = {
  'sec-ch-ua': string
  'sec-ch-ua-full-version-list'?: string
}

/**
 * Build a plain-Chrome low-entropy brand list for the given major version.
 * Mirrors the shape Chrome ships: the real product (`Google Chrome`), the
 * engine (`Chromium`), and a GREASE `Not/A)Brand` entry, with no `Electron`.
 * The `fullVersionList` variant carries the full version when the site
 * requested high-entropy hints.
 */
export function googleAuthClientHints(
  majorVersion: number,
  fullVersion?: string
): ClientHintHeaders {
  const major = String(majorVersion)
  const brands = [
    `"Google Chrome";v="${major}"`,
    `"Chromium";v="${major}"`,
    `"Not/A)Brand";v="24"`
  ].join(', ')

  const headers: ClientHintHeaders = { 'sec-ch-ua': brands }

  if (fullVersion && /^\d+(?:\.\d+){0,3}$/.test(fullVersion)) {
    headers['sec-ch-ua-full-version-list'] = [
      `"Google Chrome";v="${fullVersion}"`,
      `"Chromium";v="${fullVersion}"`,
      `"Not/A)Brand";v="24.0.0.0"`
    ].join(', ')
  }

  return headers
}

function chromiumFullVersion(userAgent: string): string | null {
  const match = /Chrome\/(\d+(?:\.\d+){0,3})/.exec(userAgent)
  return match ? match[1]! : null
}

/**
 * Apply the Google-auth brand override to a mutable request-header map,
 * matching the existing header casing so we replace rather than duplicate.
 * Only rewrites hints that were already present — Chromium adds `Sec-CH-UA` and
 * `Sec-CH-UA-Full-Version-List` on its own, and we must not invent hints the
 * server did not ask for. Returns true when any header changed.
 */
export function rewriteRequestClientHints(
  headers: Record<string, string | string[]>,
  hints: ClientHintHeaders
): boolean {
  let changed = false

  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase()
    if (lower === 'sec-ch-ua') {
      headers[key] = hints['sec-ch-ua']
      changed = true
    } else if (lower === 'sec-ch-ua-full-version-list' && hints['sec-ch-ua-full-version-list']) {
      headers[key] = hints['sec-ch-ua-full-version-list']
      changed = true
    }
  }

  return changed
}

/**
 * Wire the Google-auth Client-Hints rewrite onto a browser session. No-ops
 * (leaving native hints untouched) when the UA lacks a parseable Chrome
 * version, so an unexpected UA never gets a contradictory forged brand list.
 */
export function installGoogleAuthClientHints(browserSession: Session, userAgent: string): void {
  const majorVersion = chromiumMajorVersion(userAgent)
  if (majorVersion === null) return

  const hints = googleAuthClientHints(majorVersion, chromiumFullVersion(userAgent) ?? undefined)

  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!isGoogleAuthUrl(details.url)) {
      callback({ requestHeaders: details.requestHeaders })
      return
    }

    const requestHeaders = details.requestHeaders
    rewriteRequestClientHints(requestHeaders, hints)
    callback({ requestHeaders })
  })
}
