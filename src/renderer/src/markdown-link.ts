export type MarkdownLinkDestination = 'browser' | 'anchor' | 'blocked'

export function classifyMarkdownHref(href: string | undefined): MarkdownLinkDestination {
  if (!href) return 'blocked'
  if (/^https?:\/\//i.test(href)) return 'browser'
  if (href.startsWith('#')) return 'anchor'
  return 'blocked'
}
