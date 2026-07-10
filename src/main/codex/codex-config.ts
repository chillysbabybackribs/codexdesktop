import type { DynamicToolSpec } from '../../shared/codex-protocol/v2/DynamicToolSpec.js'
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js'

const taskShapingGuidance = [
  'Codex Desktop task-shaping guidance:',
  '- Start by organizing the task in the visible reasoning or plan stream before tool use when the task benefits from planning.',
  '- Decide whether a formal plan is necessary. For trivial tasks, briefly note the direct path and proceed.',
  '- For non-trivial tasks, reason about the goal, available tools, needed context, efficient execution order, and verification before acting.',
  '- Keep the plan updated when observations from tools change the best path.',
  '- For short factual, current, comparison, or review questions, skip a formal plan and use a compact research pass.',
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

export function resolveTurnPolicy(text: string): { effort?: string; summary: 'auto' | 'concise' } {
  const normalized = text.trim().toLowerCase()
  const wordCount = normalized ? normalized.split(/\s+/).length : 0
  const implementationTask = /\b(implement|fix|refactor|debug|edit|modify|build|test|audit|codebase|repository|repo)\b/.test(normalized)
  const researchTask = /\b(current|latest|review|compare|research|pricing|news|sources|overall|what is|who is|when is)\b/.test(normalized)

  if (wordCount <= 80 && researchTask && !implementationTask) {
    return { effort: 'low', summary: 'concise' }
  }

  return { summary: 'auto' }
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

export const browserDynamicTools: DynamicToolSpec[] = [
  {
    type: 'function',
    name: 'browser_run',
    description: 'Run a batched JavaScript program in a visible browser tab. Inspect, act, wait, and verify in one call; return compact JSON.',
    inputSchema: browserRunSchema
  },
  {
    type: 'function',
    name: 'browser_cdp',
    description: 'Send a targeted Chrome DevTools Protocol command to a browser tab through the shared per-tab operation queue. Use CDP directly for network, lifecycle, DOM snapshots, screenshots, input, storage, runtime, and other browser primitives.',
    inputSchema: browserCdpSchema
  }
]
