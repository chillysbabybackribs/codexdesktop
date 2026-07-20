import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillMetadata } from '../../shared/codex-protocol/v2/SkillMetadata.js'
import {
  browserDynamicTools,
  buildGuidance,
  formatSkillInvocationText,
  isFastPathTask,
  isInteractiveBrowserTask,
  isLightweightVisualCheck,
  isLiveSiteCloneTask,
  isReadOnlyBrowserMicrotask,
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

const editorialWaitlistSkill: SkillMetadata = {
  name: 'superdesign-editorial-waitlist',
  description: 'Build editorial waitlist landing pages with the Superdesign reference contract',
  path: '/app/skills/superdesign-editorial-waitlist/SKILL.md',
  scope: 'user',
  enabled: true
}

const cloneLiveSiteSkill: SkillMetadata = {
  name: 'clone-live-site',
  description: 'Faithfully clone a permitted live site as a local frontend',
  path: '/app/skills/clone-live-site/SKILL.md',
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

test('authenticated browser state stays on the compact interactive path', () => {
  const prompt = 'Navigate to Reddit and tell me my last 3 notifications read or unread'
  assert.equal(isInteractiveBrowserTask(prompt), true)
  assert.equal(isReadOnlyBrowserMicrotask(prompt), true)
  assert.equal(isWebResearchTask(prompt), false)
  assert.deepEqual(selectTurnSkills(prompt, [webResearchSkill]), [])
  assert.equal(isWebResearchTask('Find recent Reddit discussions about Electron performance'), true)
  assert.equal(isWebResearchTask('Compare Reddit user reviews with public sources'), true)
  for (const authenticatedPrompt of [
    'Tell me my last 3 Reddit notifications',
    'What are my latest Reddit notifications?',
    'Check my Reddit notifications and compare the last 3',
    'Check my dashboard pricing',
    'Check the inbox customer reviews'
  ]) {
    assert.equal(isInteractiveBrowserTask(authenticatedPrompt), true, authenticatedPrompt)
    assert.equal(isWebResearchTask(authenticatedPrompt), false, authenticatedPrompt)
  }
  assert.equal(isWebResearchTask('Search online for public Reddit user reviews'), true)
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

test('editorial waitlist requests attach the reference skill with polished UI guidance', () => {
  assert.deepEqual(
    selectTurnSkills(
      'Build an editorial waitlist landing page for an invite-only architecture studio',
      [polishedUiSkill, editorialWaitlistSkill]
    ),
    [polishedUiSkill, editorialWaitlistSkill]
  )
})

test('ordinary waitlist requests do not force the editorial reference skill', () => {
  assert.deepEqual(
    selectTurnSkills('Build a simple waitlist landing page for a new app', [editorialWaitlistSkill]),
    []
  )
})

test('exact live-site clone requests attach clone and polished UI guidance', () => {
  const prompt = 'Clone https://example.com as an interactive local website'

  assert.equal(isLiveSiteCloneTask(prompt), true)
  assert.deepEqual(
    selectTurnSkills(prompt, [cloneLiveSiteSkill, polishedUiSkill]),
    [cloneLiveSiteSkill, polishedUiSkill]
  )
})

test('site redesign and inspiration requests do not attach the clone workflow', () => {
  for (const prompt of [
    'Build a better website like https://example.com',
    'Redesign https://example.com as a premium responsive website',
    'Improve the current website UI',
    'Create a site inspired by https://example.com'
  ]) {
    assert.equal(isLiveSiteCloneTask(prompt), false, prompt)
    assert.deepEqual(selectTurnSkills(prompt, [cloneLiveSiteSkill]), [], prompt)
  }

  assert.deepEqual(
    selectTurnSkills('Create a site inspired by https://example.com', [cloneLiveSiteSkill, polishedUiSkill]),
    [polishedUiSkill]
  )
  assert.deepEqual(
    selectTurnSkills('Make the current site better', [cloneLiveSiteSkill, polishedUiSkill]),
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
  assert.match(guidance, /prefer one `browser_snapshot` call/i)
  assert.match(guidance, /app_screenshot.*full Electron window/i)
  assert.match(guidance, /browser_screenshot.*browser tab only/i)
  assert.match(guidance, /only pass the result to `image\(\)`.*beginning with `data:image\//i)
  assert.match(guidance, /failed capture returns error text/i)
  assert.match(guidance, /simple visual confirmation.*one `app_screenshot`/i)
  assert.match(guidance, /artifact preview remain visible in chat/i)
  assert.match(guidance, /completion\.nextAction: "answer"/i)
  assert.match(guidance, /targeted-gap-fill/i)
  assert.match(guidance, /tables or fenced `chart` JSON only when they materially clarify/i)
  assert.doesNotMatch(guidance, /automatic git snapshotting is active/i)
  assert.doesNotMatch(guidance, /start by organizing|formal plan|multi-part answers/i)
  assert.match(guidance, /should normally use browser_research_dual/i)
})

test('browser guidance avoids obsolete compatibility fallbacks', () => {
  const guidance = buildGuidance({})
  assert.match(guidance, /browser_snapshot` call when it is available/)
  assert.match(guidance, /reserve `browser_run` for bespoke JavaScript/i)
  assert.doesNotMatch(guidance, /older resumed thread where newer tools are absent/)
  assert.doesNotMatch(guidance, /newer tools are absent/)
})

test('active autosnapshot guidance describes concurrent commit and push behavior', () => {
  const guidance = buildGuidance({
    CODEX_DESKTOP_AUTOGIT_ACTIVE: '1',
    CODEX_DESKTOP_AUTOGIT_PUSH_ENABLED: '1',
    CODEX_DESKTOP_AUTOGIT_TARGET_BRANCH: 'master',
    CODEX_DESKTOP_AUTOGIT_ROOT: '/workspace/codexdesktop'
  })

  assert.match(guidance, /automatic git snapshotting is active/i)
  assert.match(guidance, /monitors `\/workspace\/codexdesktop`/)
  assert.match(guidance, /commits settled safe changes.*pushes each autosnapshot.*`origin\/master`/i)
  assert.match(guidance, /re-read `git status`, `HEAD`, and the current branch/i)
  assert.match(guidance, /let the watcher own routine staging, commits, and pushes/i)
})

test('active autosnapshot guidance reports when automatic push is disabled', () => {
  const guidance = buildGuidance({
    CODEX_DESKTOP_AUTOGIT_ACTIVE: '1',
    CODEX_DESKTOP_AUTOGIT_PUSH_ENABLED: '0'
  })

  assert.match(guidance, /automatic pushing is disabled/i)
  assert.doesNotMatch(guidance, /pushes each autosnapshot/i)
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

test('all turns request concise reasoning summaries without changing their effort', () => {
  const policy = resolveTurnPolicy('Find recent firsthand Linux migration reports with sources')

  assert.deepEqual(policy, { summary: 'concise' })
  assert.equal('effort' in policy, false)
})

test('simple read-only browser tasks use the fastest supported effort while complex tasks honor the selection', () => {
  assert.equal(isFastPathTask('Check my last two Reddit notifications'), true)
  assert.equal(isFastPathTask('ok navigate to reddit and check the last 3 notifications for a speed test'), true)
  assert.equal(isFastPathTask('Refactor the tab manager and run its tests'), false)
  assert.deepEqual(resolveTurnPolicy('Check my last two Reddit notifications', {
    requestedEffort: 'high',
    supportedEfforts: ['minimal', 'low', 'medium', 'high']
  }), { summary: 'concise', effort: 'low' })
  assert.deepEqual(resolveTurnPolicy('Check my last two Reddit notifications', {
    fastMode: true,
    requestedEffort: 'high',
    supportedEfforts: ['minimal', 'low', 'medium', 'high']
  }), { summary: 'concise', effort: 'low' })
  assert.deepEqual(resolveTurnPolicy('Check my last two Reddit notifications', {
    requestedEffort: 'high',
    supportedEfforts: ['none', 'low', 'medium', 'high']
  }), { summary: 'concise', effort: 'none' })
  assert.deepEqual(resolveTurnPolicy('Review this local patch', {
    fastMode: true,
    requestedEffort: 'high',
    supportedEfforts: ['minimal', 'low', 'medium', 'high']
  }), { summary: 'concise' })
  assert.deepEqual(resolveTurnPolicy('Click the mark-all-read button in my notifications', {
    requestedEffort: 'high',
    supportedEfforts: ['minimal', 'low', 'medium', 'high']
  }), { summary: 'concise' })
  assert.deepEqual(resolveTurnPolicy('Check the inbox', {
    fastMode: true,
    requestedEffort: 'high',
    supportedEfforts: ['high']
  }), { summary: 'concise' })
})

test('simple current-UI checks use one low-effort visual pass', () => {
  const prompt = 'Can you view the current UI of the composer?'

  assert.equal(isLightweightVisualCheck(prompt), true)
  assert.equal(isFastPathTask(prompt), true)
  assert.equal(isLightweightVisualCheck('Review the current UI of the composer for accessibility problems'), false)
  assert.deepEqual(resolveTurnPolicy(prompt, {
    requestedEffort: 'high',
    supportedEfforts: ['none', 'low', 'medium', 'high']
  }), { summary: 'concise', effort: 'none' })
})

test('the dynamic tool surface includes verified research primitives', () => {
  assert.deepEqual(
    browserDynamicTools.map((tool) => tool.name),
    ['browser_live_search', 'browser_research_dual', 'browser_snapshot', 'browser_navigate', 'browser_screenshot', 'app_screenshot', 'ui_review', 'browser_flow', 'browser_network', 'browser_run', 'browser_extract_page', 'browser_cdp', 'research_web']
  )
  const browserSnapshot = browserDynamicTools.find(({ name }) => name === 'browser_snapshot')
  assert.equal(browserSnapshot?.type, 'function')
  if (!browserSnapshot || browserSnapshot.type !== 'function') assert.fail('browser_snapshot function tool is missing')
  const snapshotSchema = browserSnapshot.inputSchema as {
    required?: string[]
    properties: Record<string, { enum?: string[]; minimum?: number; maximum?: number; description?: string }>
  }
  assert.deepEqual(snapshotSchema.required, ['objective'])
  assert.deepEqual(snapshotSchema.properties.mode?.enum, ['task', 'content', 'interactive'])
  assert.deepEqual(snapshotSchema.properties.order?.enum, ['document', 'reverse-document'])
  assert.equal(snapshotSchema.properties.maxItems?.minimum, 1)
  assert.equal(snapshotSchema.properties.maxItems?.maximum, 200)
  assert.match(browserSnapshot.description, /one call/i)
  assert.match(browserSnapshot.description, /completion directive/i)
  assert.match(browserSnapshot.description, /targeted-gap-fill/i)
  assert.match(snapshotSchema.properties.selector?.description ?? '', /container selector/i)
  assert.match(snapshotSchema.properties.readySelector?.description ?? '', /snapshot can still succeed/i)
  const browserScreenshot = browserDynamicTools.find(({ name }) => name === 'browser_screenshot')
  assert.equal(browserScreenshot?.type, 'function')
  if (!browserScreenshot || browserScreenshot.type !== 'function') assert.fail('browser_screenshot function tool is missing')
  assert.deepEqual(Object.keys((browserScreenshot.inputSchema as { properties: Record<string, unknown> }).properties), ['tab'])
  assert.deepEqual((browserScreenshot.inputSchema as { required?: string[] }).required, undefined)
  const appScreenshot = browserDynamicTools.find(({ name }) => name === 'app_screenshot')
  assert.equal(appScreenshot?.type, 'function')
  if (!appScreenshot || appScreenshot.type !== 'function') assert.fail('app_screenshot function tool is missing')
  assert.deepEqual(Object.keys((appScreenshot.inputSchema as { properties: Record<string, unknown> }).properties), [])
  assert.match(appScreenshot.description, /full Codex Desktop window/i)
  assert.match(appScreenshot.description, /browser_screenshot/i)
  const uiReview = browserDynamicTools.find(({ name }) => name === 'ui_review')
  assert.equal(uiReview?.type, 'function')
  if (!uiReview || uiReview.type !== 'function') assert.fail('ui_review function tool is missing')
  assert.deepEqual(Object.keys((uiReview.inputSchema as { properties: Record<string, unknown> }).properties), ['tab', 'viewports'])
  const browserFlow = browserDynamicTools.find(({ name }) => name === 'browser_flow')
  assert.equal(browserFlow?.type, 'function')
  if (!browserFlow || browserFlow.type !== 'function') assert.fail('browser_flow function tool is missing')
  const flowSchema = browserFlow.inputSchema as {
    required?: string[]
    properties: {
      steps?: {
        minItems?: number
        maxItems?: number
        items?: { properties?: Record<string, { enum?: string[]; description?: string }> }
      }
    }
  }
  assert.deepEqual(flowSchema.required, ['steps'])
  assert.equal(flowSchema.properties.steps?.minItems, 1)
  assert.equal(flowSchema.properties.steps?.maxItems, 24)
  assert.deepEqual(flowSchema.properties.steps?.items?.properties?.type?.enum, ['fill', 'click', 'submit', 'wait', 'find'])
  assert.deepEqual(flowSchema.properties.steps?.items?.properties?.onMissing?.enum, ['stop', 'error'])
  assert.match(browserFlow.description, /missing find is successful/i)
  const browserNetwork = browserDynamicTools.find(({ name }) => name === 'browser_network')
  assert.equal(browserNetwork?.type, 'function')
  if (browserNetwork?.type !== 'function') assert.fail('browser_network function tool is missing')
  const networkSchema = browserNetwork.inputSchema as {
    required?: string[]
    properties: {
      match?: { required?: string[] }
      steps?: { minItems?: number; maxItems?: number }
      captureBody?: { type?: string }
      download?: { type?: string }
      stream?: {
        required?: string[]
        properties?: {
          transport?: { enum?: string[] }
          maxMessages?: { maximum?: number }
          idleMs?: { minimum?: number }
        }
      }
    }
  }
  assert.deepEqual(networkSchema.required, ['match'])
  assert.deepEqual(networkSchema.properties.match?.required, ['urlContains'])
  assert.equal(networkSchema.properties.steps?.minItems, 1)
  assert.equal(networkSchema.properties.steps?.maxItems, 24)
  assert.equal(networkSchema.properties.captureBody?.type, 'boolean')
  assert.equal(networkSchema.properties.download?.type, 'boolean')
  assert.deepEqual(networkSchema.properties.stream?.required, ['transport'])
  assert.deepEqual(networkSchema.properties.stream?.properties?.transport?.enum, ['sse', 'websocket'])
  assert.equal(networkSchema.properties.stream?.properties?.maxMessages?.maximum, 1000)
  assert.equal(networkSchema.properties.stream?.properties?.idleMs?.minimum, 50)
  assert.match(browserNetwork.description, /one model call/i)
  assert.match(browserNetwork.description, /SSE\/WebSocket stream/i)
  assert.match(browserNetwork.description, /Chromium download handoff as an artifact/i)
  const browserLiveSearch = browserDynamicTools.find(({ name }) => name === 'browser_live_search')
  assert.equal(browserLiveSearch?.type, 'function')
  if (!browserLiveSearch || browserLiveSearch.type !== 'function') assert.fail('browser_live_search function tool is missing')
  const liveSearchSchema = browserLiveSearch.inputSchema as {
    required?: string[]
    anyOf?: Array<{ required?: string[] }>
    properties: Record<string, { minItems?: number; maxItems?: number }>
  }
  assert.deepEqual(liveSearchSchema.required, ['objective'])
  assert.deepEqual(liveSearchSchema.anyOf, [{ required: ['query'] }, { required: ['queries'] }])
  assert.equal(liveSearchSchema.properties.queries?.minItems, 3)
  assert.equal(liveSearchSchema.properties.queries?.maxItems, 6)
  assert.match(browserLiveSearch.description, /parallel hidden Chromium workers/i)
  assert.match(browserLiveSearch.description, /Search result pages are never shown/i)
  const browserResearchDual = browserDynamicTools.find(({ name }) => name === 'browser_research_dual')
  assert.equal(browserResearchDual?.type, 'function')
  if (!browserResearchDual || browserResearchDual.type !== 'function') assert.fail('browser_research_dual function tool is missing')
  assert.match(browserResearchDual.description, /Quality-max default for search-shaped/i)
  assert.match(browserResearchDual.description, /broad source-backed research/i)
  assert.match(browserResearchDual.description, /live verification plus independent public evidence/i)
  const browserRun = browserDynamicTools.find(({ name }) => name === 'browser_run')
  assert.equal(browserRun?.type, 'function')
  if (!browserRun || browserRun.type !== 'function') assert.fail('browser_run function tool is missing')
  assert.match(browserRun.description, /explicitly `return`/i)
  assert.match(browserRun.description, /noResult/)
  assert.deepEqual(Object.keys((browserRun.inputSchema as { properties: Record<string, unknown> }).properties), [
    'code', 'tab', 'frame', 'timeoutMs', 'maxResultChars'
  ])
  const researchWeb = browserDynamicTools.find(({ name }) => name === 'research_web')
  assert.equal(researchWeb?.type, 'function')
  if (!researchWeb || researchWeb.type !== 'function') assert.fail('research_web function tool is missing')
  const researchProperties = (researchWeb.inputSchema as {
    properties: Record<string, {
      minimum?: number
      maximum?: number
      maxItems?: number
      description?: string
      items?: { required?: string[]; properties?: Record<string, { minimum?: number; maximum?: number }> }
    }>
    anyOf?: Array<{ required?: string[] }>
  }).properties
  const researchSchema = researchWeb.inputSchema as { anyOf?: Array<{ required?: string[] }> }
  assert.deepEqual(Object.keys(researchProperties), [
    'queries', 'urls', 'focus', 'maxResults', 'maxAttempts', 'snippetChars'
  ])
  assert.deepEqual(researchSchema.anyOf, [{ required: ['queries'] }, { required: ['urls'] }])
  assert.equal(researchProperties.urls?.maxItems, 8)
  assert.equal(researchProperties.queries?.maxItems, 6)
  assert.equal(researchProperties.focus?.maxItems, 6)
  assert.deepEqual(researchProperties.focus?.items?.required, ['id', 'need'])
  assert.equal(researchProperties.focus?.items?.properties?.minSources?.minimum, 1)
  assert.equal(researchProperties.focus?.items?.properties?.minSources?.maximum, 6)
  assert.equal(researchProperties.maxAttempts?.maximum, 24)
  assert.match(researchProperties.queries?.description ?? '', /single-angle phrase a person would actually type/i)
  assert.match(researchProperties.queries?.description ?? '', /parallel hidden Chromium workers/i)
  assert.match(researchProperties.snippetChars?.description ?? '', /returned evidence-passage budget/i)
  assert.match(researchWeb.description, /does not create or navigate a visible tab/i)
  assert.match(researchWeb.description, /model-authored evidence needs/i)
})

test('browser guidance defaults to the active tab and forbids implicit tab creation', () => {
  const guidance = buildGuidance()

  assert.match(guidance, /reuse the active visible browser tab/i)
  assert.match(guidance, /create a new tab only when the user explicitly requests one/i)
  assert.match(guidance, /CODEX_BROWSER_SOCK must target an existing tab id/i)
  assert.doesNotMatch(guidance, /dedicated browser tab/)
})
