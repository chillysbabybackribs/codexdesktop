import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { buildGuidance } from '../codex/codex-config.js'
import {
  claudeBrowserMcpServerName,
  claudeBrowserToolNames,
  createClaudeBrowserMcpServer
} from './claude-tools.js'

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Keep the built-in surface deliberately small. Browser capabilities remain
// first-class through the desktop_browser MCP server below.
export const claudeBuiltInTools = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'NotebookEdit',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'EnterPlanMode',
  'ExitPlanMode'
]

export function buildClaudeOptions(
  options: {
    resume: string | null
    cwd: string
    model: string | null
    effort: ClaudeEffort | null
    collaborationMode: 'default' | 'plan'
  },
  mcpServer?: ReturnType<typeof createClaudeBrowserMcpServer>
): Options {
  return {
    cwd: options.cwd,
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    includePartialMessages: true,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: buildGuidance(),
      excludeDynamicSections: true
    },
    tools: [...claudeBuiltInTools],
    // SDK-discovered skills are enabled when this is omitted. Keep them out of
    // app sessions until Codex Desktop owns selection and context budgeting.
    skills: [],
    settingSources: ['project'],
    strictMcpConfig: true,
    ...(mcpServer ? {
      mcpServers: { [claudeBrowserMcpServerName]: mcpServer },
      allowedTools: claudeBrowserToolNames
    } : {}),
    disallowedTools: ['WebSearch', 'WebFetch', 'Agent', 'Skill'],
    permissionMode: options.collaborationMode === 'plan' ? 'plan' : 'bypassPermissions',
    allowDangerouslySkipPermissions: options.collaborationMode !== 'plan',
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'codexdesktop/0.1.0'
    }
  }
}
