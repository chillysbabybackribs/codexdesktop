import type { DynamicToolSpec } from '../../shared/codex-protocol/v2/DynamicToolSpec.js'
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort.js'

const taskShapingGuidance = [
  'Codex Desktop guidance:',
  '- Reuse the active visible browser tab. Create a new tab only when the user explicitly requests one. Scripts using CODEX_BROWSER_SOCK must target an existing tab id from `GET /tabs` or a prior browser result.',
  '- For browser work, wait for the requested DOM state rather than network idle or a fixed sleep. Modern sites often keep background requests open after their useful content is ready.',
  '- For simple browser reads, prefer one `browser_snapshot` call that can navigate, wait, and return task-focused items. Batch ordered actions, inspection, and verification into one `browser_run` program only when interaction is required.',
  '- For ambiguous opening requests that may continue earlier work, use the prior-chat-memory skill before asking the user to restate context. Skip it for clearly standalone requests.',
  '- Use Markdown tables or fenced `chart` JSON only when they materially clarify the result. Chart data entries use `{ "label": "…", "value": 0 }`.'
]

export function buildGuidance(env: NodeJS.ProcessEnv = process.env): string {
  const guidance = [...taskShapingGuidance]

  if (env.CODEX_DESKTOP_AUTOGIT_ACTIVE === '1') {
    const repoRoot = env.CODEX_DESKTOP_AUTOGIT_ROOT || 'the Codex Desktop source checkout'
    const pushBehavior = env.CODEX_DESKTOP_AUTOGIT_PUSH_ENABLED === '1'
      ? ' and then pushes each autosnapshot to the current branch on `origin`'
      : '; automatic pushing is disabled'

    guidance.push(
      'Automatic Git snapshotting is active for the Codex Desktop development checkout:',
      `- A separate watcher monitors \`${repoRoot}\`, automatically commits settled safe changes${pushBehavior}.`,
      '- Git state can change between commands. Re-read `git status`, `HEAD`, and the current branch before Git-sensitive actions or final reporting; a clean tree or autosnapshot commit does not by itself mean the task is finished.',
      '- Let the watcher own routine staging, commits, and pushes. Do not manually stage, commit, push, rewrite history, or disable the watcher unless the user explicitly requests that Git operation.'
    )
  }

  if (env.CODEX_DESKTOP_SELF_HOSTED === '1') {
    const hostPid = env.CODEX_DESKTOP_HOST_PID || 'unknown'
    const parentPid = env.CODEX_DESKTOP_DEV_SERVER_PID || 'unknown'
    const sessionId = env.CODEX_DESKTOP_HOST_SESSION_ID || 'unknown'
    const role = env.CODEX_DESKTOP_INSTANCE_ROLE || 'host'

    guidance.push(
      'Protected Codex Desktop host session:',
      `- This Codex app-server is running inside Codex Desktop session ${sessionId} (role=${role}, Electron PID=${hostPid}, parent/dev-server PID=${parentPid}).`,
      '- Treat the Electron PID, its parent/dev-server PID, and their process tree as protected infrastructure for the current conversation.',
      '- Never signal, terminate, restart, replace, or run a competing dev server against that protected process tree, including through kill, pkill, killall, taskkill, app.quit, Alt+F4, or window-close automation.',
      '- Building and static tests are safe. For restart or lifecycle verification, use `npm run verify:app`, which launches a visibly labeled disposable instance with isolated user data.',
      '- Do not run `npm run dev` or `npm run dev:app` for verification while CODEX_DESKTOP_SELF_HOSTED=1. If a disposable instance cannot be used, preserve the host and report that live restart verification was skipped.'
    )
  }

  return guidance.join('\n')
}

// Note on compaction: `compact_prompt` exists in codex config but only feeds
// the LOCAL compaction path, and codex routes every OpenAI/Azure provider to
// REMOTE (server-side) compaction unconditionally (model-provider-info
// `supports_remote_compaction`). On this app's setup the custom prompt would
// never run — remote compaction keeps user/developer/system messages plus an
// encrypted server summary, and is not client-customizable.

export const newThreadConfig = {
  web_search: 'disabled'
}

export const legacyResumeConfig = {
  tools: {
    web_search: {
      context_size: 'low'
    }
  }
}

