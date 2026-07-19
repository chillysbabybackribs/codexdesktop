import { dockRoleOf, type AgentLiteMessage, type AgentSession } from './agent-session-model.js'
import type { Model } from '../../shared/session-protocol'

// Conversational prompt intake for a paired main chat (beginning-phase
// supervision; docs/prompt-intake-2026-07-19.md).
//
// When a Reviewer is docked and the user opens a fresh thread, the first send
// becomes a restatement turn: the doer acknowledges the request, names its
// reviewer, and restates its understanding — no tools, no work. The user's
// natural-language reply ("yes start", a refinement, a question) is the only
// control surface: it first fetches a plan from the standing reviewer's own
// thread, then starts the doer on it. No buttons anywhere.
//
// Everything model-facing travels as marker blocks appended to the user's
// verbatim text and stripped from display — the same convention as injected
// memory and mention context.

export type IntakePhase = 'awaitingConfirmation' | 'planning'

export type IntakeState = {
  phase: IntakePhase
  // Bound once the restatement turn's thread exists. A mismatch with the
  // active thread means the user switched or reset chats mid-protocol — the
  // pending confirmation targets a conversation that is no longer on screen.
  threadId: string | null
  // The verbatim first prompt; the plan briefing quotes it.
  original: string
}

const INSTRUCTION_OPEN = '<codexdesktop-intake-instruction>'
const INSTRUCTION_CLOSE = '</codexdesktop-intake-instruction>'
const PLAN_OPEN = '<codexdesktop-reviewer-plan>'
const PLAN_CLOSE = '</codexdesktop-reviewer-plan>'

export const NO_PLAN_SENTINEL = 'NO-PLAN'

const INSTRUCTION_BLOCK = new RegExp(`\\n*${INSTRUCTION_OPEN}[\\s\\S]*?${INSTRUCTION_CLOSE}[ \\t]*\\n?`, 'g')
const PLAN_BLOCK = new RegExp(`\\n*${PLAN_OPEN}[\\s\\S]*?${PLAN_CLOSE}[ \\t]*\\n?`, 'g')

// The intake pairing signal: a Reviewer-role dock agent owned by this tab.
// Workers and Helpers do not arm the protocol.
export function pickIntakeReviewer(
  sessions: AgentSession[],
  mainChatTabKey: string | null
): AgentSession | null {
  return (
    sessions.find(
      (session) => session.mainChatTabKey === mainChatTabKey && dockRoleOf(session) === 'reviewer'
    ) ?? null
  )
}

// "Reviewer (Claude Opus 4.8)" — the card title plus the resolved model
// display name, so the doer can acknowledge its reviewer by name.
export function reviewerDisplayLabel(reviewer: AgentSession | null, models: Model[]): string {
  if (!reviewer) return 'your reviewer'
  const model = reviewer.model ? models.find((entry) => entry.id === reviewer.model) : undefined
  const name = model?.displayName ?? reviewer.model
  return name ? `${reviewer.title} (${name})` : reviewer.title
}

export function buildRestateInjection(reviewerLabel: string): string {
  return [
    '',
    '',
    INSTRUCTION_OPEN,
    `A reviewer agent — ${reviewerLabel} — is paired with this chat. It will write the working plan once the user confirms, and it audits your work as you go.`,
    'Do NOT begin the task and do NOT use any tools in this reply.',
    'In a few short sentences: acknowledge the request, mention your reviewer by name, and restate in plain language exactly what you understand the user is asking for. Surface any assumption you are making and any ambiguity you notice.',
    'Close by asking the user to confirm (a simple "yes, start" works) or refine the request.',
    INSTRUCTION_CLOSE,
  ].join('\n')
}

export function buildPlanBriefing(input: {
  original: string
  restatement: string
  reply: string
  doerLabel: string
}): string {
  return [
    `You are the planning reviewer paired with a main chat whose doer model is ${input.doerLabel}.`,
    '',
    'The user opened this task:',
    '<user-request>',
    input.original,
    '</user-request>',
    '',
    'The doer restated its understanding as:',
    '<doer-restatement>',
    input.restatement,
    '</doer-restatement>',
    '',
    'The user just replied (confirming or refining):',
    '<user-reply>',
    input.reply,
    '</user-reply>',
    '',
    `If the reply does not authorize starting — the user declined, paused, or asked a question instead — reply with exactly ${NO_PLAN_SENTINEL} on the first line, then one sentence explaining why.`,
    '',
    'Otherwise write the working plan the doer will execute, folding in any refinement from the reply. Concise and concrete:',
    '- numbered steps in execution order (at most 10)',
    '- key files or areas to touch, when identifiable',
    '- explicit done-criteria',
    '- the main risk or trap, in one line',
    'The doer executes this plan and you will audit its work against it afterwards — write the plan you are prepared to hold it to.',
  ].join('\n')
}

export function buildExecutionInjection(plan: string | null, reviewerLabel: string): string {
  if (plan) {
    return [
      '',
      '',
      PLAN_OPEN,
      `Your reviewer — ${reviewerLabel} — prepared this plan for the confirmed task. Execute it where it serves the user's goal; deviate when reality contradicts it, and say so when you do. Begin now.`,
      '',
      plan,
      PLAN_CLOSE,
    ].join('\n')
  }
  return [
    '',
    '',
    INSTRUCTION_OPEN,
    'Your paired reviewer could not produce a plan in time. The user has confirmed the task — begin now on your own judgment.',
    INSTRUCTION_CLOSE,
  ].join('\n')
}

export function buildDeclinedInjection(reason: string): string {
  return [
    '',
    '',
    INSTRUCTION_OPEN,
    `Your reviewer read this reply as not authorizing a start${reason ? `: ${reason}` : '.'}`,
    'Do not begin the task. Reply conversationally and ask how the user wants to proceed.',
    INSTRUCTION_CLOSE,
  ].join('\n')
}

// Display-side strip: the transcript shows the user's verbatim words; the
// protocol blocks are model-facing only.
export function stripIntakeInjections(text: string): string {
  return text.replace(INSTRUCTION_BLOCK, '').replace(PLAN_BLOCK, '')
}

export function isNoPlan(text: string): boolean {
  return text.trim().toUpperCase().startsWith(NO_PLAN_SENTINEL)
}

export function noPlanReason(text: string): string {
  return text
    .trim()
    .slice(NO_PLAN_SENTINEL.length)
    .replace(/^[\s:—–-]+/, '')
    .trim()
}

// The reviewer's answer to the latest briefing: the final assistant message
// after the last user message. Null while the reply is still pending (the
// latest message is the briefing itself) — callers keep polling on null.
export function latestAssistantText(messages: AgentLiteMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user') return null
    if (message.text.trim()) return message.text.trim()
  }
  return null
}

// The doer's restatement at confirmation time: the last agent message in the
// main transcript.
export function lastAgentMessageText(items: Array<{ type: string; text?: string }>): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.type === 'agentMessage' && item.text && item.text.trim()) return item.text.trim()
  }
  return null
}
