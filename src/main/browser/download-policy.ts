import { basename } from 'node:path'

export function safeDownloadName(filename: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips control chars from download filenames
  const safe = basename(filename.trim()).replace(/[\u0000-\u001f\u007f]/g, '')
  return safe || 'download'
}
