import { request } from 'node:http'
import { createInterface } from 'node:readline'
import { browserToolSpecs } from '../tools/browser-tool-specs.js'

// MCP stdio facade over the app's browser tools (Claude-prep step 6).
//
// Spawned by an MCP client (the Claude Code CLI) as a plain node process:
//   node out/main/mcp-browser-shim.js
// with CODEX_BROWSER_SOCK pointing at the running app's unix control socket.
// It holds no browser logic: tools/list serves the canonical specs and
// tools/call proxies to POST /tool/<name>, so all three transports (codex
// dynamic tools, shell-over-socket, MCP) execute the identical dispatch.
//
// Protocol: newline-delimited JSON-RPC 2.0 on stdio (MCP stdio transport).
// Hand-rolled on purpose — it keeps the app's runtime dependencies unchanged.

const PROTOCOL_VERSION = '2025-06-18'

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

const socketPath = process.env.CODEX_BROWSER_SOCK ?? ''

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id: number | string | null, result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function callSocketTool(tool: string, args: Record<string, unknown>): Promise<{
  result: { ok: boolean } & Record<string, unknown>
  imageUrls: string[]
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: `/tool/${encodeURIComponent(tool)}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(new Error(`invalid response from browser control socket: ${(error as Error).message}`))
          }
        })
      }
    )
    req.on('error', (error) => reject(new Error(`browser control socket unreachable: ${error.message}`)))
    req.setTimeout(120_000, () => req.destroy(new Error('browser tool call timed out')))
    req.end(JSON.stringify(args))
  })
}

function imageContent(dataUrl: string): { type: 'image'; data: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl)
  if (!match) return null
  return { type: 'image', data: match[2], mimeType: match[1] }
}

async function handle(message: JsonRpcRequest): Promise<void> {
  const id = message.id ?? null

  if (message.method === 'initialize') {
    reply(id, {
      protocolVersion:
        typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'codexdesktop-browser', version: '0.1.0' }
    })
    return
  }
  if (message.method === 'notifications/initialized' || message.method.startsWith('notifications/')) {
    return
  }
  if (message.method === 'ping') {
    reply(id, {})
    return
  }
  if (message.method === 'tools/list') {
    reply(id, {
      tools: browserToolSpecs
        .filter((spec): spec is Extract<typeof spec, { type: 'function' }> => spec.type === 'function')
        .map((spec) => ({
          name: spec.name,
          description: spec.description,
          inputSchema: spec.inputSchema
        }))
    })
    return
  }
  if (message.method === 'tools/call') {
    const name = typeof message.params?.name === 'string' ? message.params.name : null
    if (!name) {
      replyError(id, -32602, 'tools/call requires a tool name')
      return
    }
    if (!socketPath) {
      replyError(id, -32603, 'CODEX_BROWSER_SOCK is not set — is Codex Desktop running?')
      return
    }
    const args =
      message.params?.arguments && typeof message.params.arguments === 'object'
        ? (message.params.arguments as Record<string, unknown>)
        : {}
    try {
      const outcome = await callSocketTool(name, args)
      reply(id, {
        content: [
          { type: 'text', text: JSON.stringify(outcome.result) },
          ...outcome.imageUrls.map(imageContent).filter((item): item is NonNullable<typeof item> => item !== null)
        ],
        isError: !outcome.result.ok
      })
    } catch (error) {
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: (error as Error).message }) }],
        isError: true
      })
    }
    return
  }

  if (id !== null) replyError(id, -32601, `method not found: ${message.method}`)
}

const readline = createInterface({ input: process.stdin })
readline.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message: JsonRpcRequest
  try {
    message = JSON.parse(trimmed) as JsonRpcRequest
  } catch {
    return
  }
  void handle(message)
})
readline.on('close', () => process.exit(0))
