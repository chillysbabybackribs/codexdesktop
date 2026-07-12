export function isBlankPopupUrl(url: string | undefined): boolean {
  const trimmed = url?.trim() ?? ''
  return !trimmed || trimmed === 'about:blank'
}

export function isExternalHttpUrl(url: string | undefined): boolean {
  const trimmed = url?.trim() ?? ''
  return /^https?:\/\//i.test(trimmed)
}

export function isUnsafePopupUrl(url: string | undefined): boolean {
  const lower = url?.trim().toLowerCase() ?? ''
  return lower.startsWith('javascript:') || lower.startsWith('file:')
}

export type WindowOpenRequest = {
  url?: string
  disposition?: string
  frameName?: string
  features?: string
}

export type WindowOpenAction = 'deny' | 'current-page' | 'popup'

// Plain target="_blank" links are new-page navigations, not application
// popups. Keep them in the current embedded page. A scripted window with a
// name, popup features, or an initial about:blank document is allowed to keep
// a real opener relationship for OAuth and similar flows.
export function resolveWindowOpenAction(request: WindowOpenRequest): WindowOpenAction {
  if (isUnsafePopupUrl(request.url)) {
    return 'deny'
  }

  if (isBlankPopupUrl(request.url)) {
    return 'popup'
  }

  if (!isExternalHttpUrl(request.url)) {
    return 'deny'
  }

  const frameName = request.frameName?.trim() ?? ''
  const hasNamedPopup = frameName !== '' && frameName !== '_blank'
  const hasPopupFeatures = (request.features?.trim() ?? '') !== ''

  if (request.disposition === 'new-window' && (hasNamedPopup || hasPopupFeatures)) {
    return 'popup'
  }

  return 'current-page'
}
