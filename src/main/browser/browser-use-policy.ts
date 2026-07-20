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
    const dual = preset === 'quality-max' && (current || broadResearch || explicit)
    return {
      preset,
      mode: dual ? 'dual' : referencedWeb && !broadResearch ? 'live' : 'background',
      required: true,
      reason: dual
        ? 'quality-max requires visible verification plus independent background research'
        : referencedWeb && !broadResearch
          ? 'a referenced web surface should be inspected directly'
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
    '- Use browser_live_search or browser_snapshot for visible verification. The existing browser tab is a user-visible workspace: reuse an explicit existing tab and never create a tab unless the user requested one.',
    '- Use research_web for independent public-web breadth. It is an artifact-first background lane and does not replace visible verification of the live browser.',
    ...(preset === 'quality-max'
      ? ['- In quality-max mode, current/public research should normally use browser_research_dual so visible search and bounded background research run together. For authenticated or interactive work, use the live lane as the authority and add research_web only when independent public evidence helps.']
      : preset === 'balanced'
        ? ['- In balanced mode, choose one lane by task shape: live for referenced/authenticated/interactive state, background for broad public research, and dual only for consequential comparisons.']
        : ['- In manual mode, browse only when the user explicitly requests browsing or the task directly names a live browser surface.']),
    '- Do not claim a current external fact from memory when this policy requires browsing. If browsing fails, say what could not be verified.',
  ].join('\n')
}
