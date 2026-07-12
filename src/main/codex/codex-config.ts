import type { DynamicToolSpec } from '../../shared/codex-protocol/v2/DynamicToolSpec.js'
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js'

const taskShapingGuidance = [
  'Codex Desktop task-shaping guidance:',
  '- Start by organizing the task in the visible reasoning or plan stream before tool use when the task benefits from planning.',
  '- Decide whether a formal plan is necessary. For trivial tasks, briefly note the direct path and proceed.',
  '- For non-trivial tasks, reason about the goal, available tools, needed context, efficient execution order, and verification before acting.',
  '- Keep the plan updated when observations from tools change the best path.',
  '- For short factual, current, comparison, or review questions, skip a formal plan and use a compact research pass.',
  '- For public web research, use research_web for bounded discovery and saved page artifacts, then inspect only targeted passages from those artifacts.',
  '- Use browser_run for interactive or authenticated page state and browser_extract_page for one visible page. Do not dump full page bodies into model context.',
  '- Browser tools default to the currently active visible tab because that is usually the tab the user is referencing. Reuse it unless the user explicitly asks for a new tab; never create a tab merely because a browser tool was called. Pass an explicit `tab` only to target another existing tab. Scripts using CODEX_BROWSER_SOCK must pass an explicit tab id read from `GET /tabs` or a prior browser result, and may create a tab only when the user explicitly requested one.',
  '- A new thread may include the prior-chat-memory skill. When the opening request is ambiguous or appears to continue earlier work, use that skill before asking the user to restate context. Skip it for clearly standalone requests.',
  'Response formatting guidance:',
  '- Make multi-part answers easy to scan with concise Markdown headings, bold labels, short paragraphs, bullets, and numbered steps where appropriate.',
  '- Use GitHub-Flavored Markdown tables for comparisons, summaries, rankings, and other repeated field data. Use blockquotes for important caveats and fenced code blocks for code or commands.',
  '- When quantitative trends or comparisons are clearer visually, include a fenced `chart` block containing JSON with `type` (`bar`, `horizontal-bar`, or `line`), optional `title`, `description`, `unit`, and `data` entries shaped as `{ "label": "…", "value": 0 }`. Do not add charts when the data is too small or uncertain to benefit from one.',
  '- Keep supporting context and caveats visually lighter than the primary answer; do not turn every response into a wall of text.',
  '- Treat this as task-process shaping only; do not change personality, tone, or final-answer style.'
]

export function buildGuidance(env: NodeJS.ProcessEnv = process.env): string {
  const guidance = [...taskShapingGuidance]

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

export function resolveTurnPolicy(text: string): { summary: 'auto' | 'concise' } {
  const normalized = text.trim().toLowerCase()
  const researchTask = /\b(current|latest|review|compare|research|pricing|news|sources|overall|what is|who is|when is)\b/.test(normalized)

  return { summary: researchTask ? 'concise' : 'auto' }
}

export function selectTurnSkills(text: string, skills: SkillMetadata[]): SkillMetadata[] {
  const normalized = text.trim().toLowerCase()
  const webResearchTask =
    /https?:\/\//.test(normalized) ||
    /\b(search|research|browse|look up|find online|on the web|website|webpage|web page|source|sources|citation|citations|current|latest|news|pricing|reddit|forum|reviews?|compare|comparison)\b/.test(normalized)
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

export function selectNewThreadSkills(skills: SkillMetadata[]): SkillMetadata[] {
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
    maxResultChars: { type: 'number', description: 'Optional serialized result limit from 1000 to 100000 characters.' }
  },
  required: ['code'],
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
      description: 'One to three focused discovery queries covering the strongest relevant source lanes.'
    },
    maxResults: { type: 'number', description: 'Optional SERP candidates per query, from 1 to 10.' },
    maxPages: { type: 'number', description: 'Optional verified pages to save, from 1 to 8. Defaults to 3.' },
    snippetChars: { type: 'number', description: 'Optional cleaned text saved per page, from 1000 to 8000 characters.' }
  },
  required: ['queries'],
  additionalProperties: false
}

export const browserDynamicTools: DynamicToolSpec[] = [
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
    description: 'Discover, rank, verify, and save a bounded set of public web pages. Returns compact metadata and artifact paths without loading page bodies into model context.',
    inputSchema: researchWebSchema
  }
]
