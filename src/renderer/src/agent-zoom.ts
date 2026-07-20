export const agentZoomStorageKey = (key: string): string => `codexdesktop.agent-zoom.${key}`

export function storedAgentZoom(value: string | null): number {
  if (value === null) return 100
  const zoom = Number(value)
  return Number.isFinite(zoom) ? Math.max(80, Math.min(140, zoom)) : 100
}
