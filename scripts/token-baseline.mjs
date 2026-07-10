#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

let options
let startedAt

async function main() {
  options = parseArgs(process.argv.slice(2))
  startedAt = new Date()
  const harness = new AppServerHarness(options)

  try {
    await harness.start()
    const scenarios = []

    for (const kind of options.order) {
      scenarios.push(await runScenario(harness, kind))
    }

    const report = buildReport(scenarios)
    const outputPath = resolve(options.output)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`${JSON.stringify({
      ok: true,
      output: outputPath,
      model: report.config.model,
      effort: report.config.effort,
      turns: report.config.turns,
      payloadChars: report.config.payloadChars,
      comparison: report.comparison
    })}\n`)
  } finally {
    await harness.stop()
  }
}

async function runScenario(harness, kind) {
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
      model_reasoning_summary: options.summary
    },
    developerInstructions: [
      'This is a controlled token-telemetry benchmark.',
      'Follow each benchmark instruction exactly and keep final replies minimal.',
      'Call benchmark_payload only when the user explicitly requires it.'
    ].join('\n'),
    dynamicTools: [benchmarkTool]
  })

  harness.registerScenario(thread.thread.id, kind)
  const turns = []

  for (let index = 1; index <= options.turns; index += 1) {
    const prompt = kind === 'tool'
      ? `Benchmark turn ${index} of ${options.turns}. Call benchmark_payload exactly once with turn ${index}, then reply with exactly ACK ${index}.`
      : `Benchmark turn ${index} of ${options.turns}. Do not call any tool. Reply with exactly ACK ${index}.`
    const response = await harness.request('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      model: options.model,
      effort: options.effort,
      summary: options.summary,
      approvalPolicy: 'never'
    })

    await harness.waitForTurn(response.turn.id)
    turns.push({
      index,
      turnId: response.turn.id,
      prompt,
      toolCalls: harness.toolCallsForTurn(response.turn.id),
      tokenEvents: harness.tokenEventsForTurn(response.turn.id)
    })
  }

  return summarizeScenario(kind, thread, turns)
}

function summarizeScenario(kind, thread, turns) {
  const calls = turns.flatMap((turn) => dedupeCalls(turn.tokenEvents).map((event) => ({
    turn: turn.index,
    inputTokens: event.last.inputTokens,
    cachedInputTokens: event.last.cachedInputTokens,
    uncachedInputTokens: Math.max(0, event.last.inputTokens - event.last.cachedInputTokens),
    outputTokens: event.last.outputTokens,
    reasoningOutputTokens: event.last.reasoningOutputTokens,
    totalTokens: event.last.totalTokens,
    contextWindow: event.modelContextWindow,
    contextPercent: event.modelContextWindow
      ? round(event.last.inputTokens * 100 / event.modelContextWindow, 2)
      : null
  })))
  const input = calls.map((call) => call.inputTokens)
  const cumulativeInput = sum(input)
  const cachedInput = sum(calls.map((call) => call.cachedInputTokens))

  return {
    kind,
    threadId: thread.thread.id,
    effectiveModel: thread.model,
    effectiveReasoningEffort: thread.reasoningEffort,
    turnCount: turns.length,
    modelCallCount: calls.length,
    toolCallCount: sum(turns.map((turn) => turn.toolCalls.length)),
    firstCallInput: input[0] ?? null,
    finalCallInput: input.at(-1) ?? null,
    maximumCallInput: input.length ? Math.max(...input) : null,
    cumulativeInput,
    averageInputPerCall: calls.length ? Math.round(cumulativeInput / calls.length) : null,
    cachedInput,
    uncachedInput: cumulativeInput - cachedInput,
    cachedInputPercent: cumulativeInput ? round(cachedInput * 100 / cumulativeInput, 1) : null,
    calls,
    turns: turns.map((turn) => ({
      index: turn.index,
      turnId: turn.turnId,
      toolCallCount: turn.toolCalls.length,
      toolResultChars: sum(turn.toolCalls.map((call) => call.resultChars)),
      modelCallCount: dedupeCalls(turn.tokenEvents).length
    }))
  }
}

function buildReport(scenarios) {
  const noTool = scenarios.find((scenario) => scenario.kind === 'no-tool')
  const tool = scenarios.find((scenario) => scenario.kind === 'tool')
  if (!noTool || !tool) throw new Error('Both no-tool and tool scenarios are required')

  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    codexCli: codexVersion(),
    config: {
      model: options.model,
      effort: options.effort,
      summary: options.summary,
      turns: options.turns,
      payloadChars: options.payloadChars,
      order: options.order,
      dynamicToolDeclaredInBothScenarios: true,
      automaticCompactionConfigured: false
    },
    scenarios,
    comparison: {
      finalCallInputDelta: nullableDelta(tool.finalCallInput, noTool.finalCallInput),
      maximumCallInputDelta: nullableDelta(tool.maximumCallInput, noTool.maximumCallInput),
      cumulativeInputDelta: tool.cumulativeInput - noTool.cumulativeInput,
      averageInputPerCallDelta: nullableDelta(tool.averageInputPerCall, noTool.averageInputPerCall),
      modelCallDelta: tool.modelCallCount - noTool.modelCallCount,
      toolResultChars: sum(tool.turns.map((turn) => turn.toolResultChars))
    }
  }
}

class AppServerHarness {
  constructor(options) {
    this.options = options
    this.requestId = 0
    this.pending = new Map()
    this.completedTurns = new Map()
    this.turnWaiters = new Map()
    this.tokensByTurn = new Map()
    this.toolCallsByTurn = new Map()
    this.scenarioByThread = new Map()
    this.stderr = []
  }

