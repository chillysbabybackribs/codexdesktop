/**
 * Strip embedder product tokens from Electron's browser fallback without
 * replacing Chromium's native identity. Assigning the result to
 * `app.userAgentFallback` before creating a session keeps native UA Client
 * Hints intact; Session/WebContents UA overrides erase or forge that metadata
 * and require a permanently attached debugger to restore it.
 */
export function browserUserAgentFallback(userAgent: string, applicationName: string): string {
  const applicationToken = applicationName.replace(/[^a-z0-9]/gi, '')
  const productPatterns = [
    /\sElectron\/\S+/gi,
    ...(applicationToken
      ? [new RegExp(`\\s${escapeRegExp(applicationToken)}\\/\\S+`, 'gi')]
      : [])
  ]

  return productPatterns.reduce((value, pattern) => value.replace(pattern, ''), userAgent)
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
