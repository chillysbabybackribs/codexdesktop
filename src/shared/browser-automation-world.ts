// Electron reserves world 999 for its context-isolated preload. Browser-owned
// page programs use a separate world whose CSP forbids secondary string-to-code
// evaluation without weakening the document's own policy.
export const BROWSER_AUTOMATION_WORLD_ID = 1_001
export const BROWSER_AUTOMATION_WORLD_CSP = "script-src 'none'; object-src 'none'; base-uri 'none'"
export const BROWSER_AUTOMATION_WORLD_NAME = 'Codex Browser Automation'

const fallbackSecurityOrigin = 'https://codex-browser-automation.invalid'

export function browserAutomationSecurityOrigin(origin: string): string {
  try {
    const parsed = new URL(origin)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.origin
      : fallbackSecurityOrigin
  } catch {
    return fallbackSecurityOrigin
  }
}

export function browserAutomationWorldInfo(origin: string): {
  securityOrigin: string
  csp: string
  name: string
} {
  return {
    securityOrigin: browserAutomationSecurityOrigin(origin),
    csp: BROWSER_AUTOMATION_WORLD_CSP,
    name: BROWSER_AUTOMATION_WORLD_NAME
  }
}
