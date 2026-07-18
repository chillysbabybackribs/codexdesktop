#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { performance } from 'node:perf_hooks'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { browserDynamicTools, buildGuidance } from '../src/main/codex/codex-config.js'
import { buildPageSnapshotProgram } from '../src/main/browser/page-snapshot.js'

const CANONICAL_PROMPT = 'Using the already-open Reddit notifications page, tell me the latest 3 notifications and whether each is read or unread. Do not click anything or change notification state.'
const SNAPSHOT_OBJECTIVE = 'latest 3 Reddit notifications and whether each is read or unread'
const MODEL_TIMEOUT_MS = 5 * 60_000
const LEGACY_REFERENCE = {
  kind: 'static-audit-reference',
  traceId: '019f770b-3dad-74b0-ad72-1d3692843e67',
  prompt: 'ok navigate to reddit and check the last 3 notifications read or unread and monitor this for a speed test',
  wallMs: 40_419,
  firstToolLatencyMs: 23_545,
  modelCallCount: 4,
  browserToolDurationSumMs: 402,
  exactThreeAndState: true,
  note: 'Previously captured production trace; metadata is a fixed comparison point and is not rerun by this harness.'
}

const ORACLE_PROGRAM = `return (() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const rows = Array.from(document.querySelectorAll('rpl-inbox-row')).slice(0, 3);
  return {
    url: location.href,
    title: document.title,
    rows: rows.map((row, index) => {
      const links = Array.from(row.querySelectorAll('a[href]'));
      const href = links.map((link) => link.href).find((value) => /\\/comments\\//.test(value)) || links[0]?.href || '';
      const time = row.querySelector('time');
      const text = clean(row.innerText || row.textContent).slice(0, 800);
      const unread = row.hasAttribute('selected') || row.getAttribute('aria-selected') === 'true';
      return {
        index,
        id: row.id || row.getAttribute('data-id') || row.getAttribute('data-testid') || href || text.slice(0, 160),
        unread,
        read: !unread,
        text,
        href,
        datetime: time?.getAttribute('datetime') || clean(time?.textContent || '')
      };
    })
  };
})();`

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const startedAt = new Date()
  const socketPath = requireSocketPath()
  const initialTabsResponse = await socketJson(socketPath, 'GET', '/tabs')
  const initialTabs = requireTabs(initialTabsResponse)
  const tab = requireActiveRedditNotificationsTab(initialTabs)
  const context = { socketPath, tabId: tab.id, expectedUrl: tab.url }
  const oracleBefore = await captureOracle(context)
  const direct = await runDirectArm(context, oracleBefore, options.samples)
  const tabsAfterDirect = requireTabs(await socketJson(socketPath, 'GET', '/tabs'))
  const oracleAfterDirect = await captureOracle(context)
  direct.oracleUnchanged = sameOracle(oracleBefore, oracleAfterDirect)
  direct.tabsUnchanged = sameTabs(initialTabs, tabsAfterDirect)

  let model
  if (options.skipModel) {
    model = { skipped: true, reason: '--skip-model' }
  } else {
    try {
      model = await runModelArm(context, oracleAfterDirect, options)
    } catch (error) {
      model = { ok: false, error: errorMessage(error) }
    }
  }

  const finalTabs = requireTabs(await socketJson(socketPath, 'GET', '/tabs'))
  const oracleAfter = await captureOracle(context)
  const hostUnchanged = sameOracle(oracleBefore, oracleAfter) && sameTabs(initialTabs, finalTabs)
  if (!options.skipModel) {
    model.oracleUnchanged = sameOracle(oracleAfterDirect, oracleAfter)
    model.tabsUnchanged = sameTabs(tabsAfterDirect, finalTabs)
  }

  const report = {
    schemaVersion: 1,
    ok: direct.successCount === options.samples && hostUnchanged && (options.skipModel || model.ok === true),
    observedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    codexCli: codexVersion(),
    config: {
      samples: options.samples,
      model: options.model,
      effort: options.effort,
      skipModel: options.skipModel,
      canonicalPrompt: CANONICAL_PROMPT,
      snapshotObjective: SNAPSHOT_OBJECTIVE,
      productionDynamicTools: browserDynamicTools.map(({ name }) => name),
      productionGuidanceChars: buildGuidance().length
    },
    safety: {
      explicitTabId: tab.id,
      initialUrl: tab.url,
      activeTabRequired: true,
      createdTabs: false,
      navigationPerformed: false,
      notificationActionsPerformed: false,
      hostUnchanged
    },
    oracle: {
      before: oracleProjection(oracleBefore),
      afterDirect: oracleProjection(oracleAfterDirect),
      after: oracleProjection(oracleAfter),
      unchanged: sameOracle(oracleBefore, oracleAfter)
    },
    direct,
    model,
    legacyReference: LEGACY_REFERENCE,
    comparison: {
      ...(model.ok && typeof model.wallMs === 'number'
        ? { endToEndWallSpeedupVsLegacy: round(LEGACY_REFERENCE.wallMs / model.wallMs, 2) }
        : {}),
      qualityPreserved: direct.exactSnapshotCount === options.samples &&
        (options.skipModel || model.accuracy?.exactThreeAndState === true) && hostUnchanged
    }
  }

  if (options.output) {
    const outputPath = resolve(options.output)
    report.output = outputPath
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

async function runDirectArm(context, oracle, sampleCount) {
  const program = buildPageSnapshotProgram({
    objective: SNAPSHOT_OBJECTIVE,
    mode: 'task',
    maxItems: 3,
    maxChars: 8_000
  })
  const samples = []
  let preview = null

  for (let index = 1; index <= sampleCount; index += 1) {
    const startedAt = performance.now()
    let response
    try {
      response = await postEval(context, program, { timeoutMs: 15_000, maxResultChars: 20_000 })
    } catch (error) {
      samples.push({ index, ok: false, wallMs: round(performance.now() - startedAt, 3), error: errorMessage(error) })
      continue
    }
    const wallMs = round(performance.now() - startedAt, 3)
    const snapshot = asRecord(response.result)
    const quality = evaluateSnapshot(snapshot, oracle)
    const ok = response.ok === true && asRecord(snapshot.page).url === context.expectedUrl
    samples.push({
      index,
      ok,
      wallMs,
      returnedDurationMs: finiteNumber(response.durationMs),
      outputChars: finiteNumber(response.resultChars) ?? JSON.stringify(response.result ?? null).length,
      snapshotDurationMs: finiteNumber(asRecord(snapshot.timings).totalMs),
      itemCount: Array.isArray(snapshot.items) ? snapshot.items.length : 0,
      exactThreeAndState: quality.exactThreeAndState,
      ...(ok ? {} : { error: response.error || 'snapshot response did not match the explicit Reddit tab' })
    })
    if (!preview && ok) preview = compactSnapshotPreview(snapshot, quality)
  }

  const successful = samples.filter(({ ok }) => ok)
  return {
    samplesRequested: sampleCount,
    sampleCount: samples.length,
    successCount: successful.length,
    successRate: round(successful.length / sampleCount, 4),
    exactSnapshotCount: samples.filter(({ exactThreeAndState }) => exactThreeAndState).length,
    metrics: {
      wallMs: summarizeNumbers(samples.map(({ wallMs }) => wallMs)),
      returnedDurationMs: summarizeNumbers(successful.map(({ returnedDurationMs }) => returnedDurationMs)),
      snapshotDurationMs: summarizeNumbers(successful.map(({ snapshotDurationMs }) => snapshotDurationMs)),
      outputChars: summarizeNumbers(successful.map(({ outputChars }) => outputChars))
    },
    preview,
    samples
  }
}

async function runModelArm(context, oracle, options) {
  const harness = new AppServerHarness(context)
  try {
    await harness.start()
    const thread = await harness.request('thread/start', {
      cwd: process.cwd(),
      model: options.model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      historyMode: 'legacy',
      ephemeral: true,
      config: {
        web_search: 'disabled',
        model_reasoning_effort: options.effort,
        model_reasoning_summary: 'concise'
      },
      dynamicTools: browserDynamicTools,
      developerInstructions: buildGuidance()
    })

    const turnStartedAt = performance.now()
    const turnResponse = await harness.request('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: CANONICAL_PROMPT, text_elements: [] }],
      model: options.model,
      effort: options.effort,
      summary: 'concise',
      approvalPolicy: 'never'
    })
    harness.registerTurnStart(turnResponse.turn.id, turnStartedAt)
    const completed = await harness.waitForTurn(turnResponse.turn.id)
    const wallMs = round(performance.now() - turnStartedAt, 3)
    const toolCalls = harness.toolCallsForTurn(turnResponse.turn.id)
    const tokenEvents = dedupeTokenCalls(harness.tokenEventsForTurn(turnResponse.turn.id))
    const finalResponse = finalAgentResponse(completed)
    const accuracy = evaluateModelResponse(finalResponse, oracle)
    const lastUsage = tokenEvents.at(-1) ?? null
    const completedToolItems = (completed.items ?? []).filter((item) =>
      ['dynamicToolCall', 'mcpToolCall', 'commandExecution', 'webSearch'].includes(item.type)
    )

    return {
      ok: completed.status === 'completed' && accuracy.exactThreeAndState,
      skipped: false,
      threadId: thread.thread.id,
      turnId: completed.id,
      requestedModel: options.model,
      effectiveModel: thread.model,
      requestedEffort: options.effort,
      effectiveEffort: thread.reasoningEffort,
      status: completed.status,
      error: completed.error,
      wallMs,
      firstToolLatencyMs: harness.firstToolLatencyForTurn(turnResponse.turn.id),
      modelCallCount: tokenEvents.length,
      toolCallCount: Math.max(toolCalls.length, completedToolItems.length),
      failedToolCallCount: toolCalls.filter(({ ok }) => !ok).length,
      toolDurationSumMs: round(sum(toolCalls.map(({ durationMs }) => durationMs)), 3),
      tokens: lastUsage ? {
        accumulated: lastUsage.total,
        latestCall: lastUsage.last,
        modelContextWindow: lastUsage.modelContextWindow,
        calls: tokenEvents.map(({ last, modelContextWindow }) => ({ ...last, modelContextWindow }))
      } : null,
      toolCalls,
      finalResponse,
      accuracy
    }
  } finally {
    await harness.stop()
  }
}

