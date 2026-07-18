export type CollectionProgress = {
  attempted: number
  succeeded: number
  index: number
  success?: boolean
}

export type CollectedValue<T> = {
  index: number
  value: T
}

export type CollectUntilOptions<T> = {
  concurrency: number
  target: number
  maxAttempts: number
  shouldStop?: (values: readonly CollectedValue<T>[]) => boolean
  onStarted?: (progress: CollectionProgress) => void
  onSettled?: (progress: CollectionProgress) => void
}

/**
 * Process a ranked list with bounded concurrency, stopping new and in-flight
 * work as soon as enough successful values have been collected or an optional
 * result-aware stop predicate says the collection goal is satisfied.
 */
export async function collectWithConcurrencyUntil<T, R>(
  items: T[],
  options: CollectUntilOptions<R>,
  mapper: (item: T, index: number, stopSignal: AbortSignal) => Promise<R | null>
): Promise<{ values: CollectedValue<R>[]; attempted: number }> {
  const target = Math.max(0, Math.round(options.target))
  const maxAttempts = Math.max(0, Math.min(items.length, Math.round(options.maxAttempts)))
  const concurrency = Math.max(1, Math.min(Math.round(options.concurrency), maxAttempts || 1))
  if (target === 0 || maxAttempts === 0 || items.length === 0) {
    return { values: [], attempted: 0 }
  }

  const stopController = new AbortController()
  const values: CollectedValue<R>[] = []
  let nextIndex = 0
  let attempted = 0
  const goalReached = (): boolean => values.length >= target || options.shouldStop?.(values) === true

  if (goalReached()) return { values: [], attempted: 0 }

  const workers = Array.from({ length: concurrency }, async () => {
    while (!stopController.signal.aborted && !goalReached() && attempted < maxAttempts) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return

      attempted += 1
      options.onStarted?.({ attempted, succeeded: values.length, index })

      let value: R | null
      try {
        value = await mapper(items[index], index, stopController.signal)
      } catch (error) {
        if (stopController.signal.aborted) return
        throw error
      }

      if (value !== null && !stopController.signal.aborted && !goalReached()) {
        values.push({ index, value })
      }
      options.onSettled?.({ attempted, succeeded: values.length, index, success: value !== null })

      if (goalReached()) {
        stopController.abort()
        return
      }
    }
  })

  await Promise.all(workers)
  return {
    values: values.sort((left, right) => left.index - right.index),
    attempted
  }
}

/** Keep ranked values only when each one strictly improves the supplied deficit. */
export function retainValuesReducingDeficit<T>(
  values: readonly T[],
  maxValues: number,
  measureDeficit: (retained: readonly T[]) => number
): T[] {
  const limit = Math.max(0, Math.round(maxValues))
  if (limit === 0 || values.length === 0) return []

  const retained: T[] = []
  let deficit = measureDeficit(retained)
  for (const value of values) {
    if (retained.length >= limit || deficit <= 0) break
    const candidate = [...retained, value]
    const candidateDeficit = measureDeficit(candidate)
    if (candidateDeficit >= deficit) continue
    retained.push(value)
    deficit = candidateDeficit
  }
  return retained
}

/** Serializes work per key while allowing a bounded number of keys to run. */
export class KeyedTaskScheduler {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly waiters: Array<() => void> = []
  private readonly maxConcurrent: number
  private active = 0

  constructor(maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer')
    }
    this.maxConcurrent = maxConcurrent
  }

  run<T>(key: string, task: (queueMs: number) => Promise<T>): Promise<T> {
    const queuedAt = Date.now()
    const previous = this.queues.get(key) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const release = await this.acquire()
      try {
        return await task(Date.now() - queuedAt)
      } finally {
        release()
      }
    })
    const tail = operation.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(key, tail)

    return operation.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
  }

  private async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }

    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next()
      else this.active -= 1
    }
  }
}
