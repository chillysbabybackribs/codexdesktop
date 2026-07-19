import { parseHTML } from 'linkedom'
import { assessExtractedPage } from '../browser/research-utils.js'

// The CPU-heavy core of the research static lane: parse up to ~750KB of HTML
// with linkedom, run the shared page-extraction program against the inert DOM,
// and verify the result. Pure (html, url, program) → outcome, so it runs
// identically inside the utility-process worker and inline (node tests, or
// fallback when the worker is unavailable).

export const staticArtifactChars = 100_000
export const minStaticWords = 80
export const minStaticContentChars = 500

export type StaticExtractedPage = {
  title: string
  url: string
  content: string
  wordCount: number
  truncated: boolean
}

export type StaticExtractOutcome =
  | { ok: true; page: StaticExtractedPage }
  | { ok: false; reason: string }

export function runStaticExtraction(program: string, html: string, url: string): StaticExtractOutcome {
  try {
    const { document, Node } = parseHTML(html)
    if (!document.querySelector('article, main, [role="main"], [itemprop="articleBody"]')) {
      return { ok: false, reason: 'static document has no confident content root' }
    }
    const execute = new Function('document', 'location', 'Node', program) as (
      document: unknown,
      location: { href: string },
      node: unknown
    ) => Omit<StaticExtractedPage, 'url'>
    const extracted = execute(document, { href: url }, Node)
    const page: StaticExtractedPage = { ...extracted, url }
    const assessment = assessExtractedPage(page)
    if (!assessment.verified) {
      return { ok: false, reason: `static verification failed: ${assessment.reason}` }
    }
    if (page.wordCount < minStaticWords || page.content.length < minStaticContentChars) {
      return { ok: false, reason: 'static extraction confidence is too low' }
    }
    return { ok: true, page }
  } catch (error) {
    return { ok: false, reason: `static extraction failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}
