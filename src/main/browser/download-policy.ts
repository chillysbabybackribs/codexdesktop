import { basename } from 'node:path'

export function safeDownloadName(filename: string): string {
  const safe = basename(filename.trim()).replace(/[\u0000-\u001f\u007f]/g, '')
  return safe || 'download'
}
