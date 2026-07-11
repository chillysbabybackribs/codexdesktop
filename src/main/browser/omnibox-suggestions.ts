import type { OmniboxSuggestion } from '../../shared/ipc.js'
import type { HistoryEntry } from './browser-history-store.js'
import { describeNavigationInput } from './url-utils.js'

export const MAX_OMNIBOX_ROWS = 8

// Ranks history entries for the omnibox dropdown. Row 0 is always the typed
// interpretation (navigate or search) so Enter-with-no-selection and the top
// row agree; history matches follow by frecency. An empty input (bar clicked,
// nothing typed) shows the most frecent sites, Chrome-style.
export function buildSuggestions(input: string, entries: HistoryEntry[], now = Date.now()): OmniboxSuggestion[] {
  const text = input.trim()

  if (!text) {
    return topSites(entries, now)
  }

  const typed = describeNavigationInput(text)
  const typedRow: OmniboxSuggestion =
    typed.kind === 'search'
      ? { kind: 'search', url: typed.url, text, detail: 'Google Search' }
      : { kind: 'navigate', url: typed.url, text: typed.url, detail: '' }

  const needles = text.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = entries
    .map((entry) => ({ entry, score: matchScore(entry, needles, now) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_OMNIBOX_ROWS - 1)
    .map(({ entry }) => historyRow(entry))
    // The typed row already offers this exact navigation; don't repeat it.
    .filter((row) => row.url !== typedRow.url)

  return [typedRow, ...matches]
}

function topSites(entries: HistoryEntry[], now: number): OmniboxSuggestion[] {
  return entries
    .map((entry) => ({ entry, score: frecency(entry, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_OMNIBOX_ROWS)
    .map(({ entry }) => historyRow(entry))
}

function historyRow(entry: HistoryEntry): OmniboxSuggestion {
  return {
    kind: 'history',
    url: entry.url,
    text: entry.title || displayUrl(entry.url),
    detail: displayUrl(entry.url)
  }
}

// Strip scheme and trailing slash for display — the row shows where you're
// going, not protocol noise. Never used for navigation.
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

function matchScore(entry: HistoryEntry, needles: string[], now: number): number {
  const url = entry.url.toLowerCase()
  const title = entry.title.toLowerCase()
  const host = hostOf(url)

  let matchWeight = 0

  for (const needle of needles) {
    if (host.startsWith(needle) || host.startsWith(`www.${needle}`)) {
      matchWeight += 2
    } else if (host.includes(needle)) {
      matchWeight += 1.2
    } else if (url.includes(needle) || title.includes(needle)) {
      matchWeight += 1
    } else {
      return 0
    }
  }

  return matchWeight * frecency(entry, now)
}

// Simplified Firefox-style frecency: visit count damped by recency buckets.
function frecency(entry: HistoryEntry, now: number): number {
  const age = now - entry.lastVisitAt
  const hour = 3_600_000
  const recencyWeight = age < 4 * hour ? 2 : age < 24 * hour ? 1.5 : age < 7 * 24 * hour ? 1 : age < 28 * 24 * hour ? 0.7 : 0.4

  return entry.visitCount * recencyWeight
}

function hostOf(url: string): string {
  const match = /^https?:\/\/([^/:?#]+)/i.exec(url)
  return match ? match[1] : ''
}

// Chromium-style inline autocomplete: the best history match whose typeable
// form starts with the input completes the rest of the address bar text.
// Returns the full completed text (the user's typed prefix preserved
// verbatim), or null when nothing should complete. Every persisted history
// entry qualifies, matching the same history set shown in the dropdown.
export function inlineCompletion(input: string, entries: HistoryEntry[], now = Date.now()): string | null {
  const typed = input.trim()

  if (!typed || /\s/.test(typed) || typed !== input) {
    return null
  }

  const typedLower = typed.toLowerCase()
  let best: { form: string; score: number } | null = null

  for (const entry of entries) {
    const form = typeableForms(entry.url).find(
      (candidate) => candidate.length > typed.length && candidate.toLowerCase().startsWith(typedLower)
    )

    if (!form) {
      continue
    }

    const score = frecency(entry, now)

    if (!best || score > best.score) {
      best = { form, score }
    }
  }

  return best ? typed + best.form.slice(typed.length) : null
}

// The strings a user might plausibly be typing toward, shortest first so a
// host completion wins over a deep URL. "www." is stripped in the preferred
// forms because nobody types it.
function typeableForms(url: string): string[] {
  const host = hostOf(url)
  const hostNoWww = host.replace(/^www\./i, '')
  const noScheme = url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  const noSchemeNoWww = noScheme.replace(/^www\./i, '')

  return [...new Set([hostNoWww, host, noSchemeNoWww, noScheme, url])]
}
