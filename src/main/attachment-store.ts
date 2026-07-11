import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'
import type { AttachmentSaveInput, ChatAttachment } from '../shared/ipc.js'

const maxImageBytes = 20 * 1024 * 1024
const maxFileBytes = 50 * 1024 * 1024
const maxMessageBytes = 50 * 1024 * 1024
const maxAttachments = 10
const maxImages = 4

const allowedFileExtensions = new Set([
  '.pdf', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.xml',
  '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c',
  '.h', '.cpp', '.hpp', '.sh', '.sql', '.log', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf'
])

export class AttachmentStore {
  private readonly directory: string | (() => string)

  constructor(directory: string | (() => string)) {
    this.directory = directory
  }

  async persistFiles(inputs: AttachmentSaveInput[]): Promise<ChatAttachment[]> {
    if (inputs.length === 0) return []
    if (inputs.length > maxAttachments) throw new Error(`You can attach up to ${maxAttachments} files at once`)

    const totalBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (totalBytes > maxMessageBytes) throw new Error('Attachments exceed the 50 MB combined limit')

    const validated = inputs.map((input) => validateInput(input))
    if (validated.filter((item) => item.kind === 'image').length > maxImages) {
      throw new Error(`You can attach up to ${maxImages} images at once`)
    }

    const root = this.root()
    await mkdir(root, { recursive: true })
    const persisted: ChatAttachment[] = []

    try {
      for (const item of validated) {
        const id = crypto.randomUUID()
        const storedName = `${id}--${item.name}`
        const path = join(root, storedName)
        const temporaryPath = `${path}.tmp`
        await writeFile(temporaryPath, item.buffer, { flag: 'wx' })
        await rename(temporaryPath, path)
        persisted.push({ id, kind: item.kind, name: item.name, path, mediaType: item.mediaType, size: item.buffer.length })
      }
      return persisted
    } catch (error) {
      await Promise.all(persisted.map((attachment) => rm(attachment.path, { force: true })))
      throw error
    }
  }

  async preview(path: string): Promise<string | null> {
    if (!this.owns(path)) return null
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size <= 0 || info.size > maxImageBytes) return null
      const buffer = await readFile(path)
      const detected = detectImage(buffer)
      return detected ? `data:${detected.mediaType};base64,${buffer.toString('base64')}` : null
    } catch {
      return null
    }
  }

  async verify(attachments: ChatAttachment[]): Promise<ChatAttachment[]> {
    if (attachments.length > maxAttachments) throw new Error(`You can attach up to ${maxAttachments} files at once`)
    if (attachments.filter((item) => item.kind === 'image').length > maxImages) {
      throw new Error(`You can attach up to ${maxImages} images at once`)
    }
    let total = 0
    const verified: ChatAttachment[] = []
    for (const attachment of attachments) {
      if (!this.owns(attachment.path)) throw new Error('Attachment path is not owned by the application')
      const info = await stat(attachment.path)
      if (!info.isFile()) throw new Error('Attachment is not a regular file')
      total += info.size
      const stored = basename(attachment.path)
      if (!stored.startsWith(`${attachment.id}--`)) throw new Error('Attachment identity does not match its stored path')
      const buffer = await readFile(attachment.path)
      const image = detectImage(buffer)
      if ((attachment.kind === 'image') !== Boolean(image)) throw new Error('Attachment type does not match its contents')
      verified.push({
        ...attachment,
        name: safeName(stored.slice(attachment.id.length + 2)),
        mediaType: image?.mediaType ?? attachment.mediaType,
        size: info.size
      })
    }
    if (total > maxMessageBytes) throw new Error('Attachments exceed the 50 MB combined limit')
    return verified
  }

  private root(): string {
    return typeof this.directory === 'function' ? this.directory() : this.directory
  }

  private owns(path: string): boolean {
    const rel = relative(resolve(this.root()), resolve(path))
    return rel !== '' && !rel.startsWith('..') && !rel.includes('\0')
  }
}

function validateInput(input: AttachmentSaveInput): {
  name: string
  kind: ChatAttachment['kind']
  mediaType: string
  buffer: Buffer
} {
  const name = safeName(input.name)
  const buffer = Buffer.from(input.data)
  if (buffer.length === 0) throw new Error(`${name} is empty`)

  const image = detectImage(buffer)
  if (image) {
    if (buffer.length > maxImageBytes) throw new Error(`${name} exceeds the 20 MB image limit`)
    return { name: ensureExtension(name, image.extension), kind: 'image', mediaType: image.mediaType, buffer }
  }

  const extension = extname(name).toLowerCase()
  const pdf = buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))
  if (!pdf && !allowedFileExtensions.has(extension)) throw new Error(`${name} is not a supported file type`)
  if (extension === '.pdf' && !pdf) throw new Error(`${name} is not a valid PDF`)
  if (buffer.length > maxFileBytes) throw new Error(`${name} exceeds the 50 MB file limit`)
  return { name, kind: 'file', mediaType: pdf ? 'application/pdf' : normalizedMediaType(input.mediaType), buffer }
}

function detectImage(buffer: Buffer): { mediaType: string; extension: string } | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mediaType: 'image/png', extension: '.png' }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mediaType: 'image/jpeg', extension: '.jpg' }
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mediaType: 'image/webp', extension: '.webp' }
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) {
    return { mediaType: 'image/gif', extension: '.gif' }
  }
  return null
}

function safeName(value: string): string {
  const cleaned = basename(value || 'attachment')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[^\p{L}\p{N}._()\- ]/gu, '_')
    .trim()
    .slice(0, 160)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'attachment'
}

function ensureExtension(name: string, extension: string): string {
  return extname(name) ? name : `${name}${extension}`
}

function normalizedMediaType(value: string): string {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase()
  return normalized && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(normalized) ? normalized : 'application/octet-stream'
}
