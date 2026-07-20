import type { DynamicToolSpec } from '../../shared/codex-protocol/v2/DynamicToolSpec.js'
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort.js'
import { buildBrowserUseGuidance } from '../browser/browser-use-policy.js'

const taskShapingGuidance = [
  'Codex Desktop guidance:',
  '- Reuse the active visible browser tab. Create a new tab only when the user explicitly requests one. Scripts using CODEX_BROWSER_SOCK must target an existing tab id from `GET /tabs` or a prior browser result.',
  '- For browser work, wait for the requested DOM state rather than network idle or a fixed sleep. Modern sites often keep background requests open after their useful content is ready.',
  '- For simple browser reads, prefer one `browser_snapshot` call; state every requested field and list count in its objective. If a snapshot reports `completion.nextAction: "answer"`, answer from it directly. If it reports `targeted-gap-fill`, resolve only the named gaps with the least-specialized browser tool. Use `browser_flow` for common fill/click/submit interactions that may navigate, and reserve `browser_run` for bespoke JavaScript in one stable document.',
  '- When reviewing or editing Codex Desktop\'s own UI in a live dev session, use `app_screenshot` for the full Electron window (chat plus embedded browser). Use `browser_screenshot` for page content inside the browser tab only.',
  '- When calling `app_screenshot` or `browser_screenshot` from `functions.exec`, only pass the result to `image()` when it is a string beginning with `data:image/`. A failed capture returns error text; forwarding that text as an image creates an invalid `image_url` and poisons later turns.',
  '- For a simple visual confirmation of the current app UI, take one `app_screenshot`, let its artifact preview remain visible in chat, and answer directly. Do not load skills, prior-chat memory, source files, or an additional image viewer unless the user asks for analysis or a change.',
  '- For ambiguous opening requests that may continue earlier work, use the prior-chat-memory skill before asking the user to restate context. Skip it for clearly standalone requests.',
  '- Use Markdown tables or fenced `chart` JSON only when they materially clarify the result. Chart data entries use `{ "label": "…", "value": 0 }`.',
  '- While working, narrate sparingly: at most one short line per phase stating the user-visible goal. Never mention tool names, injected markers, internal mechanics, or repeat an unchanged status; the final answer carries the detail.'
]

export function buildGuidance(env: NodeJS.ProcessEnv = process.env): string {
  const guidance = [...taskShapingGuidance]

  guidance.push(buildBrowserUseGuidance(env))

  if (env.CODEX_DESKTOP_AUTOGIT_ACTIVE === '1') {
    const repoRoot = env.CODEX_DESKTOP_AUTOGIT_ROOT || 'the Codex Desktop source checkout'
    const targetBranch = env.CODEX_DESKTOP_AUTOGIT_TARGET_BRANCH || 'master'
    const pushBehavior = env.CODEX_DESKTOP_AUTOGIT_PUSH_ENABLED === '1'
      ? ` and then pushes each autosnapshot to \`origin/${targetBranch}\``
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
  const browserMicrotask = isReadOnlyBrowserMicrotask(text) && isFastPathTask(text)
  const lightweightVisualCheck = isLightweightVisualCheck(text)
  const fastEffort = browserMicrotask || lightweightVisualCheck
    ? (supported.has('none') ? 'none' : supported.has('low') ? 'low' : supported.has('minimal') ? 'minimal' : undefined)
    : options.fastMode && isFastPathTask(text)
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
  if (/\b(audit|analy[sz]e|build|compare|debug|design|fix|implement|investigate|migrate|plan|refactor|research|review|security)\b/.test(normalized)) {
    return false
  }
  if (isLightweightVisualCheck(text)) return true
  return /^(?:(?:can|could|would) you |please |ok )?(?:check|go to|list|navigate(?: to)?|open|read|show|tell me|visit)\b/.test(normalized) ||
    isInteractiveBrowserTask(text)
}

export function isLightweightVisualCheck(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized || normalized.length > 240) return false

  const visualVerb = /^(?:(?:can|could|would) you |please |ok )?(?:view|see|show|look at|inspect)\b/.test(normalized)
  const currentAppSurface = /\b(?:current|live|this)\b[\s\S]{0,48}\b(?:ui|interface|composer|chat|window|screen)\b/.test(normalized)
  return visualVerb && currentAppSurface
}

