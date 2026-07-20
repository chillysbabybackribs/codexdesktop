import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadItem } from '../../shared/session-protocol/index.ts'
import type { WorkItem } from './activity-model.ts'
import { cdpFileArtifact, cdpScreenshotArtifact, cdpScreenshotArtifacts } from './cdp-artifacts.ts'

type DynamicToolCallItem = Extract<ThreadItem, { type: 'dynamicToolCall' }>

const toolCall = (over: Partial<DynamicToolCallItem> = {}): DynamicToolCallItem => ({
  type: 'dynamicToolCall',
  id: 'tool-1',
  namespace: null,
  tool: 'browser_screenshot',
  arguments: {},
  status: 'completed',
  contentItems: null,
  success: true,
  durationMs: 100,
  ...over
})

const screenshotPayload = {
  artifactPath: '/tmp/artifacts/shot-1.png',
  fileName: 'shot-1.png',
  mediaType: 'image/png',
  bytes: 12_345,
  width: 800,
  height: 600
}

const screenshotItem = (over: Partial<DynamicToolCallItem> = {}): DynamicToolCallItem =>
  toolCall({
    contentItems: [{ type: 'inputText', text: JSON.stringify({ screenshot: screenshotPayload }) }],
    ...over
  })

test('cdpScreenshotArtifact extracts a flat screenshot payload', () => {
  assert.deepEqual(cdpScreenshotArtifact(screenshotItem()), screenshotPayload)
})

test('cdpScreenshotArtifact unwraps payloads nested under result', () => {
  const item = toolCall({
    tool: 'browser_cdp',
    contentItems: [{ type: 'inputText', text: JSON.stringify({ result: { screenshot: screenshotPayload } }) }]
  })
  assert.deepEqual(cdpScreenshotArtifact(item), screenshotPayload)
})

test('cdpScreenshotArtifact defaults missing dimensions to null', () => {
  const { width: _w, height: _h, ...withoutDims } = screenshotPayload
  const item = toolCall({
    tool: 'app_screenshot',
    contentItems: [{ type: 'inputText', text: JSON.stringify({ screenshot: withoutDims }) }]
  })
  assert.deepEqual(cdpScreenshotArtifact(item), { ...withoutDims, width: null, height: null })
})

test('cdpScreenshotArtifact ignores other tools, bad JSON, and partial payloads', () => {
  assert.equal(cdpScreenshotArtifact(screenshotItem({ tool: 'browser_run' })), null)
  assert.equal(
    cdpScreenshotArtifact(toolCall({ contentItems: [{ type: 'inputText', text: 'not json' }] })),
    null
  )
  const missingPath = { ...screenshotPayload, artifactPath: undefined }
  assert.equal(
    cdpScreenshotArtifact(
      toolCall({ contentItems: [{ type: 'inputText', text: JSON.stringify({ screenshot: missingPath }) }] })
    ),
    null
  )
  assert.equal(cdpScreenshotArtifact(toolCall({ contentItems: null })), null)
})

test('cdpScreenshotArtifacts dedupes by artifact path and skips other items', () => {
  const other = { ...screenshotPayload, artifactPath: '/tmp/artifacts/shot-2.png', fileName: 'shot-2.png' }
  const reasoning: WorkItem = { type: 'reasoning', id: 'thought-1', summary: [], content: [] }
  const items: WorkItem[] = [
    reasoning,
    screenshotItem({ id: 'tool-1' }),
    screenshotItem({ id: 'tool-2' }), // duplicate artifactPath
    toolCall({
      id: 'tool-3',
      contentItems: [{ type: 'inputText', text: JSON.stringify({ screenshot: other }) }]
    })
  ]
  assert.deepEqual(cdpScreenshotArtifacts(items), [screenshotPayload, other])
  assert.deepEqual(cdpScreenshotArtifacts([reasoning]), [])
})

test('cdpFileArtifact extracts pdf/trace payloads from browser_cdp only', () => {
  const pdf = {
    artifactPath: '/tmp/artifacts/page.pdf',
    fileName: 'page.pdf',
    mediaType: 'application/pdf',
    kind: 'pdf',
    bytes: 2_048
  }
  const pdfItem = toolCall({
    tool: 'browser_cdp',
    contentItems: [{ type: 'inputText', text: JSON.stringify({ result: { pdf } }) }]
  })
  assert.deepEqual(cdpFileArtifact(pdfItem), pdf)

  // mediaType defaults to '' when the payload omits it.
  const { mediaType: _m, ...traceNoMedia } = {
    artifactPath: '/tmp/artifacts/run.trace',
    fileName: 'run.trace',
    mediaType: 'application/json',
    kind: 'trace',
    bytes: 512
  }
  const traceItem = toolCall({
    tool: 'browser_cdp',
    contentItems: [{ type: 'inputText', text: JSON.stringify({ trace: traceNoMedia }) }]
  })
  assert.deepEqual(cdpFileArtifact(traceItem), { ...traceNoMedia, mediaType: '' })

  // Wrong tool or unknown kind is not a file artifact.
  assert.equal(cdpFileArtifact(toolCall({ contentItems: [{ type: 'inputText', text: JSON.stringify({ pdf }) }] })), null)
  const badKind = { ...pdf, kind: 'zip' }
  assert.equal(
    cdpFileArtifact(
      toolCall({ tool: 'browser_cdp', contentItems: [{ type: 'inputText', text: JSON.stringify({ pdf: badKind }) }] })
    ),
    null
  )
})
