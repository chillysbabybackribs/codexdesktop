// Pure scroll-windowing math for the agent dock column. The column snaps in
// card-sized "slots"; the chevron bars report how many cards sit outside the
// viewport and a window jump targets an exact slot boundary. The component
// reads the DOM (scrollTop, heights) and hands the measurements here.

export type AgentColumnMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  // offsetHeight of the first card in the column, or null when there is no
  // measurable first card (empty column) — falls back to half the viewport.
  firstItemHeight: number | null
}

export function columnSlotSize(metrics: AgentColumnMetrics): number {
  return metrics.firstItemHeight !== null
    ? metrics.firstItemHeight + 10
    : metrics.clientHeight / 2
}

export function hiddenAgentCounts(
  metrics: AgentColumnMetrics
): { above: number; below: number } {
  const slot = columnSlotSize(metrics)
  const above = Math.max(0, Math.round(metrics.scrollTop / slot))
  const below = Math.max(
    0,
    Math.round((metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight) / slot)
  )
  return { above, below }
}

export function windowScrollTarget(metrics: AgentColumnMetrics, direction: 1 | -1): number {
  const slot = columnSlotSize(metrics)
  // Absolute target from the CURRENT slot index — repeated clicks land on
  // exact snap points instead of compounding relative deltas mid-animation.
  const index = Math.round(metrics.scrollTop / slot) + direction
  return Math.max(0, Math.min(index * slot, metrics.scrollHeight - metrics.clientHeight))
}
