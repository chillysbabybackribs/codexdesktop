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
      const searchShaped = explicit || current || broadResearch
      return searchShaped
        ? {
            preset,
            mode: 'dual',
            required: true,
            reason:
              'search-shaped or freshness-sensitive: verify live in the visible tab while parallel background research corroborates',
          }
        : {
            preset,
            mode: 'live',
            required: true,
            reason: 'live browser should verify the referenced page directly',
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
          `- Browse only with the mcp__browser__ tools. The built-in WebSearch and WebFetch tools are disabled; ${t('browser_research_dual')}, ${t('browser_live_search')}, ${t('research_web')}, and ${t('browser_extract_page')} replace them.`,
        ]
      : []),
    '- Treat browsing as required even when the user does not literally say search whenever the answer depends on current, changing, external, linked, or browser-visible information.',
    `- Use ${t('browser_live_search')} or ${t('browser_snapshot')} for visible verification. For discovery, have the selected model author three to six semantic query variations from the user request — each a short, single-angle phrase a person would actually type (like "claude desktop high cpu"), never one query stuffed with every keyword, site, and year at once; ${t('browser_live_search')} runs them in parallel hidden workers and exposes only direct destination-page navigation in the visible tab. Never navigate the visible tab to a SERP.`,
    '- The live browser is the authority for current, referenced, authenticated, interactive, or browser-visible state. Reuse an explicit existing tab and never create a tab unless the user requested one.',
    `- Background research (${t('research_web')}) complements visible verification instead of replacing it: it gathers bounded independent public evidence in parallel while the visible tab verifies the strongest source live.`,
    ...(preset === 'quality-max'
      ? [
          `- In quality-max mode, search-shaped, current-information, or post-knowledge-cutoff tasks should normally use ${t('browser_research_dual')}: one call that verifies live in the visible tab while parallel background research corroborates. Use the live browser alone (${t('browser_live_search')}, ${t('browser_snapshot')}) for referenced, authenticated, or interactive pages where source breadth adds nothing, and ${t('research_web')} alone only when the user explicitly asks for background-only research.`,
        ]
      : preset === 'balanced'
        ? [
            `- In balanced mode, choose one lane by task shape: live for referenced/authenticated/interactive state, background for broad public research, and ${t('browser_research_dual')} only for consequential comparisons.`,
          ]
        : ['- In manual mode, browse only when the user explicitly requests browsing or the task directly names a live browser surface.']),
    '- Do not claim a current external fact from memory when this policy requires browsing. If browsing fails, say what could not be verified.',
    '- Narrate browsing sparingly: at most one short user-facing line per phase, naming the goal ("Searching for X…", "Opening example.com…"). Never describe internal mechanics such as hidden workers, SERP extraction, ranking, lanes, or tool names, and never restate an unchanged status.',
  ].join('\n')
}

const modeStartingTools: Record<Exclude<BrowserUseMode, 'none'>, string[]> = {
  live: ['browser_live_search', 'browser_snapshot'],
  background: ['research_web'],
  dual: ['browser_research_dual'],
}

// One-line router verdict injected into the turn input so the model actually
// sees the per-turn lane decision (previously it was UI telemetry only).
export function formatBrowserDecisionNote(
  decision: BrowserUseDecision,
  lane: BrowserGuidanceLane = 'codex',
): string | null {
  if (!decision.required || decision.mode === 'none') return null
  const tools = modeStartingTools[decision.mode].map((name) => toolName(name, lane)).join(' or ')
  return `[browser routing] mode=${decision.mode} (${decision.preset}): ${decision.reason}. Start with ${tools} unless the request clearly needs no external evidence.`
}
