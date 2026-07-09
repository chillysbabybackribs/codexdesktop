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
