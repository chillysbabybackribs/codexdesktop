import type { DownloadItem, WebContents } from 'electron'
import type { CdpArtifactStore, CdpDownloadReservation, CdpFileArtifact } from './cdp-artifact-store.js'
import { safeDownloadName } from './download-policy.js'

export type BrowserDownloadCapture = {
  url: string
  suggestedFilename: string
  mimeType: string
  totalBytes: number
  receivedBytes: number
  artifact: CdpFileArtifact
}

type DownloadWaiter = {
  webContents: WebContents
  urlContains: string
  reservation: CdpDownloadReservation
  resolve: (capture: BrowserDownloadCapture) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
  item?: DownloadItem
  settled: boolean
}

export class BrowserDownloadCaptureBroker {
  private readonly waiters = new Set<DownloadWaiter>()

  async waitForDownload(
    webContents: WebContents,
    urlContains: string,
    artifactStore: CdpArtifactStore,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<BrowserDownloadCapture> {
    const reservation = await artifactStore.prepareDownloadCapture()
    return new Promise<BrowserDownloadCapture>((resolve, reject) => {
      const waiter: DownloadWaiter = {
        webContents,
        urlContains: urlContains.toLowerCase(),
        reservation,
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => {
          void this.rejectWaiter(waiter, new Error(`browser download wait timed out after ${timeoutMs}ms (url contains "${urlContains}")`))
        }, timeoutMs),
        ...(signal ? { signal } : {})
      }
      if (signal) {
        waiter.onAbort = () => {
          void this.rejectWaiter(waiter, new Error('browser download wait cancelled'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.add(waiter)
      if (signal?.aborted) waiter.onAbort?.()
    })
  }

  handleWillDownload(item: DownloadItem, webContents: WebContents): boolean {
    const url = item.getURL()
    const waiter = [...this.waiters].find((candidate) =>
      candidate.webContents === webContents && url.toLowerCase().includes(candidate.urlContains)
    )
    if (!waiter || waiter.settled) return false

    waiter.item = item
    const suggestedFilename = safeDownloadName(item.getFilename())
    try {
      item.setSavePath(waiter.reservation.savePathFor(suggestedFilename))
    } catch (error) {
      void this.rejectWaiter(waiter, error instanceof Error ? error : new Error(String(error)))
      return true
    }

    item.once('done', (_event, state) => {
      if (state !== 'completed') {
        void this.rejectWaiter(waiter, new Error(`browser download ${state}`))
        return
      }
      void this.resolveWaiter(waiter, {
        url,
        suggestedFilename,
        mimeType: item.getMimeType(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes()
      })
    })
    return true
  }

  private async resolveWaiter(
    waiter: DownloadWaiter,
    download: Omit<BrowserDownloadCapture, 'artifact'>
  ): Promise<void> {
    if (!this.settleWaiter(waiter)) return
    try {
      const artifact = await waiter.reservation.complete(download.mimeType)
      waiter.resolve({ ...download, artifact })
    } catch (error) {
      await waiter.reservation.cancel()
      waiter.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async rejectWaiter(waiter: DownloadWaiter, error: Error): Promise<void> {
    if (!this.settleWaiter(waiter)) return
    try {
      waiter.item?.cancel()
    } catch {
      // A terminal DownloadItem may already have released its native handle.
    }
    await waiter.reservation.cancel()
    waiter.reject(error)
  }

  private settleWaiter(waiter: DownloadWaiter): boolean {
    if (waiter.settled) return false
    waiter.settled = true
    clearTimeout(waiter.timer)
    this.waiters.delete(waiter)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
    return true
  }
}

export const browserDownloadCaptureBroker = new BrowserDownloadCaptureBroker()