class AppServerHarness {
  constructor(context) {
    this.context = context
    this.requestId = 0
    this.pending = new Map()
    this.completedTurns = new Map()
    this.turnWaiters = new Map()
    this.tokensByTurn = new Map()
    this.toolCallsByTurn = new Map()
    this.turnStartedAt = new Map()
    this.firstToolAt = new Map()
    this.stderr = []
  }

  async start() {
    const childEnv = { ...process.env }
    delete childEnv.CODEX_BROWSER_SOCK
    this.child = spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      this.stderr.push(String(chunk).trim())
      this.stderr = this.stderr.slice(-20)
    })
    this.child.on('exit', (code, signal) => {
      const error = new Error(`benchmark app-server exited (${code ?? signal ?? 'unknown'})`)
      for (const pending of this.pending.values()) pending.reject(error)
      for (const waiter of this.turnWaiters.values()) waiter.reject(error)
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line))
    await this.request('initialize', {
      clientInfo: { name: 'codexdesktop-browser-eval', title: 'Codex Desktop Browser Eval', version: '1.0.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: ['rawResponseItem/completed']
      }
    })
    this.notify('initialized')
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null || this.child.killed) return
    this.child.kill()
    await new Promise((resolveExit) => {
      const timer = setTimeout(resolveExit, 2_000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolveExit()
      })
    })
  }

  request(method, params) {
    const id = `browser-eval-${++this.requestId}`
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}`))
      }, MODEL_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolveRequest(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id, result) {
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id, message) {
    this.write({ jsonrpc: '2.0', id, error: { code: -32601, message } })
  }

  registerTurnStart(turnId, startedAt) {
    this.turnStartedAt.set(turnId, startedAt)
  }

  waitForTurn(turnId) {
    if (this.completedTurns.has(turnId)) return Promise.resolve(this.completedTurns.get(turnId))
    return new Promise((resolveTurn, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId)
        reject(new Error(`Timed out waiting for turn ${turnId}`))
      }, MODEL_TIMEOUT_MS)
      this.turnWaiters.set(turnId, {
        resolve: (value) => {
          clearTimeout(timer)
          resolveTurn(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
    })
  }

  tokenEventsForTurn(turnId) {
    return this.tokensByTurn.get(turnId) ?? []
  }

  toolCallsForTurn(turnId) {
    return this.toolCallsByTurn.get(turnId) ?? []
  }

  firstToolLatencyForTurn(turnId) {
    const first = this.firstToolAt.get(turnId)
    const started = this.turnStartedAt.get(turnId)
    return first === undefined || started === undefined ? null : round(first - started, 3)
  }

  handleLine(line) {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message)
      return
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const events = this.tokensByTurn.get(message.params.turnId) ?? []
      events.push(message.params.tokenUsage)
      this.tokensByTurn.set(message.params.turnId, events)
    } else if (message.method === 'item/started') {
      const type = message.params.item?.type
      if (['dynamicToolCall', 'mcpToolCall', 'commandExecution', 'webSearch'].includes(type)) {
        this.noteFirstTool(message.params.turnId)
      }
    } else if (message.method === 'turn/completed') {
      this.completedTurns.set(message.params.turn.id, message.params.turn)
      const waiter = this.turnWaiters.get(message.params.turn.id)
      if (waiter) {
        this.turnWaiters.delete(message.params.turn.id)
        waiter.resolve(message.params.turn)
      }
    }
  }

  async handleServerRequest(message) {
    if (message.method === 'item/tool/call') {
      const params = message.params
      this.noteFirstTool(params.turnId)
      const startedAt = performance.now()
      let routed
      try {
        routed = await routeModelBrowserTool(params, this.context)
      } catch (error) {
        routed = failureToolResponse(errorMessage(error))
      }
      const durationMs = round(performance.now() - startedAt, 3)
      const calls = this.toolCallsByTurn.get(params.turnId) ?? []
      calls.push({
        callId: params.callId,
        tool: params.tool,
        ok: routed.success,
        durationMs,
        hostDurationMs: finiteNumber(routed.hostResult?.durationMs),
        resultChars: JSON.stringify(routed.hostResult ?? null).length,
        ...(routed.success ? {} : { error: routed.error })
      })
      this.toolCallsByTurn.set(params.turnId, calls)
      this.respond(message.id, {
        success: routed.success,
        contentItems: [{ type: 'inputText', text: JSON.stringify(routed.hostResult) }]
      })
      return
    }
    if (message.method === 'item/tool/requestUserInput') {
      this.respond(message.id, { answers: {} })
    } else if (message.method === 'currentTime/read') {
      this.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1_000) })
    } else {
      this.respondError(message.id, `Unsupported browser benchmark request: ${message.method}`)
    }
  }

  noteFirstTool(turnId) {
    if (!this.firstToolAt.has(turnId)) this.firstToolAt.set(turnId, performance.now())
  }

  write(message) {
    if (!this.child?.stdin.writable) throw new Error(`benchmark app-server stdin unavailable: ${this.stderr.join('\n')}`)
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
}

async function routeModelBrowserTool(params, context) {
  if (params.namespace !== null) return failureToolResponse(`Unsupported dynamic tool namespace: ${params.namespace}`)
  const args = asRecord(params.arguments)
  const tabError = validateExplicitTab(args.tab, context.tabId)
  if (tabError) return failureToolResponse(tabError)

  if (params.tool === 'browser_snapshot') {
    const urlError = validateSamePage(args.url, context.expectedUrl)
    if (urlError) return failureToolResponse(urlError)
    const program = buildPageSnapshotProgram({
      objective: readString(args.objective) ?? SNAPSHOT_OBJECTIVE,
      mode: readSnapshotMode(args.mode),
      selector: readString(args.selector),
      maxItems: finiteNumber(args.maxItems),
      maxChars: finiteNumber(args.maxChars)
    })
    return hostToolResponse(await postEval(context, program, {
      timeoutMs: clampNumber(args.timeoutMs, 15_000, 250, 60_000),
      maxResultChars: clampNumber(args.maxResultChars ?? args.maxChars, 20_000, 1_000, 100_000)
    }))
  }

  if (params.tool === 'browser_extract_page') {
    if (args.frame && args.frame !== 'main') return failureToolResponse('The read-only eval supports only the main frame.')
    const program = buildPageSnapshotProgram({ mode: 'content', maxItems: 40, maxChars: finiteNumber(args.maxResultChars) ?? 8_000 })
    return hostToolResponse(await postEval(context, program, {
      timeoutMs: clampNumber(args.timeoutMs, 15_000, 250, 60_000),
      maxResultChars: clampNumber(args.maxResultChars, 20_000, 1_000, 100_000)
    }))
  }

  if (params.tool === 'browser_run') {
    if (args.frame && args.frame !== 'main') return failureToolResponse('The read-only eval supports only the main frame.')
    const code = readString(args.code)
    if (!code) return failureToolResponse('browser_run requires code.')
    const readOnlyError = validateReadOnlyProgram(code)
    if (readOnlyError) return failureToolResponse(readOnlyError)
    return hostToolResponse(await postEval(context, code, {
      timeoutMs: clampNumber(args.timeoutMs, 15_000, 250, 60_000),
      maxResultChars: clampNumber(args.maxResultChars, 20_000, 1_000, 100_000)
    }))
  }

  if (params.tool === 'browser_cdp') {
    const cdpError = validateReadOnlyCdp(args)
    if (cdpError) return failureToolResponse(cdpError)
    return hostToolResponse(await socketJson(context.socketPath, 'POST', '/cdp', {
      ...args,
      tab: context.tabId
    }))
  }

  if (params.tool === 'browser_navigate') {
    const urlError = validateSamePage(args.url, context.expectedUrl)
    if (urlError) return failureToolResponse(urlError)
    return hostToolResponse({
      ok: true,
      result: { alreadyAtRequestedPage: true },
      tabId: context.tabId,
      url: context.expectedUrl,
      title: 'Inbox',
      durationMs: 0,
      resultChars: 31,
      truncated: false
    })
  }

  return failureToolResponse(`${params.tool} is disabled in this read-only benchmark; use browser_snapshot.`)
}

function validateReadOnlyProgram(code) {
  const forbidden = [
    [/\.\s*(?:click|submit|requestSubmit|dispatchEvent|setAttribute|removeAttribute|toggleAttribute)\s*\(/i, 'event or attribute mutation'],
    [/\.\s*(?:append|appendChild|prepend|remove|removeChild|replaceWith|replaceChildren|insertBefore|insertAdjacent\w*)\s*\(/i, 'DOM mutation'],
    [/\b(?:window\.)?open\s*\(|\blocation\s*(?:=|\.(?:assign|replace|reload)\s*\()|\bhistory\.(?:pushState|replaceState|go|back|forward)\s*\(/i, 'navigation or new-tab action'],
    [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b|navigator\.sendBeacon\s*\(/i, 'network mutation'],
    [/(?:localStorage|sessionStorage)\.(?:setItem|removeItem|clear)\s*\(|document\.cookie\s*=/i, 'storage mutation'],
    [/\.(?:innerHTML|outerHTML|textContent|innerText|value|checked|selected|disabled)\s*=(?!=)/i, 'property mutation'],
    [/\b(?:eval|Function)\s*\(|\b(?:Element|Node|EventTarget|Document)\.prototype\b/i, 'dynamic or prototype mutation risk']
  ]
  for (const [pattern, label] of forbidden) {
    if (pattern.test(code)) return `Rejected browser_run ${label}; this benchmark is read-only.`
  }
  return null
}

function validateReadOnlyCdp(args) {
  const operation = readString(args.operation) ?? 'command'
  if (['capabilities', 'events', 'snapshot', 'network', 'networkBody', 'performance'].includes(operation)) return null
  if (operation !== 'command') return `Rejected browser_cdp operation ${operation}; this benchmark is read-only.`
  const method = readString(args.method)
  const allowed = new Set([
    'Accessibility.getFullAXTree', 'DOM.describeNode', 'DOM.getDocument', 'DOM.getOuterHTML',
    'DOM.querySelector', 'DOM.querySelectorAll', 'Network.getResponseBody', 'Page.getFrameTree',
    'Page.getNavigationHistory', 'Runtime.getProperties'
  ])
  if (method === 'Runtime.evaluate') {
    const expression = readString(asRecord(args.params).expression) ?? ''
    return validateReadOnlyProgram(expression)
  }
  return method && allowed.has(method) ? null : `Rejected browser_cdp method ${method ?? '(missing)'}; this benchmark is read-only.`
}

async function captureOracle(context) {
  const response = await postEval(context, ORACLE_PROGRAM, { timeoutMs: 5_000, maxResultChars: 20_000 })
  if (!response.ok) throw new Error(`Could not capture Reddit oracle: ${response.error ?? 'unknown error'}`)
  const result = asRecord(response.result)
  if (result.url !== context.expectedUrl) throw new Error(`Reddit oracle URL changed to ${String(result.url)}`)
  if (!Array.isArray(result.rows) || result.rows.length !== 3) {
    throw new Error(`Expected exactly 3 Reddit notification rows, found ${Array.isArray(result.rows) ? result.rows.length : 0}`)
  }
  return result
}

function evaluateSnapshot(snapshot, oracle) {
  const items = Array.isArray(snapshot.items) ? snapshot.items.map(asRecord) : []
  const used = new Set()
  const matches = oracle.rows.map((row) => {
    let bestIndex = -1
    let bestScore = -1
    for (let index = 0; index < items.length; index += 1) {
      if (used.has(index)) continue
      const score = identityOverlap(row, `${items[index].text ?? ''} ${items[index].name ?? ''} ${items[index].href ?? ''}`)
      if (score > bestScore) {
        bestIndex = index
        bestScore = score
      }
    }
    if (bestIndex < 0 || bestScore < 2) return { id: row.id, matched: false, expectedRead: row.read, observedRead: null }
    used.add(bestIndex)
    const item = items[bestIndex]
    const state = asRecord(item.state)
    const observedRead = typeof state.read === 'boolean'
      ? state.read
      : typeof state.selected === 'boolean'
        ? !state.selected
        : inferTextReadState(`${item.text ?? ''} ${JSON.stringify(state)}`)
    return {
      id: row.id,
      matched: true,
      expectedRead: row.read,
      observedRead,
      correctState: observedRead === row.read,
      itemIndex: bestIndex,
      score: bestScore
    }
  })
  return { matches, exactThreeAndState: matches.every(({ matched, correctState }) => matched && correctState) }
}

function evaluateModelResponse(finalResponse, oracle) {
  const lines = finalResponse.split(/\n+/).map((line) => line.trim()).filter(Boolean)
  const used = new Set()
  const matches = oracle.rows.map((row) => {
    let bestIndex = -1
    let bestScore = -1
    for (let index = 0; index < lines.length; index += 1) {
      if (used.has(index)) continue
      const score = identityOverlap(row, lines[index])
      if (score > bestScore) {
        bestIndex = index
        bestScore = score
      }
    }
    if (bestIndex < 0 || bestScore < 2) return { id: row.id, matched: false, expectedRead: row.read, observedRead: null }
    used.add(bestIndex)
    const observedRead = inferTextReadState(lines[bestIndex])
    return {
      id: row.id,
      matched: true,
      expectedRead: row.read,
      observedRead,
      correctState: observedRead === row.read,
      line: lines[bestIndex],
      lineIndex: bestIndex,
      score: bestScore
    }
  })
  const ordered = matches.every((match, index) => index === 0 || match.lineIndex > matches[index - 1].lineIndex)
  return {
    exactThreeAndState: matches.every(({ matched, correctState }) => matched && correctState) && ordered,
    ordered,
    matches
  }
}

function identityOverlap(row, candidate) {
  const rowTokens = identityTokens(`${row.text ?? ''} ${row.href ?? ''}`)
  const candidateTokens = new Set(identityTokens(candidate))
  return rowTokens.reduce((score, token) => score + (candidateTokens.has(token) ? 1 : 0), 0)
}

function identityTokens(value) {
  const stop = new Set(['about', 'ago', 'comment', 'comments', 'days', 'from', 'hours', 'latest', 'notification', 'notifications', 'read', 'replied', 'reply', 'their', 'there', 'these', 'this', 'unread', 'whether', 'your'])
  return unique(normalize(value).split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !stop.has(token) && !/^\d+$/.test(token)))
}

function inferTextReadState(value) {
  if (/\bunread\b/i.test(value)) return false
  if (/\bread\b/i.test(value)) return true
  return null
}

function compactSnapshotPreview(snapshot, quality) {
  return {
    page: snapshot.page,
    coverage: snapshot.coverage,
    timings: snapshot.timings,
    items: (Array.isArray(snapshot.items) ? snapshot.items : []).slice(0, 6),
    quality
  }
}

async function postEval(context, code, options) {
  const query = new URLSearchParams({
    tab: context.tabId,
    timeoutMs: String(options.timeoutMs),
    maxResultChars: String(options.maxResultChars)
  })
  const response = await socketJson(context.socketPath, 'POST', `/eval?${query}`, code, 'application/javascript')
  if (response.url && !isRedditNotificationsUrl(response.url)) throw new Error(`Browser target left Reddit notifications: ${response.url}`)
  return response
}

function socketJson(socketPath, method, path, body, contentType = 'application/json') {
  const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body)
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest({
      socketPath,
      method,
      path,
      headers: payload === null ? {} : {
        'content-type': contentType,
        'content-length': Buffer.byteLength(payload)
      }
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          reject(new Error(`Browser socket returned non-JSON (${response.statusCode}): ${text.slice(0, 300)}`))
          return
        }
        if ((response.statusCode ?? 500) >= 400) reject(new Error(parsed.error ?? `Browser socket HTTP ${response.statusCode}`))
        else resolveRequest(parsed)
      })
    })
    request.setTimeout(65_000, () => request.destroy(new Error('Browser socket request timed out')))
    request.on('error', reject)
    if (payload !== null) request.write(payload)
    request.end()
  })
}

function parseArgs(args) {
  const values = { samples: 25, model: 'gpt-5.6-terra', effort: 'low', output: null, skipModel: false }
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (key === '--skip-model') {
      values.skipModel = true
      continue
    }
    const value = args[index + 1]
    if (key === '--samples') values.samples = positiveInteger(key, value)
    else if (key === '--model') values.model = requiredValue(key, value)
    else if (key === '--effort') values.effort = requiredValue(key, value)
    else if (key === '--out') values.output = requiredValue(key, value)
    else throw new Error(`Unknown argument: ${key}`)
    index += 1
  }
  return values
}

function requireSocketPath() {
  const value = process.env.CODEX_BROWSER_SOCK
  if (!value) throw new Error('CODEX_BROWSER_SOCK is required; run this benchmark from the protected Codex Desktop host session.')
  return value
}

function requireTabs(response) {
  if (response.ok !== true || !Array.isArray(response.tabs)) throw new Error(`Could not list browser tabs: ${response.error ?? 'invalid response'}`)
  return response.tabs
}

function requireActiveRedditNotificationsTab(tabs) {
  const active = tabs.filter(({ active }) => active)
  if (active.length !== 1 || !isRedditNotificationsUrl(active[0].url)) {
    throw new Error('The single active visible tab must already be https://www.reddit.com/notifications; the harness will not navigate or activate tabs.')
  }
  return active[0]
}

function isRedditNotificationsUrl(value) {
  try {
    const url = new URL(String(value))
    return /(^|\.)reddit\.com$/i.test(url.hostname) && /^\/notifications\/?$/i.test(url.pathname)
  } catch {
    return false
  }
}

function validateExplicitTab(value, expected) {
  if (value === undefined || value === null || value === '') return null
  return value === expected ? null : `Rejected tab ${String(value)}; benchmark is pinned to existing tab ${expected}.`
}

function validateSamePage(value, expected) {
  if (value === undefined || value === null || value === '') return null
  try {
    const requested = new URL(String(value), expected)
    const current = new URL(expected)
    return requested.href === current.href ? null : `Rejected navigation to ${requested.href}; benchmark is pinned to the already-open Reddit notifications page.`
  } catch {
    return `Rejected invalid URL ${String(value)}.`
  }
}

function sameOracle(left, right) {
  return JSON.stringify(oracleProjection(left)) === JSON.stringify(oracleProjection(right))
}

function oracleProjection(oracle) {
  return {
    url: oracle.url,
    rows: oracle.rows.map(({ id, unread, read, text, href, datetime }) => ({ id, unread, read, text, href, datetime }))
  }
}

function sameTabs(left, right) {
  const project = (tabs) => tabs.map(({ id, url, active }) => ({ id, url, active })).sort((a, b) => a.id.localeCompare(b.id))
  return JSON.stringify(project(left)) === JSON.stringify(project(right))
}

function finalAgentResponse(turn) {
  return [...(turn.items ?? [])].reverse().find((item) => item.type === 'agentMessage' && item.phase !== 'commentary')?.text ?? ''
}

function dedupeTokenCalls(events) {
  const calls = []
  let previous = null
  for (const event of events) {
    const key = `${event.total?.totalTokens}:${event.last?.totalTokens}`
    if (key !== previous && (event.last?.totalTokens ?? 0) > 0) calls.push(event)
    previous = key
  }
  return calls
}

function summarizeNumbers(values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (numbers.length === 0) return { count: 0, min: null, median: null, p95: null, max: null, mean: null }
  const middle = Math.floor(numbers.length / 2)
  const median = numbers.length % 2 === 0 ? (numbers[middle - 1] + numbers[middle]) / 2 : numbers[middle]
  return {
    count: numbers.length,
    min: round(numbers[0], 3),
    median: round(median, 3),
    p95: round(numbers[Math.max(0, Math.ceil(numbers.length * 0.95) - 1)], 3),
    max: round(numbers.at(-1), 3),
    mean: round(sum(numbers) / numbers.length, 3)
  }
}

function hostToolResponse(hostResult) {
  return { success: hostResult?.ok === true, hostResult, ...(hostResult?.ok === true ? {} : { error: hostResult?.error ?? 'browser host call failed' }) }
}

function failureToolResponse(error) {
  return { success: false, error, hostResult: { ok: false, error } }
}

function readSnapshotMode(value) {
  return ['task', 'content', 'interactive'].includes(value) ? value : 'task'
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = finiteNumber(value) ?? fallback
  return Math.min(maximum, Math.max(minimum, number))
}

function requiredValue(key, value) {
  if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`)
  return value
}

function positiveInteger(key, value) {
  const parsed = Number(requiredValue(key, value))
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`)
  return parsed
}

function codexVersion() {
  return spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout.trim()
}

function normalize(value) {
  return String(value).normalize('NFKD').toLowerCase()
}

function unique(values) {
  return [...new Set(values)]
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0)
}

function round(value, digits) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

try {
  await main()
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2)}\n`)
  process.exitCode = 1
}
