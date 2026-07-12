import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  buildLastChatMarkdown,
  buildTranscriptMarkdown,
  type MemorySnapshot
} from './memory-format.js'

export class MemoryStore {
  private readonly directory: string
  private readonly legacyLastChatPath: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(directory: string) {
    this.directory = directory
    this.legacyLastChatPath = join(directory, 'last-chat.md')
  }

  persist(snapshot: MemorySnapshot): Promise<void> {
    validateSnapshot(snapshot)

    const operation = this.writeQueue
      .catch(() => undefined)
      .then(() => this.persistSnapshot(snapshot))
    this.writeQueue = operation
    return operation
  }

  private async persistSnapshot(snapshot: MemorySnapshot): Promise<void> {
    const workspaceDirectory = join(this.directory, 'workspaces', memoryWorkspaceKey(snapshot.workspace))
    const chatsDirectory = join(workspaceDirectory, 'chats', snapshot.provider)
    const transcriptPath = join(chatsDirectory, `${snapshot.threadId}.md`)
    const transcript = buildTranscriptMarkdown(snapshot)
    const lastChat = buildLastChatMarkdown(snapshot, transcriptPath)
    if (!lastChat) return

    await mkdir(chatsDirectory, { recursive: true })
    await atomicWrite(transcriptPath, transcript)

    // Background agents keep their own durable transcript, but only the main
    // user-facing conversation advances the workspace checkpoint. Otherwise
    // parallel agents can replace the context a later top-level chat recalls.
    if (snapshot.surface === 'main') {
      await Promise.all([
        atomicWrite(join(workspaceDirectory, 'last-chat.md'), lastChat),
        // Compatibility pointer for the current prior-chat-memory skill. The
        // provider-neutral reader will switch to the workspace checkpoint.
        atomicWrite(this.legacyLastChatPath, lastChat)
      ])
    }
  }
}

export function memoryWorkspaceKey(workspace: string | null): string {
  let identity = workspace ? resolve(workspace) : 'no-workspace'
  if (process.platform === 'win32') identity = identity.toLowerCase()
  return createHash('sha256').update(identity).digest('hex')
}

function validateSnapshot(snapshot: MemorySnapshot): void {
  if (snapshot.provider !== 'codex' && snapshot.provider !== 'claude') {
    throw new Error('invalid memory provider')
  }
  if (snapshot.surface !== 'main' && snapshot.surface !== 'agent') {
    throw new Error('invalid memory surface')
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(snapshot.threadId)) {
    throw new Error('invalid memory thread id')
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, 'utf8')
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}
