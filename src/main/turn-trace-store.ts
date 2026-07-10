import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const maxTraceBytes = 5 * 1024 * 1024
const safeIdPattern = /^[a-z0-9_-]{1,128}$/i

export type PersistedTurnTrace = {
  threadId: string
  turnId: string
  content: string
}

export class TurnTraceStore {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly root: string) {}

  async persist(trace: PersistedTurnTrace): Promise<void> {
    const key = traceKey(trace.threadId, trace.turnId)
    validateContent(trace.content, trace.turnId)
    const previous = this.queues.get(key) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const directory = join(this.root, trace.threadId)
      const path = join(directory, `${trace.turnId}.json`)
      const temporaryPath = `${path}.${process.pid}.tmp`
      await mkdir(directory, { recursive: true })
      await writeFile(temporaryPath, trace.content, 'utf8')
      await rename(temporaryPath, path)
    })

    const queueTail = operation.catch(() => {})
    this.queues.set(key, queueTail)
    try {
      await operation
    } finally {
      if (this.queues.get(key) === queueTail) this.queues.delete(key)
    }
  }

  async load(threadId: string, turnId: string): Promise<string | null> {
    const key = traceKey(threadId, turnId)
    await this.queues.get(key)
    try {
      const content = await readFile(join(this.root, threadId, `${turnId}.json`), 'utf8')
      validateContent(content, turnId)
      return content
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
}

function traceKey(threadId: string, turnId: string): string {
  if (!safeIdPattern.test(threadId) || !safeIdPattern.test(turnId)) {
    throw new Error('invalid trace thread or turn id')
  }
  return `${threadId}/${turnId}`
}

function validateContent(content: string, turnId: string): void {
  if (Buffer.byteLength(content, 'utf8') > maxTraceBytes) {
    throw new Error(`turn trace exceeds ${maxTraceBytes} bytes`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('turn trace content must be valid JSON')
  }

  const storedTurnId = (parsed as { turn?: { id?: unknown } })?.turn?.id
  if (storedTurnId !== turnId) throw new Error('turn trace id does not match storage key')
}