export function resolveTurnPolicy(
  text: string,
  options: {
    fastMode?: boolean
    requestedEffort?: ReasoningEffort | null
    supportedEfforts?: ReasoningEffort[]
  } = {}
): { summary: 'concise'; effort?: ReasoningEffort } {
  const supported = new Set(options.supportedEfforts ?? [])
  const fastEffort = (options.fastMode || isReadOnlyBrowserMicrotask(text)) && isFastPathTask(text)
    ? (supported.has('low') ? 'low' : supported.has('minimal') ? 'minimal' : undefined)
    : undefined

  return {
    // Concise summaries cut visible dialogue and summary tokens without
    // lowering the model's actual reasoning effort. Full reasoning remains in
    // the trace payload for people who need to inspect it.
    summary: 'concise',
    ...(fastEffort && fastEffort !== options.requestedEffort ? { effort: fastEffort } : {})
  }
}

export function isFastPathTask(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized || normalized.length > 360) return false
  if (/\b(audit|analy[sz]e|build|compare|debug|design|fix|implement|investigate|migrate|plan|refactor|research|review|security|test)\b/.test(normalized)) {
    return false
  }
  return /^(?:can you |please )?(?:check|go to|list|navigate(?: to)?|open|read|show|visit)\b/.test(normalized)
}

export function isInteractiveBrowserTask(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  const browserAction = /\b(check|go to|navigate|open|read|show|visit|click|fill|select|submit)\b/.test(normalized)
  const accountState = /\b(my|account|dashboard|inbox|notifications?|messages?|unread|logged[ -]in|current tab|this (?:page|tab))\b/.test(normalized)
  return browserAction && accountState
}

export function isReadOnlyBrowserMicrotask(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!isFastPathTask(text)) return false
  if (/\b(click|fill|type|select|submit|send|post|comment|upload|download|buy|purchase|delete|remove|mark|archive|log[ -]?in|sign[ -]?in)\b/.test(normalized)) {
    return false
  }
  const directNavigation = /^(?:can you |please |ok )?(?:go to|navigate(?: to)?|visit)\b/.test(normalized)
  const browserObject = /https?:\/\/|\b(?:browser|tab|website|webpage|web page|notifications?|inbox|dashboard|reddit|github|gmail|youtube)\b|\b[a-z0-9-]+\.(?:com|org|net|io|dev)\b/.test(normalized)
  return directNavigation || browserObject
}

export function isWebResearchTask(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (/https?:\/\//.test(normalized)) return true

  const publicEvidenceRequest =
    /\b(research|search online|find online|public sources?|citations?|news|pricing|customer reviews?|user reviews?|forums?|release notes?|compare|comparison)\b/.test(normalized)
  if (isInteractiveBrowserTask(text) && !publicEvidenceRequest) return false

  const explicitWebAction =
    /\b(search|research|browse|look up|find online|search online|on the web|from the web|web search)\b/.test(normalized)
  const publicSource =
    /\b(official (docs?|documentation)|public sources?|online sources?|citations?|news|pricing|forums?|customer reviews?|user reviews?|app store reviews?|release notes?|website|webpage|web page)\b/.test(normalized)
  const freshnessRequirement = /\b(current|currently|latest|recent|today|this week|this month|this year|up[- ]to[- ]date)\b/.test(normalized)

  return explicitWebAction || publicSource || /\breddit\b/.test(normalized) ||
    (freshnessRequirement && /\b(find|check|verify|compare|price|version|release)\b/.test(normalized))
}

export function shouldAttachPriorChatMemory(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return false

  return (
    /^(let'?s\s+)?(continue|resume|carry on|keep going|pick (?:it|this|that) back up)\b/.test(normalized) ||
    /\b(previous|prior|last) (chat|thread|conversation|session|work)\b/.test(normalized) ||
    /\b(where (?:did|were) we|what were we doing|same as before|from where we left off|left off)\b/.test(normalized)
  )
}

export function selectTurnSkills(text: string, skills: SkillMetadata[]): SkillMetadata[] {
  const normalized = text.trim().toLowerCase()
  const webResearchTask = isWebResearchTask(text)
  const polishedUiTask =
    /\b(build|create|design|redesign|prototype|implement|improve|polish|match|make)\b/.test(normalized) &&
    /\b(ui|ux|frontend|front-end|landing page|dashboard|component|responsive|visual design|user interface|web app|website)\b/.test(normalized)
  const mediaLedUiTask = polishedUiTask &&
    /\b(landing page|website|marketing|brand|shop|store|restaurant|cafe|coffee|hotel|travel|fashion|beauty|food|product page|portfolio|editorial|event)\b/.test(normalized)

  return skills.filter((skill) => {
    if (normalized.includes(`$${skill.name.toLowerCase()}`)) {
      return true
    }

    if (skill.name === 'artifact-first-web-research') {
      return webResearchTask
    }

    if (skill.name === 'imagegen') {
      return mediaLedUiTask
    }

    return skill.name === 'build-polished-ui' && polishedUiTask
  })
}

export function selectNewThreadSkills(text: string, skills: SkillMetadata[]): SkillMetadata[] {
  if (!shouldAttachPriorChatMemory(text)) return []
  return skills.filter((skill) => skill.name === 'prior-chat-memory')
}

export function formatSkillInvocationText(text: string, skills: SkillMetadata[]): string {
  const normalized = text.toLowerCase()
  const missingMarkers = skills
    .map((skill) => `$${skill.name}`)
    .filter((marker) => !normalized.includes(marker.toLowerCase()))

  return missingMarkers.length > 0 ? `${missingMarkers.join(' ')}\n${text}` : text
}

const browserRunSchema = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'JavaScript program. Top-level return and await are supported.' },
    tab: { type: 'string', description: 'Optional tab or popup target id. Defaults to the active visible tab; use all to run the program across every live target in parallel.' },
    frame: { type: 'string', description: 'Optional frame target. Defaults to main; use all to run the same program across every live frame in parallel, or pass a frameId returned by an all-frame run.' },
    timeoutMs: { type: 'number', description: 'Optional timeout from 250 to 60000 milliseconds.' },
    maxResultChars: { type: 'number', description: 'Optional serialized result limit from 1000 to 100000 characters. Oversized default results are kept as JSON artifacts with a compact preview returned to the model.' }
  },
  required: ['code'],
  additionalProperties: false
}

const browserNavigateSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'URL or normal browser navigation input for the existing visible tab.' },
    tab: { type: 'string', description: 'Optional existing tab id. Defaults to the active visible tab; `all` is not supported for navigation.' },
    readySelector: { type: 'string', description: 'Optional CSS selector that marks the requested page state as ready. Prefer this to waiting for network idleness on interactive sites.' },
    timeoutMs: { type: 'number', description: 'Optional navigation timeout from 250 to 60000 milliseconds.' },
    quietMs: { type: 'number', description: 'Optional DOM-quiet window after readiness. Defaults to 350 milliseconds.' },
    maxSettleMs: { type: 'number', description: 'Optional maximum DOM-settle time after document readiness. Defaults to 3000 milliseconds.' }
  },
  required: ['url'],
  additionalProperties: false
}

const browserCdpSchema = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: ['command', 'capabilities', 'events', 'wait', 'traceStart', 'traceStop', 'snapshot', 'networkStart', 'network', 'networkBody', 'networkStop', 'performanceStart', 'performance', 'performanceStop'],
      description: 'Defaults to command. Use capabilities/events/wait for raw protocol inspection, traceStart/traceStop for a trace artifact, snapshot for a compact DOM model, networkStart/network/networkBody/networkStop for task-scoped network diagnostics, or performanceStart/performance/performanceStop for rated runtime, navigation, lifecycle, Web Vitals, interaction, long-task, and trace-escalation diagnostics.'
    },
    method: { type: 'string', description: 'CDP command for operation command, or exact event name for events/wait, such as Page.captureScreenshot or Network.responseReceived.' },
    requestId: { type: 'string', description: 'Network request id for operation networkBody. The request must still be present in the bounded journal.' },
    params: { type: 'object', description: 'Operation parameters. For network, supports limit, urlContains, resourceType, statusMin, statusMax, and failedOnly. Trace, raw snapshot, and response-body output are artifact-backed.' },
    filter: { type: 'object', description: 'Optional nested exact-match filter for events/wait, such as {"name":"networkIdle"}.' },
    contains: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional dot-path substring filter for events/wait, such as {"response.url":"/api/"}.' },
    afterSequence: { type: 'number', description: 'For events/wait, return only events newer than this journal sequence.' },
    limit: { type: 'number', description: 'For events, maximum matching records from 1 to 100; defaults to 30.' },
    tab: { type: 'string', description: 'Optional tab id. Defaults to the active visible tab; pass an explicit id for deterministic network or performance diagnostics.' },
    timeoutMs: { type: 'number', description: 'Optional timeout from 250 to 60000 milliseconds.' },
    maxResultChars: { type: 'number', description: 'Optional serialized result limit from 1000 to 100000 characters.' }
  },
  additionalProperties: false
}

const browserExtractPageSchema = {
  type: 'object',
  properties: {
    tab: { type: 'string', description: 'Optional tab id. Defaults to the active visible tab.' },
    frame: { type: 'string', description: 'Optional frame target: main, all, or a frameId returned by browser_run.' },
    timeoutMs: { type: 'number', description: 'Optional extraction timeout from 250 to 60000 milliseconds.' },
    maxResultChars: { type: 'number', description: 'Optional extracted content limit from 1000 to 100000 characters.' }
  },
  additionalProperties: false
}

