export const BROWSER_NAVIGATOR_LANGUAGES = ['en-US', 'en'] as const
export const BROWSER_ACCEPT_LANGUAGE = BROWSER_NAVIGATOR_LANGUAGES.join(',')

export type BrowserIdentity = {
  userAgent: string
  acceptLanguage: string
  userAgentMetadata: {
    brands: Array<{ brand: string; version: string }>
    fullVersionList: Array<{ brand: string; version: string }>
    platform: string
    platformVersion: string
    architecture: string
    bitness: string
    model: string
    mobile: boolean
  }
}

export type BrowserIdentityInput = {
  chromeVersion: string
  platform: NodeJS.Platform
  architecture: string
}

/**
 * Build one coherent desktop-Chrome identity from the Chromium version Electron
 * actually bundles. The stock Electron UA contains both the application name
 * and an Electron token; either is enough for a trust-sensitive site to reject
 * an otherwise ordinary, user-driven browser session.
 */
export function buildBrowserIdentity(input: BrowserIdentityInput): BrowserIdentity {
  const fullVersion = normalizedChromeVersion(input.chromeVersion)
  const majorVersion = fullVersion.split('.')[0]
  const platform = browserPlatform(input.platform)
  const architecture = browserArchitecture(input.architecture)
  const bitness = input.architecture === 'ia32' || input.architecture === 'arm' ? '32' : '64'
  const greaseBrand = { brand: 'Not(A:Brand', version: '99' }

  return {
    userAgent:
      `Mozilla/5.0 (${platform.userAgentToken}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${fullVersion} Safari/537.36`,
    // Electron derives navigator.languages from this value, so it must stay a
    // bare language list rather than an HTTP q-weighted header value.
    acceptLanguage: BROWSER_ACCEPT_LANGUAGE,
    userAgentMetadata: {
      brands: [
        { brand: 'Chromium', version: majorVersion },
        { brand: 'Google Chrome', version: majorVersion },
        greaseBrand
      ],
      fullVersionList: [
        { brand: 'Chromium', version: fullVersion },
        { brand: 'Google Chrome', version: fullVersion },
        { brand: greaseBrand.brand, version: '99.0.0.0' }
      ],
      platform: platform.clientHint,
      // Avoid inventing a kernel/OS release on Linux and macOS. Windows Chrome
      // reports this reduced platform version for the desktop UA above.
      platformVersion: input.platform === 'win32' ? '10.0.0' : '',
      architecture,
      bitness,
      model: '',
      mobile: false
    }
  }
}

function normalizedChromeVersion(value: string): string {
  const parts = value.trim().split('.')
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) {
    return '1.0.0.0'
  }
  return [...parts.slice(0, 4), ...Array.from({ length: Math.max(0, 4 - parts.length) }, () => '0')].join('.')
}

function browserPlatform(platform: NodeJS.Platform): { userAgentToken: string; clientHint: string } {
  if (platform === 'win32') {
    return { userAgentToken: 'Windows NT 10.0; Win64; x64', clientHint: 'Windows' }
  }
  if (platform === 'darwin') {
    return { userAgentToken: 'Macintosh; Intel Mac OS X 10_15_7', clientHint: 'macOS' }
  }
  return { userAgentToken: 'X11; Linux x86_64', clientHint: 'Linux' }
}

function browserArchitecture(architecture: string): string {
  return architecture === 'arm' || architecture === 'arm64' ? 'arm' : 'x86'
}
