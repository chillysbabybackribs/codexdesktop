import type { TraceTruncation } from './trace-types'

export function traceTruncations(value: unknown): TraceTruncation[] {
  const truncations: TraceTruncation[] = []
  collectTruncations(value, '', truncations)
  return truncations
}

function collectTruncations(value: unknown, path: string, truncations: TraceTruncation[]): void {
  if (typeof value === 'string') {
    if (path.endsWith('.label')) return
    const marker = /\n\[… truncated (\d+) characters]$/.exec(value)
    if (marker) {
      truncations.push({
        path,
        reason: 'sizeLimit',
        capturedCharacters: marker.index,
        omittedCharacters: Number(marker[1])
      })
    } else if (value.includes('[omitted from trace]')) {
      truncations.push({ path, reason: 'omitted' })
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((part, index) => {
      collectTruncations(part, `${path}[${index}]`, truncations)
    })
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, part] of Object.entries(value)) {
    collectTruncations(part, path ? `${path}.${key}` : key, truncations)
  }
}
