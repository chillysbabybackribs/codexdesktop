import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'

const maxScreenshotBytes = 20 * 1024 * 1024
const maxPdfBytes = 25 * 1024 * 1024
const maxTraceBytes = 100 * 1024 * 1024
const maxSnapshotBytes = 100 * 1024 * 1024
const maxResponseBodyBytes = 25 * 1024 * 1024
const maxBrowserResultBytes = 25 * 1024 * 1024
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

export type CdpFileArtifact = {
  artifactPath: string
  fileName: string
  mediaType: string
  kind: 'pdf' | 'trace' | 'snapshot' | 'response-body' | 'network-stream' | 'browser-result'
  bytes: number
  createdAt: string
}

export type CdpStreamChunk = {
  data: string
  base64Encoded?: boolean
  eof: boolean
}

export class CdpArtifactStore {
  private readonly directory: string | (() => string)

  constructor(directory: string | (() => string)) {
    this.directory = directory
  }

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

  async persistPdf(data: string): Promise<CdpFileArtifact> {
    const buffer = decodeBase64(data)
    if (buffer.length === 0) throw new Error('Page.printToPDF returned an empty document')
    if (buffer.length > maxPdfBytes) throw new Error('Page.printToPDF document exceeds the 25 MB artifact limit')
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Page.printToPDF returned invalid PDF bytes')
    return this.persistBufferArtifact(buffer, 'document', 'pdf', 'application/pdf', 'pdf')
  }

  async persistTraceStream(readNext: () => Promise<CdpStreamChunk>): Promise<CdpFileArtifact> {
    const { artifactPath, fileName, temporaryPath, createdAt } = await this.createArtifactPath('trace', 'json')
    let bytes = 0

    try {
      for (;;) {
        const chunk = await readNext()
        const buffer = chunk.base64Encoded ? decodeBase64(chunk.data) : Buffer.from(chunk.data, 'utf8')
        bytes += buffer.length
        if (bytes > maxTraceBytes) throw new Error('CDP trace exceeds the 100 MB artifact limit')
        if (buffer.length > 0) await appendFile(temporaryPath, buffer)
        if (chunk.eof) break
      }
      if (bytes === 0) throw new Error('Tracing returned an empty stream')
      await rename(temporaryPath, artifactPath)
      return { artifactPath, fileName, mediaType: 'application/json', kind: 'trace', bytes, createdAt }
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }

  async persistSnapshot(snapshot: unknown): Promise<CdpFileArtifact> {
    const serialized = JSON.stringify(snapshot)
    const buffer = Buffer.from(serialized, 'utf8')
    if (buffer.length === 0) throw new Error('DOMSnapshot returned an empty result')
    if (buffer.length > maxSnapshotBytes) throw new Error('DOMSnapshot exceeds the 100 MB artifact limit')
    return this.persistBufferArtifact(buffer, 'snapshot', 'json', 'application/json', 'snapshot')
  }

  async persistResponseBody(data: string, base64Encoded: boolean, mimeType?: string | null, url?: string | null): Promise<CdpFileArtifact> {
    const buffer = base64Encoded ? decodeBase64(data) : Buffer.from(data, 'utf8')
    if (buffer.length === 0) throw new Error('Network.getResponseBody returned an empty body')
    if (buffer.length > maxResponseBodyBytes) throw new Error('Network response body exceeds the 25 MB artifact limit')
    const normalizedMimeType = normalizeMimeType(mimeType)
    const extension = responseBodyExtension(normalizedMimeType, url)
    return this.persistBufferArtifact(buffer, 'response-body', extension, normalizedMimeType, 'response-body')
  }

  async persistNetworkStream(serialized: string): Promise<CdpFileArtifact> {
    const buffer = Buffer.from(serialized, 'utf8')
    if (buffer.length === 0) throw new Error('Network stream capture returned no data')
    if (buffer.length > maxResponseBodyBytes) throw new Error('Network stream capture exceeds the 25 MB artifact limit')
    return this.persistBufferArtifact(buffer, 'network-stream', 'ndjson', 'application/x-ndjson', 'network-stream')
  }

  async persistBrowserResult(serialized: string): Promise<CdpFileArtifact> {
    const buffer = Buffer.from(serialized, 'utf8')
    if (buffer.length === 0) throw new Error('Browser program returned an empty serialized result')
    if (buffer.length > maxBrowserResultBytes) {
      throw new Error('Browser program result exceeds the 25 MB artifact limit')
    }
    return this.persistBufferArtifact(buffer, 'browser-result', 'json', 'application/json', 'browser-result')
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

  private async persistBufferArtifact(
    buffer: Buffer,
    prefix: string,
    extension: string,
    mediaType: CdpFileArtifact['mediaType'],
    kind: CdpFileArtifact['kind']
  ): Promise<CdpFileArtifact> {
    const { artifactPath, fileName, temporaryPath, createdAt } = await this.createArtifactPath(prefix, extension)
    await writeFile(temporaryPath, buffer)
    await rename(temporaryPath, artifactPath)
    return { artifactPath, fileName, mediaType, kind, bytes: buffer.length, createdAt }
  }

  private async createArtifactPath(prefix: string, extension: string): Promise<{
    artifactPath: string
    fileName: string
    temporaryPath: string
    createdAt: string
  }> {
    const root = this.root()
    await pruneArtifacts(root)
    await mkdir(root, { recursive: true })
    const createdAt = new Date().toISOString()
    const fileName = `${prefix}-${createdAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.${extension}`
    const artifactPath = join(root, fileName)
    return { artifactPath, fileName, temporaryPath: `${artifactPath}.tmp`, createdAt }
  }

  private isOwnedPath(candidate: string): boolean {
    const root = resolve(this.root())
    const pathFromRoot = relative(root, resolve(candidate))
    return pathFromRoot !== '' && !pathFromRoot.startsWith('..') && Boolean(formatFromExtension(candidate))
  }
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s/g, '')
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error('CDP returned invalid base64 artifact data')
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

function normalizeMimeType(mimeType?: string | null): string {
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  return normalized || 'application/octet-stream'
}

function responseBodyExtension(mimeType: string, url?: string | null): string {
  if (mimeType.includes('json')) return 'json'
  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') return 'html'
  if (mimeType.includes('xml')) return 'xml'
  if (mimeType === 'text/css') return 'css'
  if (mimeType.includes('javascript')) return 'js'
  if (mimeType.startsWith('text/')) return 'txt'
  try {
    const extension = extname(new URL(url ?? '').pathname).slice(1).toLowerCase()
    if (/^[a-z0-9]{1,8}$/.test(extension)) return extension
  } catch {
    // A missing or non-standard URL simply falls back to binary.
  }
  return 'bin'
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
