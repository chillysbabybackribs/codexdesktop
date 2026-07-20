export type BrowserQualityPreset = 'quality-max' | 'balanced' | 'manual'

export type BrowserUseMode = 'none' | 'live' | 'background' | 'dual'

export type BrowserGuidanceLane = 'codex' | 'claude'

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
    if (preset === 'quality-max') {
      return referencedWeb
        ? {
            preset,
            mode: 'live',
            required: true,
            reason: 'live browser should verify the referenced page directly',
          }
        : {
            preset,
            mode: 'background',
            required: true,
            reason: 'public discovery should preserve the visible tab unless live verification is needed',
          }
    }
    const liveFirst = explicit || current || referencedWeb
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

function toolName(name: string, lane: BrowserGuidanceLane): string {
  return lane === 'claude' ? `mcp__browser__${name}` : name
}

export function buildBrowserUseGuidance(
  env: NodeJS.ProcessEnv = process.env,
  lane: BrowserGuidanceLane = 'codex',
): string {
  const preset = browserQualityPreset(env)
  const t = (name: string) => toolName(name, lane)
  return [
    `Codex Desktop browser-use preset: ${preset}.`,
    ...(lane === 'claude'
      ? [
          `- Browse only with the mcp__browser__ tools. The built-in WebSearch and WebFetch tools are disabled; ${t('browser_live_search')}, ${t('research_web')}, and ${t('browser_extract_page')} replace them.`,
        ]
      : []),
    '- Browse when the answer materially depends on current, changing, external, linked, or browser-visible information. Otherwise reason normally from the available context.',
    `- Choose between ${t('research_web')}, ${t('browser_live_search')}, ${t('browser_snapshot')}, and the other browser tools using ordinary task judgment. Tool guidance is capability information, not a replacement for interpreting the user's request.`,
    '- For search discovery, preserve the user\'s literal product names and intent. Start with a direct query based on their wording; add or vary queries only when doing so is useful for coverage. Do not inject unrequested hypotheses or keywords.',
    `- Prefer ${t('research_web')} for broad public discovery when changing the visible tab is unnecessary. Use ${t('browser_live_search')} only when visible verification materially helps or the user asks for it; it navigates the existing visible tab. Never navigate the visible tab to a SERP.`,
    '- Treat every discovered or automatically selected page as a candidate, not an answer. Reject irrelevant destinations even when they are readable or highly ranked, and resolve material evidence gaps before answering.',
    '- The live browser is the authority for referenced, authenticated, interactive, or browser-visible state. Reuse an explicit existing tab and never create a tab unless the user requested one.',
    ...(preset === 'quality-max'
      ? [
          '- In quality-max mode, corroborate consequential claims when independent evidence is useful. Choose the number of searches and whether verification is live or background-only from the task rather than following a fixed recipe.',
        ]
      : preset === 'balanced'
        ? [
            '- In balanced mode, use the smallest amount of browsing that can answer reliably.',
          ]
        : ['- In manual mode, browse only when the user explicitly requests browsing or the task directly names a live browser surface.']),
    '- Do not claim a current external fact from memory when this policy requires browsing. If browsing fails, say what could not be verified.',
    '- Narrate browsing sparingly: at most one short user-facing line per phase, naming the goal ("Searching for X…", "Opening example.com…"). Never describe internal mechanics such as hidden workers, SERP extraction, ranking, lanes, or tool names, and never restate an unchanged status.',
  ].join('\n')
}
