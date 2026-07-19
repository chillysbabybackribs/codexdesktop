const DEFAULT_PROFILE_TTL_MS = 15 * 60_000
const DEFAULT_MAX_PROFILES = 128
const UNKNOWN_ORIGIN_TIMEOUT_MS = 650
const MIN_STATIC_TIMEOUT_MS = 350
const MAX_STATIC_TIMEOUT_MS = 1_500

export type ResearchOriginRouteReason =
  | 'unknown-origin'
  | 'static-proven'
  | 'browser-proven'
  | 'static-probe-in-flight'

export type ResearchOriginRouteOutcome =
  | { kind: 'accepted'; durationMs: number }
  | { kind: 'fallback'; durationMs: number }
  | { kind: 'timeout'; durationMs: number }
  | { kind: 'blocked' | 'cancelled'; durationMs?: number }

export type ResearchOriginRoute = {
  mode: 'static' | 'browser'
  reason: ResearchOriginRouteReason
  timeoutMs: number
  finish: (outcome: ResearchOriginRouteOutcome) => void
}

type OriginProfile = {
  score: number
  staticProbeInFlight: boolean
  averageStaticMs: number | null
  expiresAt: number
}

/**
 * Learns whether an origin benefits from the inert fetch lane. Unknown origins
 * get one bounded probe; concurrent pages from the same unproven origin go
 * directly to Chromium instead of all paying the same preflight penalty.
 */
export class ResearchOriginRouter {
  private readonly profiles = new Map<string, OriginProfile>()
  private readonly ttlMs: number
  private readonly maxProfiles: number
  private readonly now: () => number

  constructor(
    ttlMs = DEFAULT_PROFILE_TTL_MS,
    maxProfiles = DEFAULT_MAX_PROFILES,
    now: () => number = Date.now
  ) {
    this.ttlMs = ttlMs
    this.maxProfiles = maxProfiles
    this.now = now
  }

  begin(url: string): ResearchOriginRoute {
    const origin = originKey(url)
    if (!origin) return inertBrowserRoute('browser-proven')

    const profile = this.read(origin)
    if (profile && profile.score < 0) {
      return inertBrowserRoute('browser-proven')
    }
    if (profile && profile.score === 0 && profile.staticProbeInFlight) {
      return inertBrowserRoute('static-probe-in-flight')
    }

    const active = profile ?? {
      score: 0,
      staticProbeInFlight: false,
      averageStaticMs: null,
      expiresAt: this.now() + this.ttlMs
    }
    active.staticProbeInFlight = true
    active.expiresAt = this.now() + this.ttlMs
    this.touch(origin, active)

    let finished = false
    return {
      mode: 'static',
      reason: active.score > 0 ? 'static-proven' : 'unknown-origin',
      timeoutMs: staticTimeout(active.averageStaticMs),
      finish: (outcome) => {
        if (finished) return
        finished = true
        active.staticProbeInFlight = false
        active.expiresAt = this.now() + this.ttlMs
        if (outcome.kind === 'accepted') {
          active.score = Math.min(4, active.score + 2)
          active.averageStaticMs = active.averageStaticMs === null
            ? outcome.durationMs
            : Math.round(active.averageStaticMs * 0.7 + outcome.durationMs * 0.3)
        } else if (outcome.kind === 'fallback') {
          active.score = Math.max(-4, active.score - 2)
        } else if (outcome.kind === 'timeout') {
          active.score = Math.max(-4, active.score - 3)
        }
        this.touch(origin, active)
      }
    }
  }

  private read(origin: string): OriginProfile | null {
    const profile = this.profiles.get(origin)
    if (!profile) return null
    if (profile.expiresAt <= this.now()) {
      this.profiles.delete(origin)
      return null
    }
    this.touch(origin, profile)
    return profile
  }

  private touch(origin: string, profile: OriginProfile): void {
    this.profiles.delete(origin)
    this.profiles.set(origin, profile)
    while (this.profiles.size > this.maxProfiles) {
      const oldest = this.profiles.keys().next().value
      if (typeof oldest !== 'string') break
      this.profiles.delete(oldest)
    }
  }
}

function staticTimeout(averageStaticMs: number | null): number {
  if (averageStaticMs === null) return UNKNOWN_ORIGIN_TIMEOUT_MS
  return Math.min(
    MAX_STATIC_TIMEOUT_MS,
    Math.max(MIN_STATIC_TIMEOUT_MS, Math.round(averageStaticMs * 2.5 + 100))
  )
}

function inertBrowserRoute(reason: ResearchOriginRouteReason): ResearchOriginRoute {
  return { mode: 'browser', reason, timeoutMs: 0, finish: () => {} }
}

function originKey(url: string): string | null {
  try {
    return new URL(url).origin.toLowerCase()
  } catch {
    return null
  }
}
