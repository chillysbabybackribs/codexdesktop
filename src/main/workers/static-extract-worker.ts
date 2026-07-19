import { runStaticExtraction } from './static-extract.js'

// utilityProcess entry: keeps linkedom parsing of large research documents off
// the Electron main thread, so agent research activity cannot stall IPC or
// window compositing. Protocol: {type:'init', program} once, then
// {type:'extract', id, html, url} → {type:'result', id, ...outcome}.

type WorkerRequest =
  | { type: 'init'; program: string }
  | { type: 'extract'; id: number; html: string; url: string }

const parentPort = (process as unknown as { parentPort?: {
  on: (event: 'message', listener: (event: { data: WorkerRequest }) => void) => void
  postMessage: (message: unknown) => void
} }).parentPort

if (parentPort) {
  let program: string | null = null
  parentPort.on('message', (event) => {
    const message = event.data
    if (message.type === 'init') {
      program = message.program
      return
    }
    if (message.type === 'extract') {
      const outcome = program
        ? runStaticExtraction(program, message.html, message.url)
        : { ok: false as const, reason: 'extraction worker was not initialized' }
      parentPort.postMessage({ type: 'result', id: message.id, ...outcome })
    }
  })
}
