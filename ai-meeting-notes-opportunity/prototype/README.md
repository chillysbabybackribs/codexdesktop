# Signal Notes prototype

A standalone static prototype for the AI Meeting Notes opportunity. It uses local mock data only—there is no backend, login, paid API, recording bot, or upload to a remote service.

## Run locally

From the repository root:

```bash
python3 -m http.server 4173 --directory prototype
```

Then open `http://localhost:4173`.

## Included interactions

- Local-file import dialog with an explicit simulated/local-only state
- Search, filters, source-context jumps, and “review next” navigation
- Task completion toggle and owner assignment mock
- Confirmed-only Markdown handoff export
- Desktop/tablet/mobile responsive layouts and keyboard-visible focus states

## Visual contract

**Direction:** quiet editorial operations workspace. The focal point is the review queue, not a recording control; pale paper surfaces, forest-green actions, subtle mint status, and source-linked cards communicate a deliberate “trust before handoff” workflow.

**Responsive behavior:** the right health rail becomes a summary strip at tablet widths and a stacked section on mobile; the review queue moves before the transcript so the primary task stays first. Controls retain 40–44px minimum heights, and filter chips scroll rather than causing page overflow.

**Mock-data boundary:** all meeting content is fictional and held in source code. Replace the data and local handlers with a real, consent-aware ingestion and review flow before treating this as a product.
