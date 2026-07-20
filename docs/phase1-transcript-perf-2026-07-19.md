# Phase 1 — Transcript performance (2026-07-19)

Part of the 6-phase performance/usability build. Scope: make streaming and long
transcripts cheap to render. No behavior/restriction changes.

## What changed

1. **Parse-on-completion markdown (segment streaming).**
   - New [src/renderer/src/streaming-markdown.ts](../src/renderer/src/streaming-markdown.ts):
     fence-aware splitter that divides a streaming markdown document into
     segments whose earlier members never change as text is appended. Boundaries
     sit at blank lines outside code fences; sibling list items and indented
     continuations merge so ordered-list numbering and code structure survive.
     Invariant: `segments.join('') === text` (exact reconstruction). Segments
     are chunked in groups of 32 past 32 segments to bound component count.
   - `StreamingMarkdownContent` in
     [src/renderer/src/MarkdownContent.tsx](../src/renderer/src/MarkdownContent.tsx)
     renders one memoized ReactMarkdown fragment per segment inside a single
     `.markdown-body` wrapper — per delta, only the trailing segment re-parses
     instead of the whole message.
   - Used only while an item is streaming: the main assistant message
     (`AssistantMessage`, App.tsx) and the in-task commentary message
     switch back to the single-parse `MarkdownContent` on completion, so final
     fidelity is byte-identical to the pre-change render.

2. **Native row virtualization.** `content-visibility: auto` +
   `contain-intrinsic-size: auto 120px` on `.thread-scroll-content > .message`
   and `> .task-activity` (end of styles.css). Offscreen transcript rows
   skip layout and paint; `auto` intrinsic sizing remembers each row's last
   rendered size, so ThreadScroll's bottom-pin / top-anchor / spacer math stays
   stable (those paths measure live rects of on-screen nodes plus scrollHeight,
   which remembered sizes preserve).

## Verification

- `npm test`: 305 pass (11 new splitter tests in
  `streaming-markdown.test.ts`: reconstruction, fences incl. tilde/unclosed,
  loose ordered lists, indented continuation, segment stability under growth,
  chunk stability).
- `npm run build` (typecheck + electron-vite): clean.
- Live smoke on a disposable verification instance (CDP + Playwright): one
  real markdown-heavy turn. Observed 3 streaming fragments during the stream
  (split active), final render via single parse with correct h2/ol/pre-code
  structure, `content-visibility: auto` computed on rows, scroll geometry sane.

## Known characteristics

- During streaming, a document that is one giant unclosed code fence re-parses
  the fence per delta (single tail segment) — same cost as before this change,
  never worse.
- Reference-style link/footnote definitions that land in a different segment
  than their usage render unlinked *while streaming only*; the completion
  re-render resolves them.
