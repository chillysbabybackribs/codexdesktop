import assert from 'node:assert/strict'
import test from 'node:test'
import { PerformanceDiagnostics } from './performance-diagnostics.ts'

test('performance diagnostics summarizes runtime metrics and Web Vitals', () => {
  const diagnostics = new PerformanceDiagnostics()
  diagnostics.start()
  diagnostics.setTimelineSupport(['largest-contentful-paint', 'layout-shift', 'longtask'])
  diagnostics.setObserverSupport({ collectionStartedAtPageMs: 1000, interactions: true, longTasks: false })
  diagnostics.record('Page.lifecycleEvent', {
    name: 'load', frameId: 'main', loaderId: 'loader', timestamp: 12.5
  })
  diagnostics.record('PerformanceTimeline.timelineEventAdded', {
    event: {
      type: 'largest-contentful-paint', name: '', frameId: 'main', time: 12,
      lcpDetails: { renderTime: 1700000000.476, loadTime: 0, size: 24000, elementId: 'hero', nodeId: 42 }
    }
  })
  diagnostics.record('PerformanceTimeline.timelineEventAdded', {
    event: {
      type: 'layout-shift', name: '', frameId: 'main', time: 12.1,
      layoutShiftDetails: { value: 0.08, hadRecentInput: false, sources: [{ nodeId: 4 }] }
    }
  })
  diagnostics.record('PerformanceTimeline.timelineEventAdded', {
    event: { type: 'longtask', name: 'self', frameId: 'main', time: 12.2, duration: 0.075 }
  })

  const page = diagnostics.page({ metrics: [
    { name: 'Documents', value: 2 },
    { name: 'Nodes', value: 120 },
    { name: 'ScriptDuration', value: 0.125 },
    { name: 'TaskDuration', value: 0.5 },
    { name: 'JSHeapUsedSize', value: 2048 }
  ] }, { type: 'navigate', timeOriginMs: 1700000000000, pageAgeMs: 1400, loadEventMs: 420 })

  assert.equal(page.active, true)
  assert.equal(page.runtime.documents, 2)
  assert.equal(page.runtime.nodes, 120)
  assert.equal(page.runtime.durationsMs.script, 125)
  assert.equal(page.runtime.durationsMs.task, 500)
  assert.equal(page.runtime.heap.usedBytes, 2048)
  assert.equal(page.navigation?.loadEventMs, 420)
  assert.equal(page.lifecycle[0].name, 'load')
  assert.equal(page.webVitals.largestContentfulPaint?.lcp?.elementId, 'hero')
  assert.equal(page.webVitals.largestContentfulPaintMs, 476)
  assert.equal(page.webVitals.cumulativeLayoutShift, 0.08)
  assert.equal(page.webVitals.layoutShiftCount, 1)
  assert.equal(page.webVitals.longTaskCount, 1)
  assert.equal(page.webVitals.longTaskTotalMs, 75)
  assert.equal(page.webVitals.longTaskBlockingMs, 25)
  assert.equal(page.webVitals.longestTaskMs, 75)
  assert.equal(page.assessment.metrics.lcp.rating, 'good')
  assert.equal(page.assessment.metrics.cls.rating, 'good')
  assert.equal(page.assessment.metrics.inp.rating, 'unavailable')
  assert.equal(page.assessment.overallRating, 'incomplete')
  assert.equal(page.assessment.traceRecommended, true)
  assert.equal(page.scope.collectionStartedAtPageMs, 1000)
})

test('performance diagnostics remains bounded and excludes input-driven shifts from CLS', () => {
  const diagnostics = new PerformanceDiagnostics()
  diagnostics.start()
  for (let index = 0; index < 110; index += 1) {
    diagnostics.record('Page.lifecycleEvent', { name: `event-${index}`, timestamp: index })
    diagnostics.record('PerformanceTimeline.timelineEventAdded', {
      event: {
        type: 'layout-shift', time: index,
        layoutShiftDetails: { value: 0.01, hadRecentInput: index % 2 === 0, sources: [] }
      }
    })
  }

  const page = diagnostics.page({ metrics: [] }, null)
  assert.equal(page.lifecycle.length, 30)
  assert.equal(page.droppedLifecycleEvents, 14)
  assert.equal(page.droppedTimelineEvents, 14)
  assert.equal(page.webVitals.layoutShiftCount, 48)
  assert.equal(page.webVitals.cumulativeLayoutShift, 0.48)
  assert.equal(page.assessment.metrics.cls.rating, 'poor')
  assert.equal(page.assessment.overallRating, 'poor')
  assert.equal(page.assessment.traceRecommended, true)
})

test('performance diagnostics accepts drained page-observer long tasks', () => {
  const diagnostics = new PerformanceDiagnostics()
  diagnostics.start()
  diagnostics.setObserverSupport({ collectionStartedAtPageMs: 200, longTasks: true, interactions: true })
  diagnostics.recordObservedData({
    longTasks: [
      { name: 'self', startTime: 120, duration: 63.25 },
      { name: 'self', startTime: 240, duration: 80 }
    ],
    interactions: [
      { interactionId: 1, name: 'pointerdown', startTime: 100, duration: 180, processingStart: 120, processingEnd: 220 },
      { interactionId: 1, name: 'click', startTime: 110, duration: 240, processingStart: 130, processingEnd: 250 },
      { interactionId: 2, name: 'keydown', startTime: 260, duration: 96, processingStart: 270, processingEnd: 320 }
    ]
  })

  const page = diagnostics.page({ metrics: [] }, null)
  assert.equal(page.support.longTasks, 'performance-observer')
  assert.equal(page.support.interactions, 'performance-observer')
  assert.equal(page.webVitals.longTaskCount, 2)
  assert.equal(page.webVitals.longTaskTotalMs, 143.25)
  assert.equal(page.webVitals.longTaskBlockingMs, 43.25)
  assert.equal(page.webVitals.collectionLongTaskCount, 1)
  assert.equal(page.webVitals.collectionLongTaskBlockingMs, 30)
  assert.equal(page.webVitals.longestTaskMs, 80)
  assert.equal(page.webVitals.interactionCount, 2)
  assert.equal(page.webVitals.interactionToNextPaintMs, 240)
  assert.equal(page.webVitals.recentInteractions[0].name, 'click')
  assert.equal(page.webVitals.recentInteractions[0].inputDelayMs, 20)
  assert.equal(page.webVitals.recentInteractions[0].processingMs, 120)
  assert.equal(page.webVitals.recentInteractions[0].presentationDelayMs, 100)
  assert.equal(page.assessment.metrics.inp.rating, 'needs-improvement')
  assert.equal(page.assessment.overallRating, 'needs-improvement')
})
