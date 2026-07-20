# _attic — quarantine from the 2026-07-20 deep clean

Files moved here instead of deleted because they looked stale/orphaned but weren't provably junk.
Everything here is tracked, so any item can be restored with `git mv _attic/<thing> <original-path>`
(original paths below). If nothing has been missed for a few weeks, delete this whole directory.

| Item | Original path | Why it's here |
|---|---|---|
| `HANDOFF.md` | `/HANDOFF.md` | Token-bloat audit handoff dated 2026-07-10; work long since done |
| `PROMPT_INPUT_DOCS.md`, `PROMPT_INPUT_QUICK_START.md` | repo root | Docs for the orphaned PromptInput component below |
| `prompt-input/components`, `prompt-input/lib` | `src/components`, `src/lib` | shadcn-style PromptInput drop-in; zero imports anywhere in the app, outside every tsconfig include |
| `components.json` | `/components.json` | shadcn config that only existed for that install |
| `sites/` | `/sites` | Static site output (verified-skills); not app code |
| `graphify-out/` | `/graphify-out` | doc-render stat cache; regenerates itself |
| `dist-juniper-oak/` | `/dist/juniper-oak` | Built idea-site; was untracked+gitignored, so moving (not deleting) was the only safe option |

Also done in the same clean (not in this dir):
- Removed stale agent worktrees under `.claude/worktrees/` (~109 MB). Their work is preserved on
  branches `claude/role-selector` (incl. a final snapshot commit of uncommitted changes, f983011)
  and `claude/peaceful-engelbart-838409`.
- Untracked `tsconfig.*.tsbuildinfo` and gitignored `*.tsbuildinfo` (machine-local build state).
- Note: `docs/` was already emptied by an earlier session (commit fc898b8); recover with
  `git checkout fc898b8~1 -- docs/` if the audit docs are needed again.
