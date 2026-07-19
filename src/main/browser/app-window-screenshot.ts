import type { BrowserWindow, WebContents } from 'electron'
import type { BrowserBounds } from '../../shared/ipc.js'

export type AppWindowCaptureTarget = {
  window: BrowserWindow
  browser: { webContents: WebContents; bounds: BrowserBounds } | null
}

export function compositeBitmap(
  base: Buffer,
  baseWidth: number,
  baseHeight: number,
  overlay: Buffer,
  overlayWidth: number,
  overlayHeight: number,
  destX: number,
  destY: number
): void {
  const bytesPerPixel = 4
  for (let y = 0; y < overlayHeight; y += 1) {
    const destRow = destY + y
    if (destRow < 0 || destRow >= baseHeight) continue
    for (let x = 0; x < overlayWidth; x += 1) {
      const destCol = destX + x
      if (destCol < 0 || destCol >= baseWidth) continue
      const overlayOffset = (y * overlayWidth + x) * bytesPerPixel
      const baseOffset = (destRow * baseWidth + destCol) * bytesPerPixel
      const alpha = overlay[overlayOffset + 3] ?? 255
      if (alpha === 0) continue
      if (alpha === 255) {
        base[baseOffset] = overlay[overlayOffset]
        base[baseOffset + 1] = overlay[overlayOffset + 1]
        base[baseOffset + 2] = overlay[overlayOffset + 2]
        base[baseOffset + 3] = 255
        continue
      }
      const inverse = 255 - alpha
      base[baseOffset] = Math.round((overlay[overlayOffset] * alpha + base[baseOffset] * inverse) / 255)
      base[baseOffset + 1] = Math.round((overlay[overlayOffset + 1] * alpha + base[baseOffset + 1] * inverse) / 255)
      base[baseOffset + 2] = Math.round((overlay[overlayOffset + 2] * alpha + base[baseOffset + 2] * inverse) / 255)
      base[baseOffset + 3] = 255
    }
  }
}

export async function captureAppWindowImage(
  target: AppWindowCaptureTarget,
  timeoutMs: number
): Promise<Electron.NativeImage> {
  const { window, browser } = target
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    throw new Error('app window is not available')
  }

  const [contentWidth, contentHeight] = window.getContentSize()
  const shellImage = await withTimeout(
    window.webContents.capturePage({ x: 0, y: 0, width: contentWidth, height: contentHeight }),
    timeoutMs,
    'app window shell capture timed out'
  )
  const scaleFactor = shellImage.getScaleFactors()[0] ?? 1
  const shellSize = shellImage.getSize(scaleFactor)
  const composite = Buffer.from(shellImage.toBitmap({ scaleFactor }))

  if (browser && !browser.webContents.isDestroyed()) {
    let browserImage = await withTimeout(
      browser.webContents.capturePage(),
      timeoutMs,
      'embedded browser capture timed out'
    )
    const browserScale = browserImage.getScaleFactors()[0] ?? scaleFactor
    const destWidth = Math.max(1, Math.round(browser.bounds.width * scaleFactor))
    const destHeight = Math.max(1, Math.round(browser.bounds.height * scaleFactor))
    const browserSize = browserImage.getSize(browserScale)
    if (browserSize.width !== destWidth || browserSize.height !== destHeight) {
      browserImage = browserImage.resize({ width: destWidth, height: destHeight, quality: 'best' })
    }
    compositeBitmap(
      composite,
      shellSize.width,
      shellSize.height,
      browserImage.toBitmap({ scaleFactor: browserScale }),
      destWidth,
      destHeight,
      Math.round(browser.bounds.x * scaleFactor),
      Math.round(browser.bounds.y * scaleFactor)
    )
  }

  return (await import('electron')).nativeImage.createFromBitmap(composite, {
    width: shellSize.width,
    height: shellSize.height,
    scaleFactor
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
