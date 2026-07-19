import type { BrowserAgentController, BrowserAgentResult } from '../browser/browser-agent.js'

export type UiReviewViewportName = 'desktop' | 'tablet' | 'mobile'

type UiReviewViewport = {
  name: UiReviewViewportName
  width: number
  height: number
  mobile: boolean
}

const viewports: Record<UiReviewViewportName, UiReviewViewport> = {
  desktop: { name: 'desktop', width: 1440, height: 900, mobile: false },
  tablet: { name: 'tablet', width: 820, height: 1180, mobile: false },
  mobile: { name: 'mobile', width: 390, height: 844, mobile: true }
}

const auditProgram = `
const visible = (element) => {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
};
const label = (element) => (element.getAttribute('aria-label') || element.textContent || element.tagName).trim().replace(/\\s+/g, ' ').slice(0, 80);
const interactive = [...document.querySelectorAll('a, button, input, select, textarea, [role="button"], [tabindex]')]
  .filter(visible)
  .map((element) => {
    const rect = element.getBoundingClientRect();
    return { label: label(element), tag: element.tagName.toLowerCase(), width: Math.round(rect.width), height: Math.round(rect.height) };
  });
const clipped = [...document.body.querySelectorAll('*')].slice(0, 5000)
  .filter(visible)
  .map((element) => ({ element, rect: element.getBoundingClientRect() }))
  .filter(({ rect }) => rect.right > document.documentElement.clientWidth + 1 || rect.left < -1)
  .slice(0, 20)
  .map(({ element, rect }) => ({ label: label(element), tag: element.tagName.toLowerCase(), left: Math.round(rect.left), right: Math.round(rect.right) }));
const images = [...document.images].map((image) => ({
  alt: image.getAttribute('alt'),
  src: (image.currentSrc || image.src).slice(0, 240),
  complete: image.complete,
  naturalWidth: image.naturalWidth,
  naturalHeight: image.naturalHeight,
  width: Math.round(image.getBoundingClientRect().width),
  height: Math.round(image.getBoundingClientRect().height)
}));
return {
  verified: document.readyState === 'complete' && Boolean(document.body),
  title: document.title,
  url: location.href,
  viewport: { width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth },
  document: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
  horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  headings: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0, 80).map((heading) => ({ level: Number(heading.tagName.slice(1)), text: label(heading) })),
  landmarks: [...document.querySelectorAll('header,nav,main,aside,footer,[role="banner"],[role="navigation"],[role="main"],[role="complementary"],[role="contentinfo"]')].slice(0, 40).map((element) => ({ tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), label: element.getAttribute('aria-label') })),
  controls: {
    count: interactive.length,
    touchViewport: innerWidth <= 820,
    undersizedTouchTargets: innerWidth <= 820 ? interactive.filter(({ width, height }) => width < 44 || height < 44).slice(0, 40) : []
  },
  clipped,
  images: {
    count: images.length,
    broken: images.filter((image) => image.complete && image.naturalWidth === 0),
    missingAlt: images.filter((image) => image.alt === null).map(({ src }) => src).slice(0, 30),
    items: images.slice(0, 40)
  },
  fonts: document.fonts ? { status: document.fonts.status } : null,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
};
`

export async function runUiReview(
  browserAgent: BrowserAgentController,
  requestedViewports: unknown,
  options: { tabId?: string; signal?: AbortSignal } = {}
): Promise<{ result: BrowserAgentResult; imageUrls: string[] }> {
  const { tabId, signal } = options
  const selected = resolveViewports(requestedViewports)
  const reviews: Array<Record<string, unknown>> = []
  const imageUrls: string[] = []

  try {
    for (const viewport of selected) {
      const emulation = await browserAgent.cdp('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.mobile
      }, { tabId, signal })
      if (!emulation.ok) return { result: emulation, imageUrls }

      const audit = await browserAgent.run(auditProgram, { tabId, timeoutMs: 10_000, maxResultChars: 40_000, signal })
      if (!audit.ok) return { result: audit, imageUrls }

      const capture = await browserAgent.cdp('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false
      }, { tabId, timeoutMs: 15_000, signal })
      if (!capture.ok) return { result: capture, imageUrls }

      const screenshot = asRecord(asRecord(capture.result).screenshot)
      const artifactPath = readString(screenshot.artifactPath)
      if (!artifactPath) {
        return { result: { ok: false, error: `ui_review ${viewport.name} capture did not produce an artifact` }, imageUrls }
      }
      const imageUrl = await browserAgent.readScreenshotDataUrl(artifactPath)
      if (!imageUrl) {
        return { result: { ok: false, error: `ui_review ${viewport.name} capture could not be loaded for model vision` }, imageUrls }
      }
      imageUrls.push(imageUrl)
      reviews.push({
        name: viewport.name,
        requested: { width: viewport.width, height: viewport.height },
        audit: audit.result,
        screenshot
      })
    }

    const exceptions = await browserAgent.cdpEvents({ tabId, limit: 20, signal }, 'Runtime.exceptionThrown')
    const failedRequests = await browserAgent.cdpEvents({ tabId, limit: 20, signal }, 'Network.loadingFailed')
    return {
      result: {
        ok: true,
        result: {
          uiReview: {
            viewports: reviews,
            runtimeExceptions: exceptions.ok ? exceptions.result : { unavailable: exceptions.error },
            failedRequests: failedRequests.ok ? failedRequests.result : { unavailable: failedRequests.error }
          }
        },
        tabId: reviews.length ? readString(asRecord(reviews[0].screenshot).tabId) : tabId
      },
      imageUrls
    }
  } finally {
    await browserAgent.cdp('Emulation.clearDeviceMetricsOverride', {}, { tabId }).catch(() => undefined)
  }
}

export function resolveViewports(requested: unknown): UiReviewViewport[] {
  const names = Array.isArray(requested)
    ? requested.filter((value): value is UiReviewViewportName => typeof value === 'string' && value in viewports)
    : []
  const unique = [...new Set<UiReviewViewportName>(names)]
  const defaults: UiReviewViewportName[] = ['desktop', 'tablet', 'mobile']
  return (unique.length ? unique : defaults).map((name) => viewports[name])
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
