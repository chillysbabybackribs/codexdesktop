// Shim-safe view of the canonical tool specs (Claude-prep step 6).
// codex-config.ts remains the single place the schemas are authored; this
// module exists so transports that only need the DECLARATIONS (the MCP stdio
// shim bundles this) never pull the in-process dispatch graph.
//
// `allToolSpecs` is the full declared set (browser + subagent tools) every
// transport advertises. `browserToolSpecs` is retained for callers that want
// only the browser subset.

export { browserDynamicTools as browserToolSpecs, allDynamicTools as allToolSpecs } from '../codex/codex-config.js'
export type { DynamicToolSpec as BrowserToolSpec } from '../../shared/codex-protocol/v2/DynamicToolSpec.js'
