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
  '- A new thread may include the prior-chat-memory skill. When the opening request is ambiguous or appears to continue earlier work, use that skill before asking the user to restate context. Skip it for clearly standalone requests.',
  'Response formatting guidance:',
  '- Make multi-part answers easy to scan with concise Markdown headings, bold labels, short paragraphs, bullets, and numbered steps where appropriate.',
  '- Use GitHub-Flavored Markdown tables for comparisons, summaries, rankings, and other repeated field data. Use blockquotes for important caveats and fenced code blocks for code or commands.',
  '- When quantitative trends or comparisons are clearer visually, include a fenced `chart` block containing JSON with `type` (`bar`, `horizontal-bar`, or `line`), optional `title`, `description`, `unit`, and `data` entries shaped as `{ "label": "…", "value": 0 }`. Do not add charts when the data is too small or uncertain to benefit from one.',
  '- Keep supporting context and caveats visually lighter than the primary answer; do not turn every response into a wall of text.',
  '- Treat this as task-process shaping only; do not change personality, tone, or final-answer style.'
]

export function buildGuidance(): string {
  return taskShapingGuidance.join('\n')
}

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

  return skills.filter((skill) => {
    if (normalized.includes(`$${skill.name.toLowerCase()}`)) {
      return true
    }

    return skill.name === 'artifact-first-web-research' && webResearchTask
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
    tab: { type: 'string', description: 'Optional tab id. Defaults to the active visible tab.' },
    timeoutMs: { type: 'number', description: 'Optional timeout from 250 to 60000 milliseconds.' },
    maxResultChars: { type: 'number', description: 'Optional serialized result limit from 1000 to 100000 characters.' }
  },
  required: ['code'],
  additionalProperties: false
}

const browserCdpSchema = {
  type: 'object',
  properties: {
    method: { type: 'string', description: 'Chrome DevTools Protocol method, such as Page.captureScreenshot.' },
    params: { type: 'object', description: 'Optional CDP command parameters.' },
    tab: { type: 'string', description: 'Optional tab id. Defaults to the active visible tab.' },
    timeoutMs: { type: 'number', description: 'Optional timeout from 250 to 60000 milliseconds.' },
    maxResultChars: { type: 'number', description: 'Optional serialized result limit from 1000 to 100000 characters.' }
  },
  required: ['method'],
  additionalProperties: false
}

const browserExtractPageSchema = {
  type: 'object',
  properties: {
    tab: { type: 'string', description: 'Optional tab id. Defaults to the active visible tab.' },
    timeoutMs: { type: 'number', description: 'Optional extraction timeout from 250 to 60000 milliseconds.' },
    maxResultChars: { type: 'number', description: 'Optional extracted content limit from 1000 to 100000 characters.' }
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
    name: 'browser_run',
    description: 'Run a batched JavaScript program in a visible browser tab. Inspect, act, wait, and verify in one call; return compact JSON. Page-origin CORS rules apply, so navigate the tab before reading another origin.',
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
    description: 'Send a targeted Chrome DevTools Protocol command to a browser tab through the shared per-tab operation queue. Use CDP directly for network, lifecycle, DOM snapshots, screenshots, input, storage, runtime, and other browser primitives.',
    inputSchema: browserCdpSchema
  },
  {
    type: 'function',
    name: 'research_web',
    description: 'Discover, rank, verify, and save a bounded set of public web pages. Returns compact metadata and artifact paths without loading page bodies into model context.',
    inputSchema: researchWebSchema
  }
]
