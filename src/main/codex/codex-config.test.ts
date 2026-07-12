import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js'
import {
  browserDynamicTools,
  buildGuidance,
  formatSkillInvocationText,
  isWebResearchTask,
  resolveTurnPolicy,
  selectNewThreadSkills,
  selectTurnSkills,
  shouldAttachPriorChatMemory
} from './codex-config.js'

const webResearchSkill: SkillMetadata = {
  name: 'artifact-first-web-research',
  description: 'Research the web from saved artifacts',
  path: '/app/skills/artifact-first-web-research/SKILL.md',
  scope: 'user',
  enabled: true
}

const priorChatMemorySkill: SkillMetadata = {
  name: 'prior-chat-memory',
  description: 'Recover relevant context from the previous chat',
  path: '/app/skills/prior-chat-memory/SKILL.md',
  scope: 'user',
  enabled: true
}

const polishedUiSkill: SkillMetadata = {
  name: 'build-polished-ui',
  description: 'Design and build polished responsive interfaces',
  path: '/app/skills/build-polished-ui/SKILL.md',
  scope: 'user',
  enabled: true
}

const imagegenSkill: SkillMetadata = {
  name: 'imagegen',
  description: 'Generate or edit project-bound raster assets',
  path: '/app/skills/imagegen/SKILL.md',
  scope: 'user',
  enabled: true
}

test('web research turns attach the extraction skill', () => {
  assert.deepEqual(
    selectTurnSkills('Research the latest Electron navigation guidance', [webResearchSkill]),
    [webResearchSkill]
  )
})

test('unrelated implementation turns do not load the extraction skill', () => {
  assert.deepEqual(
    selectTurnSkills('Refactor the tab manager and run its tests', [webResearchSkill]),
    []
  )
})

test('local review and explanation requests do not load web research', () => {
  assert.deepEqual(selectTurnSkills('Review this patch for regressions', [webResearchSkill]), [])
  assert.deepEqual(selectTurnSkills('What is this module responsible for?', [webResearchSkill]), [])
  assert.deepEqual(selectTurnSkills('Compare these two local config files', [webResearchSkill]), [])
})

test('fresh public-source requests load web research', () => {
  assert.equal(isWebResearchTask('Check the latest official Electron documentation'), true)
  assert.equal(isWebResearchTask('Find current pricing from public sources'), true)
  assert.equal(isWebResearchTask('Review this local patch'), false)
})

test('frontend design turns automatically attach the polished UI skill', () => {
  assert.deepEqual(
    selectTurnSkills('Build a polished responsive dashboard UI', [polishedUiSkill]),
    [polishedUiSkill]
  )
})

test('media-led website turns attach both polished UI and image generation guidance', () => {
  assert.deepEqual(
    selectTurnSkills('Create a premium responsive coffee shop website', [polishedUiSkill, imagegenSkill]),
    [polishedUiSkill, imagegenSkill]
  )
})

test('product dashboards do not attach image generation guidance by default', () => {
  assert.deepEqual(
    selectTurnSkills('Design a responsive operations dashboard UI', [polishedUiSkill, imagegenSkill]),
    [polishedUiSkill]
  )
})

test('unrelated coding turns do not load the polished UI skill', () => {
  assert.deepEqual(
    selectTurnSkills('Refactor the tab manager and run its tests', [polishedUiSkill]),
    []
  )
})

test('an explicit skill mention always attaches it', () => {
  assert.deepEqual(
    selectTurnSkills('Use $artifact-first-web-research for this task', [webResearchSkill]),
    [webResearchSkill]
  )
})

test('automatic skill invocation adds the app-server text marker', () => {
  assert.equal(
    formatSkillInvocationText('Research Electron navigation', [webResearchSkill]),
    '$artifact-first-web-research\nResearch Electron navigation'
  )
})

test('explicit skill invocation does not duplicate its marker', () => {
  const text = '$artifact-first-web-research Research Electron navigation'
  assert.equal(formatSkillInvocationText(text, [webResearchSkill]), text)
})

test('ambiguous continuation threads attach prior chat memory', () => {
  assert.equal(shouldAttachPriorChatMemory('lets continue'), true)
  assert.equal(shouldAttachPriorChatMemory('Pick this back up from where we left off'), true)
  assert.deepEqual(selectNewThreadSkills('lets continue', [webResearchSkill, priorChatMemorySkill]), [priorChatMemorySkill])
})

test('standalone new threads do not attach prior chat memory', () => {
  assert.equal(shouldAttachPriorChatMemory('Build a settings page'), false)
  assert.deepEqual(selectNewThreadSkills('Build a settings page', [priorChatMemorySkill]), [])
})

test('memory skill does not require a synthetic invocation marker', () => {
  assert.equal(formatSkillInvocationText('lets continue', []), 'lets continue')
})