export function isInteractiveBrowserTask(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  const browserAction = /\b(check|go to|navigate|open|read|show|visit|click|fill|select|submit)\b/.test(normalized)
  const accountState = /\b(my|account|dashboard|inbox|notifications?|messages?|unread|logged[ -]in|current tab|this (?:page|tab))\b/.test(normalized)
  const firstPersonAccountObject = /\b(?:my|mine)\b/.test(normalized) &&
    /\b(?:account|dashboard|inbox|notifications?|messages?|profile|settings?)\b/.test(normalized)
  return (browserAction && accountState) || firstPersonAccountObject
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
  const explicitPublicLane =
    /\b(research(?: online| the web)?|search online|find online|public sources?|online sources?|citations?|on the web|from the web|browse the web|web search)\b/.test(normalized)
  if (isInteractiveBrowserTask(text) && !explicitPublicLane) return false
  if (/https?:\/\//.test(normalized)) return true

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

export function isLiveSiteCloneTask(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return false

  const cloneIntent = /\b(clone|recreate|replicate|mirror)\b/.test(normalized)
  const liveSiteTarget = /https?:\/\//.test(normalized) ||
    /\b(?:this|the|current|existing|live|target)\s+(?:site|website|webpage|web page|page|frontend|front-end)\b/.test(normalized)
  const redesignIntent = /\b(like|better|redesign|improve|inspired by|in the style of)\b/.test(normalized)

  return cloneIntent && liveSiteTarget && !redesignIntent
}

export function selectTurnSkills(text: string, skills: SkillMetadata[]): SkillMetadata[] {
  const normalized = text.trim().toLowerCase()
  const webResearchTask = isWebResearchTask(text)
  const liveSiteCloneTask = isLiveSiteCloneTask(text)
  const liveSiteRedesignTask =
    /\b(like|better|redesign|improve|inspired by|in the style of)\b/.test(normalized) &&
    (/https?:\/\//.test(normalized) || /\b(?:this|the|current|existing|live|target)\s+(?:site|website|webpage|web page|page)\b/.test(normalized))
  const polishedUiTask =
    /\b(build|create|design|redesign|prototype|implement|improve|polish|match|make)\b/.test(normalized) &&
    /\b(ui|ux|frontend|front-end|landing page|dashboard|component|responsive|visual design|user interface|web app|website)\b/.test(normalized)
  const mediaLedUiTask = polishedUiTask &&
    /\b(landing page|website|marketing|brand|shop|store|restaurant|cafe|coffee|hotel|travel|fashion|beauty|food|product page|portfolio|editorial|event)\b/.test(normalized)
  const editorialWaitlistTask = polishedUiTask &&
    /\b(?:editorial[\s-]*(?:style[\s-]*)?waitlist|waitlist[\s-]*(?:landing[\s-]*page[\s-]*)?editorial)\b/.test(normalized)

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

    if (skill.name === 'superdesign-editorial-waitlist') {
      return editorialWaitlistTask
    }

    if (skill.name === 'clone-live-site') {
      return liveSiteCloneTask
    }

    return skill.name === 'build-polished-ui' && (polishedUiTask || liveSiteCloneTask || liveSiteRedesignTask)
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

const browserFlowSchema = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      description: 'Ordered main-frame actions and checks. Use wait for a required containing state; use find for an item that may legitimately be absent.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 120, description: 'Optional unique step label used in results and errors.' },
          type: { type: 'string', enum: ['fill', 'click', 'submit', 'wait', 'find'] },
          selector: { type: 'string', description: 'CSS selector, including descendants of open shadow roots.' },
          value: { type: 'string', description: 'Value for a fill step.' },
          navigation: { type: 'string', enum: ['auto', 'required', 'none'], description: 'Navigation expectation for click or submit. Defaults to auto.' },
          urlContains: { type: 'string', description: 'Required URL substring for a wait step. Use instead of selector.' },
          stableMs: { type: 'number', minimum: 0, maximum: 2000, description: 'How long a wait condition must remain stable. Defaults to 90 ms.' },
          limit: { type: 'number', minimum: 1, maximum: 100, description: 'Maximum structured matches returned by a find step.' },
          onMissing: { type: 'string', enum: ['stop', 'error'], description: 'A find miss returns successful not_found data and stops by default; use error only when presence is required.' }
        },
        required: ['type'],
        additionalProperties: false
      }
    },
    tab: { type: 'string', description: 'Optional existing visible tab id. Defaults to the active tab; `all` is not supported.' },
    timeoutMs: { type: 'number', description: 'Total flow timeout from 250 to 60000 milliseconds.' },
    maxResultChars: { type: 'number', description: 'Optional serialized result limit from 1000 to 100000 characters.' }
  },
  required: ['steps'],
  additionalProperties: false
}

const browserNetworkSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Optional navigation input that triggers the request. Provide exactly one of url or steps.' },
    steps: {
      ...browserFlowSchema.properties.steps,
      description: 'Optional interaction flow that triggers the request. Provide exactly one of url or steps.'
    },
    match: {
      type: 'object',
      description: 'Response matcher. urlContains is required; optional fields narrow HTTP and SSE requests. WebSocket streams support urlContains plus status bounds.',
      properties: {
        urlContains: { type: 'string', description: 'Case-insensitive URL substring required on the matched response.' },
        method: { type: 'string', description: 'Optional exact HTTP method.' },
        resourceType: { type: 'string', description: 'Optional exact CDP resource type such as Fetch or XHR.' },
        mimeType: { type: 'string', description: 'Optional response MIME-type substring.' },
        statusMin: { type: 'number', description: 'Optional minimum HTTP status.' },
        statusMax: { type: 'number', description: 'Optional maximum HTTP status.' }
      },
      required: ['urlContains'],
      additionalProperties: false
    },
    captureBody: { type: 'boolean', description: 'Persist the matched completed response body as an artifact. Defaults to true when stream and download are omitted; cannot be true with either.' },
    download: { type: 'boolean', description: 'Capture a true Chromium download handoff directly as an artifact, bypassing the manual save dialog for this exact call. Uses match.urlContains.' },
    stream: {
      type: 'object',
      description: 'Capture a bounded live stream instead of waiting for a completed response body.',
      properties: {
        transport: { type: 'string', enum: ['sse', 'websocket'], description: 'Native CDP stream transport to capture.' },
        maxMessages: { type: 'number', minimum: 1, maximum: 1000, description: 'Stop after this many messages. Defaults to 50.' },
        idleMs: { type: 'number', minimum: 50, maximum: 10000, description: 'Stop after this much silence following a message. Defaults to 500 ms.' }
      },
      required: ['transport'],
      additionalProperties: false
    },
    readySelector: { type: 'string', description: 'For url triggers, optional selector that marks navigation readiness.' },
    quietMs: { type: 'number', description: 'For url triggers, optional DOM-quiet window after readiness.' },
    maxSettleMs: { type: 'number', description: 'For url triggers, optional maximum DOM-settle time.' },
    tab: { type: 'string', description: 'Optional existing visible tab id. Defaults to the active tab; `all` is not supported.' },
    timeoutMs: { type: 'number', description: 'Total capture timeout from 250 to 60000 milliseconds.' },
    maxResultChars: { type: 'number', description: 'Optional serialized result limit from 1000 to 100000 characters.' }
  },
  required: ['match'],
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