  async start() {
    this.child = spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      this.stderr.push(String(chunk).trim())
      this.stderr = this.stderr.slice(-20)
    })
    this.child.on('exit', (code, signal) => {
      const error = new Error(`codex app-server exited (${code ?? signal ?? 'unknown'})`)
      for (const pending of this.pending.values()) pending.reject(error)
      for (const waiter of this.turnWaiters.values()) waiter.reject(error)
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line))

    await this.request('initialize', {
      clientInfo: { name: 'codexdesktop-token-baseline', title: 'Codex Desktop Token Baseline', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    this.notify('initialized')
  }

  async stop() {
    if (!this.child || this.child.killed) return
    this.child.kill()
    await new Promise((resolveExit) => {
      const timer = setTimeout(resolveExit, 2_000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolveExit()
      })
    })
  }

  registerScenario(threadId, kind) {
    this.scenarioByThread.set(threadId, kind)
  }

  request(method, params) {
    const id = `baseline-${++this.requestId}`
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}`))
      }, this.options.timeoutMs)
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

  waitForTurn(turnId) {
    if (this.completedTurns.has(turnId)) return Promise.resolve(this.completedTurns.get(turnId))
    return new Promise((resolveTurn, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId)
        reject(new Error(`Timed out waiting for turn ${turnId}`))
      }, this.options.timeoutMs)
      this.turnWaiters.set(turnId, {
        resolve: (value) => {
          clearTimeout(timer)
          resolveTurn(value)
        },
        reject
      })
    })
  }

  tokenEventsForTurn(turnId) {
    return this.tokensByTurn.get(turnId) ?? []
  }

  toolCallsForTurn(turnId) {
    return this.toolCallsByTurn.get(turnId) ?? []
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
      this.handleServerRequest(message)
      return
    }

    if (message.method === 'thread/tokenUsage/updated') {
      const events = this.tokensByTurn.get(message.params.turnId) ?? []
      events.push(message.params.tokenUsage)
      this.tokensByTurn.set(message.params.turnId, events)
    } else if (message.method === 'turn/completed') {
      this.completedTurns.set(message.params.turn.id, message.params.turn)
      const waiter = this.turnWaiters.get(message.params.turn.id)
      if (waiter) {
        this.turnWaiters.delete(message.params.turn.id)
        waiter.resolve(message.params.turn)
      }
    }
  }

  handleServerRequest(message) {
    if (message.method === 'item/tool/call' && message.params.tool === 'benchmark_payload') {
      const result = JSON.stringify({
        ok: true,
        scenario: this.scenarioByThread.get(message.params.threadId) ?? 'unknown',
        turn: message.params.arguments?.turn ?? null,
        payload: 'x'.repeat(this.options.payloadChars)
      })
      const calls = this.toolCallsByTurn.get(message.params.turnId) ?? []
      calls.push({ callId: message.params.callId, resultChars: result.length })
      this.toolCallsByTurn.set(message.params.turnId, calls)
      this.respond(message.id, { success: true, contentItems: [{ type: 'inputText', text: result }] })
      return
    }

    if (message.method === 'item/tool/requestUserInput') {
      this.respond(message.id, { answers: {} })
    } else if (message.method === 'currentTime/read') {
      this.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1_000) })
    } else {
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unsupported benchmark request: ${message.method}` }
      })
    }
  }

  write(message) {
    if (!this.child?.stdin.writable) throw new Error(`app-server stdin is unavailable: ${this.stderr.join('\n')}`)
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
}

const benchmarkTool = {
  type: 'function',
  name: 'benchmark_payload',
  description: 'Return the fixed synthetic payload for the current controlled benchmark turn.',
  inputSchema: {
    type: 'object',
    properties: { turn: { type: 'number' } },
    required: ['turn'],
    additionalProperties: false
  }
}

function dedupeCalls(events) {
  const calls = []
  let previous = null
  for (const event of events) {
    const key = `${event.total.totalTokens}:${event.last.totalTokens}`
    if (key !== previous && event.last.totalTokens > 0) calls.push(event)
    previous = key
  }
  return calls
}

function parseArgs(args) {
  const values = {
    model: 'gpt-5.4',
    effort: 'medium',
    summary: 'none',
    turns: 5,
    payloadChars: 8_000,
    output: 'docs/token-baseline-latest.json',
    order: ['no-tool', 'tool'],
    timeoutMs: 10 * 60_000
  }
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    const value = args[index + 1]
    if (key === '--model') values.model = requiredValue(key, value)
    else if (key === '--effort') values.effort = requiredValue(key, value)
    else if (key === '--summary') values.summary = requiredValue(key, value)
    else if (key === '--turns') values.turns = positiveInteger(key, value)
    else if (key === '--payload-chars') values.payloadChars = positiveInteger(key, value)
    else if (key === '--out') values.output = requiredValue(key, value)
    else if (key === '--order') values.order = requiredValue(key, value).split(',')
    else if (key === '--timeout-ms') values.timeoutMs = positiveInteger(key, value)
    else throw new Error(`Unknown argument: ${key}`)
    index += 1
  }
  if (values.order.length !== 2 || !values.order.includes('no-tool') || !values.order.includes('tool')) {
    throw new Error('--order must contain no-tool and tool exactly once')
  }
  return values
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

function nullableDelta(left, right) {
  return left === null || right === null ? null : left - right
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0)
}

function round(value, digits) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

await main()