test('guidance nudges ambiguous continuation without requesting improvement cards', () => {
  const guidance = buildGuidance({})
  assert.match(guidance, /ambiguous opening requests.*use the prior-chat-memory skill/i)
  assert.doesNotMatch(guidance, /app-improvement|self-improvement reporting/i)
  assert.doesNotMatch(guidance, /protected codex desktop host session/i)
})

test('global guidance stays limited to product-wide behavior', () => {
  const guidance = buildGuidance({})

  assert.match(guidance, /reuse the active visible browser tab/i)
  assert.match(guidance, /tables or fenced `chart` JSON only when they materially clarify/i)
  assert.doesNotMatch(guidance, /start by organizing|formal plan|research_web|browser_run|multi-part answers/i)
})

test('self-hosted guidance protects the exact host session and routes live checks to an isolated instance', () => {
  const guidance = buildGuidance({
    CODEX_DESKTOP_SELF_HOSTED: '1',
    CODEX_DESKTOP_INSTANCE_ROLE: 'host',
    CODEX_DESKTOP_HOST_SESSION_ID: 'session-123',
    CODEX_DESKTOP_HOST_PID: '4100',
    CODEX_DESKTOP_DEV_SERVER_PID: '4000'
  })

  assert.match(guidance, /session session-123 \(role=host, Electron PID=4100, parent\/dev-server PID=4000\)/)
  assert.match(guidance, /process tree as protected infrastructure/)
  assert.match(guidance, /never signal, terminate, restart, replace/i)
  assert.match(guidance, /npm run verify:app/)
  assert.match(guidance, /do not run `npm run dev` or `npm run dev:app`/i)
})

test('research turns keep the configured reasoning effort', () => {
  const policy = resolveTurnPolicy('Find recent firsthand Linux migration reports with sources')

  assert.deepEqual(policy, { summary: 'concise' })
  assert.equal('effort' in policy, false)
})

test('implementation turns use automatic reasoning summaries', () => {
  assert.deepEqual(resolveTurnPolicy('Refactor the tab manager and run its tests'), { summary: 'auto' })
  assert.deepEqual(resolveTurnPolicy('Review this local patch'), { summary: 'auto' })
})

test('the dynamic tool surface includes verified research primitives', () => {
  assert.deepEqual(
    browserDynamicTools.map((tool) => tool.name),
    ['browser_screenshot', 'ui_review', 'browser_run', 'browser_extract_page', 'browser_cdp', 'research_web']
  )
  const browserScreenshot = browserDynamicTools.find(({ name }) => name === 'browser_screenshot')
  assert.equal(browserScreenshot?.type, 'function')
  if (!browserScreenshot || browserScreenshot.type !== 'function') assert.fail('browser_screenshot function tool is missing')
  assert.deepEqual(Object.keys((browserScreenshot.inputSchema as { properties: Record<string, unknown> }).properties), ['tab'])
  assert.deepEqual((browserScreenshot.inputSchema as { required?: string[] }).required, undefined)
  const uiReview = browserDynamicTools.find(({ name }) => name === 'ui_review')
  assert.equal(uiReview?.type, 'function')
  if (!uiReview || uiReview.type !== 'function') assert.fail('ui_review function tool is missing')
  assert.deepEqual(Object.keys((uiReview.inputSchema as { properties: Record<string, unknown> }).properties), ['tab', 'viewports'])
  const browserRun = browserDynamicTools.find(({ name }) => name === 'browser_run')
  assert.equal(browserRun?.type, 'function')
  if (!browserRun || browserRun.type !== 'function') assert.fail('browser_run function tool is missing')
  assert.deepEqual(Object.keys((browserRun.inputSchema as { properties: Record<string, unknown> }).properties), [
    'code', 'tab', 'frame', 'timeoutMs', 'maxResultChars'
  ])
  const researchWeb = browserDynamicTools.find(({ name }) => name === 'research_web')
  assert.equal(researchWeb?.type, 'function')
  if (!researchWeb || researchWeb.type !== 'function') assert.fail('research_web function tool is missing')
  const researchProperties = (researchWeb.inputSchema as {
    properties: Record<string, { minimum?: number; maximum?: number; description?: string }>
  }).properties
  assert.deepEqual(Object.keys(researchProperties), ['queries', 'maxResults', 'maxPages', 'maxAttempts', 'snippetChars'])
  assert.equal(researchProperties.maxPages?.maximum, 3)
  assert.equal(researchProperties.maxAttempts?.maximum, 8)
  assert.match(researchProperties.queries?.description ?? '', /primary discovery query/i)
})

test('browser guidance defaults to the active tab and forbids implicit tab creation', () => {
  const guidance = buildGuidance()

  assert.match(guidance, /reuse the active visible browser tab/i)
  assert.match(guidance, /create a new tab only when the user explicitly requests one/i)
  assert.match(guidance, /CODEX_BROWSER_SOCK must target an existing tab id/i)
  assert.doesNotMatch(guidance, /dedicated browser tab/)
})
