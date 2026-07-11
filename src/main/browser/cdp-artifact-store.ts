import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'

const maxScreenshotBytes = 20 * 1024 * 1024
const maxReadableImageBytes = 20 * 1024 * 1024
const maxArtifactAgeMs = 7 * 24 * 60 * 60 * 1000
const maxArtifactBytes = 250 * 1024 * 1024

export type CdpScreenshotArtifact = {
  artifactPath: string
  fileName: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  format: 'png' | 'jpeg' | 'webp'
  bytes: number
  width: number | null
  height: number | null
  createdAt: string
}

export class CdpArtifactStore {
  constructor(private readonly directory: string | (() => string)) {}

  async persistScreenshot(data: string, requestedFormat?: string | null): Promise<CdpScreenshotArtifact> {
    const buffer = decodeBase64(data)
    if (buffer.length === 0) throw new Error('Page.captureScreenshot returned an empty image')
    if (buffer.length > maxScreenshotBytes) {
      throw new Error(`Page.captureScreenshot image exceeds the ${maxScreenshotBytes / (1024 * 1024)} MB artifact limit`)
    }

    const format = resolveFormat(buffer, requestedFormat)
    const dimensions = readImageDimensions(buffer, format)
    const root = this.root()
    await pruneArtifacts(root)
    await mkdir(root, { recursive: true })

    const createdAt = new Date().toISOString()
    const fileName = `screenshot-${createdAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.${format}`
    const artifactPath = join(root, fileName)
    const temporaryPath = `${artifactPath}.tmp`
    await writeFile(temporaryPath, buffer)
    await rename(temporaryPath, artifactPath)

    return {
      artifactPath,
      fileName,
      mediaType: mediaTypeFor(format),
      format,
      bytes: buffer.length,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      createdAt
    }
  }

  async readImageDataUrl(artifactPath: string): Promise<string | null> {
    if (!this.isOwnedPath(artifactPath)) return null

    try {
      const file = await readFile(artifactPath)
      if (file.length === 0 || file.length > maxReadableImageBytes) return null
      const format = formatFromExtension(artifactPath)
      if (!format) return null
      return `data:${mediaTypeFor(format)};base64,${file.toString('base64')}`
    } catch {
      return null
    }
  }

  private root(): string {
    return typeof this.directory === 'function' ? this.directory() : this.directory
  }

  private isOwnedPath(candidate: string): boolean {
    const root = resolve(this.root())
    const pathFromRoot = relative(root, resolve(candidate))
    return pathFromRoot !== '' && !pathFromRoot.startsWith('..') && !pathFromRoot.includes('..') && Boolean(formatFromExtension(candidate))
  }
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s/g, '')
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error('Page.captureScreenshot returned invalid base64 image data')
  }
  return Buffer.from(normalized, 'base64')
}

function resolveFormat(buffer: Buffer, requestedFormat?: string | null): 'png' | 'jpeg' | 'webp' {
  const detected = detectFormat(buffer)
  const requested = requestedFormat?.toLowerCase()
  const normalizedRequested = requested === 'jpg' ? 'jpeg' : requested
  if (normalizedRequested && normalizedRequested !== detected) {
    throw new Error(`Page.captureScreenshot returned ${detected} bytes for requested ${normalizedRequested} format`)
  }
  return detected
}

function detectFormat(buffer: Buffer): 'png' | 'jpeg' | 'webp' {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (buffer.length >= 16 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  throw new Error('Page.captureScreenshot returned an unsupported image format')
}

function readImageDimensions(buffer: Buffer, format: 'png' | 'jpeg' | 'webp'): { width: number; height: number } | null {
  if (format === 'png') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  if (format === 'jpeg') return readJpegDimensions(buffer)
  return readWebpDimensions(buffer)
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  for (let offset = 2; offset + 9 < buffer.length;) {
    if (buffer[offset] !== 0xff) return null
    const marker = buffer[offset + 1]
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > buffer.length) return null
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return null
}

function readWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
  const chunk = buffer.subarray(12, 16).toString('ascii')
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    }
  }
  if (chunk === 'VP8 ' && buffer.length >= 30 && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

function mediaTypeFor(format: 'png' | 'jpeg' | 'webp'): CdpScreenshotArtifact['mediaType'] {
  return format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp'
}

function formatFromExtension(path: string): 'png' | 'jpeg' | 'webp' | null {
  const extension = extname(path).toLowerCase()
  if (extension === '.png') return 'png'
  if (extension === '.jpg' || extension === '.jpeg') return 'jpeg'
  if (extension === '.webp') return 'webp'
  return null
}

async function pruneArtifacts(root: string): Promise<void> {
  try {
    const entries = await Promise.all((await readdir(root)).map(async (name) => {
      const path = join(root, name)
      const metadata = await stat(path)
      return { path, metadata }
    }))
    const oldestFirst = entries.filter(({ metadata }) => metadata.isFile()).sort((left, right) => left.metadata.mtimeMs - right.metadata.mtimeMs)
    let totalBytes = oldestFirst.reduce((total, { metadata }) => total + metadata.size, 0)
    const now = Date.now()
    for (const entry of oldestFirst) {
      if (now - entry.metadata.mtimeMs <= maxArtifactAgeMs && totalBytes <= maxArtifactBytes) continue
      await rm(entry.path, { force: true })
      totalBytes -= entry.metadata.size
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Failed to prune CDP artifacts', error)
    }
  }
}
