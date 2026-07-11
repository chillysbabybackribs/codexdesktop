import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildLastChatMarkdown,
  buildTranscriptMarkdown,
  type MemorySnapshot
} from './memory-format.js'

export class MemoryStore {
  private readonly chatsDirectory: string
  private readonly lastChatPath: string

  constructor(private readonly directory: string) {
    this.chatsDirectory = join(directory, 'chats')
    this.lastChatPath = join(directory, 'last-chat.md')
  }

  async persist(snapshot: MemorySnapshot): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(snapshot.threadId)) {
      throw new Error('invalid memory thread id')
    }

    const transcriptPath = join(this.chatsDirectory, `${snapshot.threadId}.md`)
    const transcript = buildTranscriptMarkdown(snapshot)
    const lastChat = buildLastChatMarkdown(snapshot, transcriptPath)
    if (!lastChat) return

    await mkdir(this.chatsDirectory, { recursive: true })
    await Promise.all([
      atomicWrite(transcriptPath, transcript),
      atomicWrite(this.lastChatPath, lastChat)
    ])
  }

  async loadLastChat(workspace?: string | null): Promise<string | null> {
    try {
      const memory = await readFile(this.lastChatPath, 'utf8')
      if (workspace && !hasWorkspace(memory, workspace)) return null
      return memory
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, content, 'utf8')
  await rename(temporaryPath, path)
}

function hasWorkspace(memory: string, workspace: string): boolean {
  const expected = workspace.replace(/[\r\n]+/g, ' ').trim()
  return memory.split('\n', 12).some((line) => line === `Workspace: ${expected}`)
}