const browserSnapshotSchema = {
  type: 'object',
  properties: {
    objective: {
      type: 'string',
      description: 'Concrete fields, list, or page facts to return. Include requested count and state, such as "latest 3 notifications and whether each is read or unread".'
    },
    url: {
      type: 'string',
      description: 'Optional URL or navigation input. When provided, navigation, readiness, and extraction happen in this one call on the existing tab.'
    },
    tab: { type: 'string', description: 'Optional existing tab id. Defaults to the active visible tab; `all` is not supported.' },
    frame: { type: 'string', description: 'Optional frame target: main, all, or a frameId returned by browser_run.' },
    mode: {
      type: 'string',
      enum: ['task', 'content', 'interactive'],
      description: 'Task returns objective-ranked rows and state (default); content favors article text; interactive favors controls.'
    },
    order: {
      type: 'string',
      enum: ['document', 'reverse-document'],
      description: 'Returned list order. Defaults to document order; use reverse-document only when the page is known to render the desired records last.'
    },
    selector: { type: 'string', description: 'Optional extraction scope container selector. The first matching container is traversed; do not pass a repeated row selector when you need multiple rows.' },
    maxItems: {
      type: 'number',
      minimum: 1,
      maximum: 200,
      description: 'Maximum task items. Set this to the requested list count; otherwise a nearby numeric count in the objective is inferred.'
    },
    readySelector: { type: 'string', description: 'Optional deep selector used to accelerate navigation readiness. A selector miss is reported in `readiness`; a snapshot can still succeed when its requested evidence verifies.' },
    timeoutMs: { type: 'number', description: 'Optional total timeout from 250 to 60000 milliseconds.' },
    quietMs: { type: 'number', description: 'Optional DOM-quiet window after navigation readiness.' },
    maxSettleMs: { type: 'number', description: 'Optional maximum DOM-settle time after document readiness.' },
    maxResultChars: { type: 'number', description: 'Optional structured result limit from 1000 to 100000 characters.' }
  },
  required: ['objective'],
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
    objective: { type: 'string', description: 'Optional extraction objective. When supplied, returns ranked structured task items as well as bounded content.' },
    mode: { type: 'string', enum: ['task', 'content', 'interactive'], description: 'Optional snapshot mode. Defaults to content for compatibility.' },
    order: { type: 'string', enum: ['document', 'reverse-document'], description: 'Optional structured-item order.' },
    selector: { type: 'string', description: 'Optional extraction scope selector, including open-shadow-root descendants.' },
    maxItems: { type: 'number', minimum: 1, maximum: 200, description: 'Optional maximum structured items.' },
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

const appScreenshotSchema = {
  type: 'object',
  properties: {},
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
      maxItems: 6,
      items: { type: 'string' },
      description: 'One to six short search queries authored from the user request, each a single-angle phrase a person would actually type into a search engine. Never stuff one query with every keyword, product, site, and year. Variations run in bounded parallel hidden Chromium workers; a lone query receives a small compatibility expansion.'
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
          need: { type: 'string', description: 'Concrete claim, field, or evidence to locate in the verified sources.' },
          minSources: { type: 'number', minimum: 1, maximum: 6, description: 'Distinct matching source target. Defaults to 1; use only the diversity needed for the claim. The model must still judge source independence.' }
        },
        required: ['id', 'need'],
        additionalProperties: false
      }
    },
    maxResults: { type: 'number', minimum: 1, maximum: 10, description: 'Optional SERP candidates per query, from 1 to 10.' },
    maxAttempts: { type: 'number', minimum: 1, maximum: 24, description: 'Optional candidate-attempt safety ceiling, from 1 to 24. Defaults from the model-authored evidence demand and stops immediately when that evidence is covered.' },
    snippetChars: { type: 'number', minimum: 1_000, maximum: 8_000, description: 'Optional total returned evidence-passage budget, from 1000 to 8000 characters. Page extraction uses a separate internal bound.' }
  },
  anyOf: [{ required: ['queries'] }, { required: ['urls'] }],
  additionalProperties: false
}

const browserLiveSearchSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Backward-compatible primary query. Prefer queries with three to six semantic variations.' },
    queries: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      uniqueItems: true,
      items: { type: 'string' },
      description: 'Three to six short search queries derived from the user request, each a single-angle phrase a person would actually type into a search engine (like "claude desktop high cpu" or "codex cli sandbox complaints reddit"). Never stuff one query with every keyword, product, site, and year. They run in parallel hidden search workers.'
    },
    objective: { type: 'string', description: 'Specific facts or fields to extract after the visible tab navigates directly to the highest-ranked destination page.' },
    tab: { type: 'string', description: 'Explicit existing visible tab id. Defaults to the active visible tab.' },
    background: { type: 'boolean', description: 'Also gather bounded evidence from independent public sources. Set true for quality-max current-information, comparison, conflict, or source-backed research; defaults to false for a quick visible lookup.' },
    focus: researchWebSchema.properties.focus,
    maxResults: { type: 'number', minimum: 1, maximum: 10, description: 'Maximum SERP candidates per hidden query. Defaults to 5.' },
    maxItems: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum structured items to return from the selected destination page. Defaults to 10.' },
    maxAttempts: researchWebSchema.properties.maxAttempts,
    snippetChars: researchWebSchema.properties.snippetChars,
    timeoutMs: { type: 'number', description: 'Optional total timeout from 250 to 60000 milliseconds.' }
  },
  required: ['objective'],
  anyOf: [{ required: ['query'] }, { required: ['queries'] }],
  additionalProperties: false
}

export const browserDynamicTools: DynamicToolSpec[] = [
  {
    type: 'function',
    name: 'browser_live_search',
    description: 'Unified search-to-page path: search three to six model-authored semantic variations in parallel hidden Chromium workers, navigate the existing visible tab on the first viable direct destination, and return its objective-ranked snapshot. Set background=true to gather bounded independent evidence in parallel for quality-max research. Search result pages are never shown. Never creates a tab.',
    inputSchema: browserLiveSearchSchema
  },
  {
    type: 'function',
    name: 'browser_snapshot',
    description: 'Fast read-only browser path: optionally navigate one existing tab directly to a destination URL, wait for a requested DOM state, and return objective-ranked items, structured UI state, exact page evidence, coverage gaps, timings, readiness state, and a completion directive in one call. Search text and SERP URLs are rejected; use browser_live_search for hidden discovery. When `completion.nextAction` is `answer`, format this result directly; when it is `targeted-gap-fill`, retrieve only the named missing evidence. Use a container selector rather than a repeated row selector. Use for lists, inboxes, account state, page fields, and most inspect-only tasks.',
    inputSchema: browserSnapshotSchema
  },
  {
    type: 'function',
    name: 'browser_navigate',
    description: 'Navigate one existing visible browser tab directly to a destination URL and return as soon as the requested DOM state is usable. Search text and SERP URLs are rejected; use browser_live_search for hidden discovery. Use before browser_run when changing pages; provide readySelector for interactive or authenticated pages instead of waiting for network idle.',
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
    name: 'app_screenshot',
    description: 'Capture the full Codex Desktop window, including the chat pane and embedded browser, for model vision. Use when reviewing or iterating on the app UI itself. Returns the screenshot as an image plus compact artifact metadata. Use browser_screenshot for page content inside the browser tab only.',
    inputSchema: appScreenshotSchema
  },
  {
    type: 'function',
    name: 'ui_review',
    description: 'Capture desktop, tablet, and mobile screenshots for model vision while auditing overflow, clipped content, headings, landmarks, touch targets, images, fonts, runtime exceptions, and failed requests. Restores normal viewport emulation afterward.',
    inputSchema: uiReviewSchema
  },
  {
    type: 'function',
    name: 'browser_flow',
    description: 'Run a navigation-aware declarative flow in one visible tab. Fill, click, or submit; use wait for a required page or list state; then use find for a one-shot lookup. A missing find is successful `not_found` data by default, avoiding desired-item polling and page-script exceptions.',
    inputSchema: browserFlowSchema
  },
  {
    type: 'function',
    name: 'browser_network',
    description: 'Capture one exact network result in one model call: start a fresh journal, navigate directly to a destination URL or run an interaction flow, then persist a completed response body, bounded SSE/WebSocket stream, or true Chromium download handoff as an artifact. Search text and SERP URLs are rejected. Use for JSON, GraphQL, XHR/fetch, live model/event streams, and browser downloads.',
    inputSchema: browserNetworkSchema
  },
  {
    type: 'function',
    name: 'browser_run',
    description: 'Run bespoke JavaScript in a stable visible browser document. Top-level return and await are supported. For read-only extraction, explicitly `return` the structured value from the top-level program; an omitted result returns structured `noResult` data. Return expected missing states as data instead of throwing, and end the batch before an action that triggers full or SPA navigation. Use browser_flow for common navigation-aware interactions. Page-origin CORS rules apply within each frame.',
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
    description: 'Verify direct public URLs or adaptively discover and rank the sources needed to cover the model-authored evidence needs. It stops once coverage is complete; an attempt ceiling protects against runaway research. Uses a bounded inert static-HTML lane before Chromium fallback. With focus items, returns exact evidence passages and coverage gaps. Does not create or navigate a visible tab or persist page copies.',
    inputSchema: researchWebSchema
  }
]

