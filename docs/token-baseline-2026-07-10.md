# Matched Token Baseline — 2026-07-10

This benchmark isolates retained tool-output growth from model, effort, summary, and tool-schema differences.

## Configuration

- Codex CLI: `0.144.1`
- Model: `gpt-5.4`
- Reasoning effort: `medium`
- Reasoning summary: `none`
- Five turns per arm
- The same `benchmark_payload` dynamic tool was declared in both arms.
- The no-tool arm never called it.
- The tool arm called it once per turn and received 8,051 serialized characters per call.
- Automatic compaction was not configured.

The two runs reversed arm order to expose cache-warming effects:

- [No-tool first, then tool](./token-baseline-2026-07-10.json)
- [Tool first, then no-tool](./token-baseline-2026-07-10-reversed.json)

## Results

| Measurement | No-tool first | Tool first | Mean |
|---|---:|---:|---:|
| Tool-arm context growth | 5,391 | 5,604 | 5,497.5 |
| No-tool-arm context growth | 349 | 136 | 242.5 |
| Normalized tool growth delta | 5,042 | 5,468 | 5,255 |
| Cumulative input delta | 82,864 | 82,303 | 82,583.5 |
| Tool result characters retained | 40,255 | 40,255 | 40,255 |
| Additional model calls in tool arm | 5 | 5 | 5 |

Context growth is measured from each arm's first call, which removes the roughly 200-token offset caused by the different user instructions. The tool arm made ten model calls versus five in the no-tool arm because every tool result required a follow-up model call.

Cache warming changed uncached-token totals, as expected, but did not materially change the retained-context result. The normalized tool-growth delta differed by 426 tokens, or about 8%, between orderings.

## Interpretation

The controlled result supports the audit's central hypothesis: retained tool results materially increase both current context and cumulative replay. Across five 8K-character results, the final active context grew by about 5.3K more tokens than normal conversation, and the extra follow-up calls raised cumulative input by about 82.6K.

This is a directional lower bound for browser/research output. The synthetic payload is one repeated character, which tokenizes more efficiently than natural language, JSON, generated source, or base64 data. A later payload-size sweep should use realistic structured samples before selecting production output limits.

## Reproduction

```bash
npm run benchmark:tokens -- --turns 5 --payload-chars 8000 --out docs/token-baseline-2026-07-10.json
npm run benchmark:tokens -- --turns 5 --payload-chars 8000 --order tool,no-tool --out docs/token-baseline-2026-07-10-reversed.json
```
