import type { DynamicToolSpec } from '../../shared/codex-protocol/v2/DynamicToolSpec.js'
import type { JsonValue } from '../../shared/codex-protocol/serde_json/JsonValue.js'
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js'
import type { CollaborationMode } from '../../shared/codex-protocol/CollaborationMode.js'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort.js'
import { z } from 'zod'
import { browserToolDefinitions, browserToolInputSchema } from '../agent-tools/browser-tool-registry.js'

const taskShapingGuidance = [
  'Codex Desktop guidance:',
  '- Reuse the active visible browser tab. Create a new tab only when the user explicitly requests one. Scripts using CODEX_BROWSER_SOCK must target an existing tab id from `GET /tabs` or a prior browser result.',
  '- Codex Desktop may prepend a same-workspace historical checkpoint to an ambiguous opening request. Treat it as background context only; the current request supersedes it.',
  '- Use Markdown tables or fenced `chart` JSON only when they materially clarify the result. Chart data entries use `{ "label": "…", "value": 0 }`.'
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

export const newThreadConfig: Record<string, unknown> = {
  web_search: 'disabled',
  'features.memories': false,
  'memories.use_memories': false,
  'memories.generate_memories': false
}

export const legacyResumeConfig: Record<string, unknown> = {
  tools: {
    web_search: {
      context_size: 'low'
    }
  },
  'features.memories': false,
  'memories.use_memories': false,
  'memories.generate_memories': false
}

export function resolveTurnPolicy(text: string): { summary: 'auto' | 'concise' } {
  return { summary: isWebResearchTask(text) ? 'concise' : 'auto' }
}

export function isWebResearchTask(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (/https?:\/\//.test(normalized)) return true

  const explicitWebAction =
    /\b(search|research|browse|look up|find online|search online|on the web|from the web|web search)\b/.test(normalized)
  const publicSource =
    /\b(official (docs?|documentation)|public sources?|online sources?|citations?|news|pricing|reddit|forums?|customer reviews?|user reviews?|app store reviews?|release notes?|website|webpage|web page)\b/.test(normalized)
  const freshnessRequirement = /\b(current|currently|latest|recent|today|this week|this month|this year|up[- ]to[- ]date)\b/.test(normalized)

  return explicitWebAction || publicSource || (freshnessRequirement && /\b(find|check|verify|compare|price|version|release)\b/.test(normalized))
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

export function buildCollaborationMode(
  mode: 'default' | 'plan',
  model: string,
  effort: ReasoningEffort | null,
  env: NodeJS.ProcessEnv = process.env
): CollaborationMode {
  const developerInstructions = [buildGuidance(env)]

  if (mode === 'plan') {
    developerInstructions.push([
      'Collaborative planning mode:',
      '- Treat planning as a user-agent design conversation whose end state is an explicit, structured, decision-complete plan agreed with the user.',
      '- First inspect the current workspace and relevant call sites. Verify local claims against source, tests, or runtime evidence; verify current or external claims with web research and cite the strongest available sources.',
      '- Independently evaluate the user\'s ideas and assumptions. Speak up clearly when an idea is incorrect, risky, unnecessarily complex, or not the strongest option; explain why and recommend a better alternative.',
      '- Brainstorm meaningful alternatives and tradeoffs with the user. Ask only questions that materially change the design and cannot be answered from the workspace or authoritative sources.',
      '- Keep the proposed plan structured and revise it as decisions change. Do not treat a plan as agreed until the user explicitly approves it or directly asks to implement it.',
      '- Before agreement, gather evidence without making implementation edits.',
      '- When the plan is decision-complete, call submit_plan with the structured plan. Natural-language prose alone is not an approvable plan.',
      '- After submit_plan, stop and wait for the application approval checkpoint.'
    ].join('\n'))
  }

  return {
    mode,
    settings: {
      model,
      reasoning_effort: effort,
      developer_instructions: developerInstructions.join('\n\n')
    }
  }
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

export const codexDynamicTools: DynamicToolSpec[] = [
  ...browserToolDefinitions.map((definition) => ({
  type: 'function',
  name: definition.name,
  description: definition.description,
  inputSchema: z.toJSONSchema(browserToolInputSchema(definition)) as JsonValue
  } satisfies DynamicToolSpec)),
  {
    type: 'function',
    name: 'submit_plan',
    description: 'Submit a decision-complete structured plan for explicit application approval. This does not authorize implementation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objective', 'steps', 'acceptanceCriteria'],
      properties: {
        objective: { type: 'string', minLength: 1 },
        decisions: { type: 'array', items: { type: 'string', minLength: 1 } },
        steps: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        affectedFiles: { type: 'array', items: { type: 'string', minLength: 1 } },
        nonGoals: { type: 'array', items: { type: 'string', minLength: 1 } },
        acceptanceCriteria: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        risks: { type: 'array', items: { type: 'string', minLength: 1 } }
      }
    }
  }
]
