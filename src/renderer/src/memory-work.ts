const maxCompletedWorkItems = 2

export function selectCompletedWork(items: string[]): string[] {
  return items
    .map((item, index) => ({ item, index, score: completedWorkScore(item) }))
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, maxCompletedWorkItems)
    .sort((left, right) => left.index - right.index)
    .map(({ item }) => item)
}

function completedWorkScore(item: string): number {
  if (/\btests? passed\b/i.test(item)) return 5
  if (/\bfailed\b|\bdeclined\b/i.test(item)) return 6
  if (/^Tool completed: (browser_cdp|browser_flow|browser_run|browser_network|browser_live_search|research_web)$/i.test(item)) return 4
  if (/^File changes completed:/i.test(item)) return 3
  if (/^Command succeeded:/i.test(item)) return 2
  return 1
}
