export const maxTextChars = 30_000

export function iso(value: number | undefined): string | undefined {
  return typeof value === 'number' ? new Date(value).toISOString() : undefined
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… truncated ${text.length - max} characters]` : text
}

export function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
