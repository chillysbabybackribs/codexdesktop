import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const maxImageBytes = 20 * 1024 * 1024

/**
 * `imageView` items are emitted after the model has intentionally opened a
 * local image. Unlike browser screenshots, those paths are not necessarily in
 * the CDP artifact store, so the transcript needs a bounded image-only read.
 */
export async function readImageViewDataUrl(path: string): Promise<string | null> {
  if (!isAbsolute(path) || path.includes('\0') || path.length > 4_096) return null

  try {
    const info = await stat(path)
    if (!info.isFile() || info.size <= 0 || info.size > maxImageBytes) return null

    const buffer = await readFile(path)
    const mediaType = imageMediaType(buffer)
    return mediaType ? `data:${mediaType};base64,${buffer.toString('base64')}` : null
  } catch {
    return null
  }
}

function imageMediaType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'image/gif'
  return null
}