const browserScreenshotSchema = {
  type: 'object',
  properties: {
    tab: { type: 'string', description: 'Optional tab id. Defaults to this thread\'s visible browser tab.' }
  },
  additionalProperties: false
}

const uiReviewSchema = {
  type: 'object',
  properties: {
    tab: { type: 'string', description: 'Optional tab id. Defaults to the active visible tab.' },
    viewports: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
      description: 'Responsive viewports to capture and audit. Defaults to desktop, tablet, and mobile.'
    }
  },
  additionalProperties: false
}

const researchWebSchema = {
  type: 'object',
  properties: {
    queries: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { type: 'string' },
      description: 'One primary discovery query, optionally followed by up to two fallback source lanes. Fallbacks run only if the verified-page target is not met.'
    },
    urls: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: { type: 'string' },
      description: 'Optional known public HTTP(S) source URLs. Direct sources are verified before search discovery, so exact official pages can bypass the SERP.'
    },
    focus: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      description: 'Optional evidence needs. The tool returns bounded exact passage windows and explicit coverage gaps for each item.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short stable identifier for this evidence need.' },
          need: { type: 'string', description: 'Concrete claim, field, or evidence to locate in the saved sources.' },
          minSources: { type: 'number', minimum: 1, maximum: 3, description: 'Distinct matching source target. Defaults to 1; the model must still judge source independence.' }
        },
        required: ['id', 'need'],
        additionalProperties: false
      }
    },
    maxResults: { type: 'number', minimum: 1, maximum: 10, description: 'Optional SERP candidates per query, from 1 to 10.' },
    maxPages: { type: 'number', minimum: 1, maximum: 3, description: 'Verified-page target, from 1 to 3. Defaults to the focus/direct-source need when supplied, otherwise 3.' },
    maxAttempts: { type: 'number', minimum: 1, maximum: 8, description: 'Optional candidate-attempt ceiling, from 1 to 8. Defaults to 6 and stops early when maxPages is met.' },
    snippetChars: { type: 'number', minimum: 1_000, maximum: 8_000, description: 'Optional total returned evidence-passage budget, from 1000 to 8000 characters. Saved text uses a separate larger artifact bound.' }
  },
  anyOf: [{ required: ['queries'] }, { required: ['urls'] }],
  additionalProperties: false
}

export const browserDynamicTools: DynamicToolSpec[] = [
  {
    type: 'function',
    name: 'browser_navigate',
    description: 'Navigate one existing visible browser tab and return as soon as the requested DOM state is usable. Use before browser_run when changing pages; provide readySelector for interactive or authenticated pages instead of waiting for network idle.',
    inputSchema: browserNavigateSchema
  },
  {
    type: 'function',
    name: 'browser_screenshot',
    description: 'Capture the visible viewport of this thread\'s browser tab and view it directly. Returns the screenshot to the model as an image plus compact artifact metadata.',
    inputSchema: browserScreenshotSchema
  },
  {
    type: 'function',
    name: 'ui_review',
    description: 'Capture desktop, tablet, and mobile screenshots for model vision while auditing overflow, clipped content, headings, landmarks, touch targets, images, fonts, runtime exceptions, and failed requests. Restores normal viewport emulation afterward.',
    inputSchema: uiReviewSchema
  },
  {
    type: 'function',
    name: 'browser_run',
    description: 'Run a batched JavaScript program in a visible browser target. Inspect, act, wait, and verify in one call. Use tab or frame all for parallel target/frame execution; return compact JSON. Page-origin CORS rules apply within each frame.',
    inputSchema: browserRunSchema
  },
  {
    type: 'function',
    name: 'browser_extract_page',
    description: 'Extract bounded useful text from one visible page after verifying it is real content rather than an empty shell, login wall, or challenge page.',
    inputSchema: browserExtractPageSchema
  },
  {
    type: 'function',
    name: 'browser_cdp',
    description: 'Use the live Chrome DevTools Protocol for a browser tab. Send a targeted command, inspect protocol capabilities, read a bounded event journal, prepare and wait for lifecycle/network/runtime/log events, save a streamed Chromium trace, or capture a raw DOM snapshot with a compact interaction model.',
    inputSchema: browserCdpSchema
  },
  {
    type: 'function',
    name: 'research_web',
    description: 'Verify direct public URLs or adaptively discover, rank, and save up to three public web pages. Uses a bounded inert static-HTML lane before Chromium fallback. With focus items, returns exact evidence passages and coverage gaps alongside full-text artifact paths. Does not create or navigate a visible tab.',
    inputSchema: researchWebSchema
  }
]
