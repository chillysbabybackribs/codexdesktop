const searchBase = 'https://www.google.com/search?q='

export type NavigationInputInterpretation = {
  kind: 'navigate' | 'search'
  url: string
}

// Interpretation for ADDRESS-BAR input. Stricter than normalizeNavigationInput:
// only web-safe schemes may navigate; everything else (javascript:, file:,
// data:, chrome:, mailto:, ...) becomes a search, matching Chromium. loadURL
// bypasses will-navigate, so this is the only gate typed input passes through.
export function describeNavigationInput(input: string): NavigationInputInterpretation {
  const value = input.trim()

  if (!value) {
    return { kind: 'navigate', url: 'about:blank' }
  }

  if (isHostWithPort(value)) {
    return { kind: 'navigate', url: `https://${value}` }
  }

  if (/^(https?|about):/i.test(value)) {
    return { kind: 'navigate', url: value }
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return { kind: 'search', url: searchUrl(value) }
  }

  if (isLikelyHost(value)) {
    return { kind: 'navigate', url: `https://${value}` }
  }

  return { kind: 'search', url: searchUrl(value) }
}

// Normalization for PROGRAMMATIC navigation (agent control server, research
// runner, attachment previews). Schemes pass through untouched — data: and
// custom schemes are legitimate here.
export function normalizeNavigationInput(input: string): string {
  const value = input.trim()

  if (!value) {
    return 'about:blank'
  }

  // "localhost:3000" parses as scheme "localhost:", so check host:port first.
  if (isHostWithPort(value)) {
    return `https://${value}`
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return value
  }

  if (isLikelyHost(value)) {
    return `https://${value}`
  }

  return searchUrl(value)
}

function searchUrl(query: string): string {
  return `${searchBase}${encodeURIComponent(query)}`
}

function isHostWithPort(value: string): boolean {
  return /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+(?:\.[a-z0-9-]+)+):\d{1,5}(?:\/\S*)?$/i.test(value)
}

function isLikelyHost(value: string): boolean {
  if (/\s/.test(value)) {
    return false
  }

  if (/^localhost(?::\d+)?(?:\/.*)?$/i.test(value)) {
    return true
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/.*)?$/.test(value)) {
    return true
  }

  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/.*)?$/i.test(value)
}
