import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js'
import type { SkillsListResponse } from '../../shared/codex-protocol/v2/SkillsListResponse.js'
import type { UserInput } from '../../shared/codex-protocol/v2/UserInput.js'
import type { ChatAttachment } from '../../shared/ipc.js'
import { attachmentTurnInputs } from './attachment-input.js'
import {
  formatSkillInvocationText,
  selectNewThreadSkills,
  selectTurnSkills
} from './codex-config.js'

type AppServerRequest = <T = unknown>(method: string, params?: unknown) => Promise<T>

export class LocalSkillRegistry {
  private skills: SkillMetadata[]
  private readonly appPath: string
  private readonly skillsRoot: string

  constructor(
    appPath: string,
    skillsRoot: string,
    initialSkills: SkillMetadata[] = []
  ) {
    this.appPath = appPath
    this.skillsRoot = skillsRoot
    this.skills = initialSkills
  }

  async register(request: AppServerRequest): Promise<void> {
    if (!existsSync(this.skillsRoot)) {
      this.skills = []
      console.warn(`Local Codex skills root not found: ${this.skillsRoot}`)
      return
    }

    try {
      await request('skills/extraRoots/set', { extraRoots: [this.skillsRoot] })
      await this.refresh(request, true)
    } catch (error) {
      this.skills = []
      console.warn('Failed to register local Codex skills root', error)
    }
  }

  async refresh(request: AppServerRequest, forceReload = false): Promise<void> {
    const root = resolve(this.skillsRoot)
    try {
      const result = await request<SkillsListResponse>('skills/list', {
        cwds: [this.appPath],
        forceReload
      })
      this.skills = result.data
        .flatMap((entry) => entry.skills)
        .filter((skill) => skill.enabled && isPathWithin(root, skill.path))
    } catch (error) {
      console.warn('Failed to refresh local Codex skills', error)
    }
  }

  buildTurnInput(text: string, isNewThread: boolean, attachments: ChatAttachment[] = []): UserInput[] {
    const turnSkills = selectTurnSkills(text, this.skills)
    const newThreadSkills = isNewThread ? selectNewThreadSkills(text, this.skills) : []
    const skills = [...new Map([...newThreadSkills, ...turnSkills].map((skill) => [skill.name, skill])).values()]
    const visibleText = formatSkillInvocationText(text, turnSkills)

    return [
      ...(visibleText.trim() ? [{ type: 'text', text: visibleText, text_elements: [] } satisfies UserInput] : []),
      ...attachmentTurnInputs(attachments),
      ...skills.map((skill): UserInput => ({ type: 'skill', name: skill.name, path: skill.path }))
    ]
  }
}

export function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, resolve(candidate))
  const separator = process.platform === 'win32' ? '\\' : '/'
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${separator}`) && !isAbsolute(pathFromRoot)
}