const spawnSubagentSchema = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description: 'The complete, self-contained instruction for the subagent. The subagent does NOT see this conversation, so include every fact, path, and constraint it needs. It works in the same workspace directory as you.'
    },
    title: {
      type: 'string',
      description: 'Optional short roster label for the subagent, e.g. "auth refactor" or "summarize package.json". Defaults to a generic worker name.'
    },
    model: {
      type: 'string',
      description: 'Optional model id for the subagent. Defaults to your own model. A different model family (e.g. spawning a Claude worker from a Codex lead, or vice versa) is allowed and useful for an independent perspective.'
    }
  },
  required: ['task'],
  additionalProperties: false
}

const spawnSubagentsParallelSchema = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      description: 'Two or three independent, self-contained tasks to run concurrently behind one gather barrier.',
      items: spawnSubagentSchema
    }
  },
  required: ['tasks'],
  additionalProperties: false
}

// Subagent-spawn tools. Kept in a separate array from browserDynamicTools so
// each surface's tool set reads by intent, but authored in this one file (the
// single schema-authoring point every transport shares). Phase 1 exposes one
// blocking tool: the parent's call runs the child's whole turn and returns its
// final answer as the tool result — the same synchronous shape research_web
// already uses.
export const agentDynamicTools: DynamicToolSpec[] = [
  {
    type: 'function',
    name: 'spawn_subagent',
    description: 'Delegate a self-contained subtask to a fresh subagent and wait for its result. The subagent runs its own full turn in the same workspace with access to the same tools, then returns its final answer to you as this tool\'s result. It does not see your conversation, so make `task` fully self-contained. Use for well-scoped work you want handled independently (research a question, review a diff, draft a file) or to get a second-model perspective. The call blocks until the subagent finishes, so spawn one focused subtask at a time.',
    inputSchema: spawnSubagentSchema
  },
  {
    type: 'function',
    name: 'spawn_subagents_parallel',
    description: 'Run two or three independent subagents concurrently and wait for all results. Use in quality-max work for independent research lanes or a doer plus auditor. Each task must be fully self-contained. The app shows every worker in the Agent Dock and returns a bounded gathered result to the parent.',
    inputSchema: spawnSubagentsParallelSchema
  }
]

// The single list every transport declares to its runtime: browser tools plus
// subagent tools. Consumers (codex thread config, the Claude MCP server, the
// stdio shim) read THIS so a new tool is authored once and appears everywhere.
export const allDynamicTools: DynamicToolSpec[] = [...browserDynamicTools, ...agentDynamicTools]
