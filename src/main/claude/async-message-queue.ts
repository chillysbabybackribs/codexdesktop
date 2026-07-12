export class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private ended = false

  push(value: T): void {
    if (this.ended) throw new Error('Cannot push to a closed message queue')
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value })
    else this.values.push(value)
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
      }
    }
  }
}

