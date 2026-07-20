export type BrowserQualityPreset = 'quality-max' | 'balanced' | 'manual'

export type BrowserUseMode = 'none' | 'live' | 'background' | 'dual'

export type BrowserUseDecision = {
  preset: BrowserQualityPreset
  mode: BrowserUseMode
  required: boolean
  reason: string
}

export function browserQualityPreset(env: NodeJS.ProcessEnv = process.env): BrowserQualityPreset {
  const configured = env.CODEX_DESKTOP_BROWSER_PRESET?.trim().toLowerCase()
  if (configured === 'balanced' || configured === 'manual') return configured
  return 'quality-max'
}

export function decideBrowserUse(
  text: string,
  preset: BrowserQualityPreset = browserQualityPreset(),
): BrowserUseDecision {
  const normalized = text.trim().toLowerCase()
  if (!normalized || preset === 'manual') {
    return {
      preset,
      mode: 'none',
      required: false,
      reason: preset === 'manual' ? 'manual preset only browses on explicit request' : 'empty request',
    }
  }

  const explicit = /\b(browse|browser|google|look up|live web|search (?:the )?(?:web|internet)|verify online)\b/.test(normalized)
  const interactive = /\b(click|fill|select|submit|sign in|log in|current tab|this (?:page|tab)|my (?:account|inbox|dashboard|profile|messages?|notifications?))\b/.test(normalized)
  const current = /\b(current|currently|latest|live|today|tonight|this (?:week|month|year)|right now|recent|newest|up[- ]to[- ]date|price|schedule|score|weather|news|release|version|ceo|president)\b/.test(normalized)
  const referencedWeb = /https?:\/\/|\b(?:page|site|website|article|paper|docs?|documentation|source|link)\b/.test(normalized)
  const broadResearch = /\b(compare|comparison|best|recommend|research|investigate|sources?|evidence|market|reviews?|options|alternatives|pros and cons)\b/.test(normalized)

  if (interactive) {
    return { preset, mode: 'live', required: true, reason: 'interactive or authenticated browser state' }
  }
  if (explicit || current || referencedWeb || broadResearch) {
    const liveFirst = preset === 'quality-max' || explicit || current || referencedWeb
    return {
      preset,
      mode: liveFirst ? 'live' : 'background',
      required: true,
      reason: liveFirst
        ? 'live browser should verify external or browser-visible information'
        : 'external evidence is required',
    }
  }

  return { preset, mode: 'none', required: false, reason: 'request is locally answerable' }
}

export function buildBrowserUseGuidance(env: NodeJS.ProcessEnv = process.env): string {
  const preset = browserQualityPreset(env)
  return [
    `Codex Desktop browser-use preset: ${preset}.`,
    '- Treat browsing as required even when the user does not literally say search whenever the answer depends on current, changing, external, linked, or browser-visible information.',
    '- Use browser_live_search or browser_snapshot for visible verification. For discovery, have the selected model author three to six semantic query variations from the user request; browser_live_search runs them in parallel hidden workers and exposes only direct destination-page navigation in the visible tab. Never navigate the visible tab to a SERP.',
    '- The live browser is the authority for current, referenced, authenticated, interactive, or browser-visible state. Reuse an explicit existing tab and never create a tab unless the user requested one.',
    '- Use the artifact-first background research lane only when source breadth, independent corroboration, or saved public evidence materially improves the answer. Background research is optional support; it is not a mandatory follow-up after adequate live-browser verification.',
    ...(preset === 'quality-max'
      ? ['- In quality-max mode, prefer the live browser first. Use browser_research_dual only for broad source-backed research, consequential comparisons, or conflicts where visible verification plus bounded background evidence should be gathered together.']
      : preset === 'balanced'
        ? ['- In balanced mode, choose one lane by task shape: live for referenced/authenticated/interactive state, background for broad public research, and dual only for consequential comparisons.']
        : ['- In manual mode, browse only when the user explicitly requests browsing or the task directly names a live browser surface.']),
    '- Do not claim a current external fact from memory when this policy requires browsing. If browsing fails, say what could not be verified.',
  ].join('\n')
}
