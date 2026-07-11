---
name: studio-launch
description: Execute the distribution checklist for a shipped app: directory and marketplace submissions via the logged-in embedded browser, launch-post drafts, and listing upkeep. Crystallizes each site's submission flow into a reusable automation script so reruns are cheap. Invoke with $studio-launch <idea-slug>.
---

# Studio Launch

Distribution is repetitive, logged-in form work — exactly what the embedded browser is for. First time through a site, do it interactively; then **crystallize the flow into a script** so the next launch replays it for free.

## Input and state

Target `ideas/<slug>/`. Maintain `ideas/<slug>/launch.md` as the single source of truth:

```markdown
# Launch: <app name>
Assets: name | one-liner | 240-char description | long description | URL | logo path | screenshots | tags | maker handle
## Checklist
| Target | Type | Status | Listing URL | Notes |
|---|---|---|---|---|
| <directory/community/post> | submit/post | todo / drafted / awaiting-user / submitted / live / rejected | | |
```

If `launch.md` is missing, create it: gather assets from the idea folder and the app itself, then propose a target list (launch directories, niche communities from the idea's evidence sources, relevant marketplaces) and record it before executing anything.

## Publish guardrail

Filling forms, saving drafts, and preparing listings is autonomous work. **Final outward publication is not**: before pressing the final submit/post button on anything public (directory submission, forum/social post, marketplace listing), stop, set the row to `awaiting-user`, and show what will be published — unless the user has explicitly said to publish without review in this conversation. Never fabricate reviews, upvotes, or sockpuppet engagement; one honest post per community.

## Execution

Work the checklist top-down, a few targets per run:

1. Skim the target's submission page first (`browser_run` on a visible tab); confirm the fields against the assets block.
2. Fill via `browser_run`. OAuth/login popups are supported — reuse the visible logged-in session.
3. Record the resulting listing URL and status in `launch.md` immediately after each target.

## Crystallize

After successfully submitting to a site, save the flow as `automations/<site>.mjs` in the workspace: a Node script that drives the browser through `CODEX_BROWSER_SOCK` (see the artifact-first-web-research skill for the socket helper pattern), taking the assets as a JSON argument, printing a one-line JSON envelope (`{"ok":true,"listingUrl":...}`). Append one line to `automations/MANIFEST.md`: script, site, what it does, last-verified date.

On later launches: run the existing script first; only fall back to interactive driving when it fails, then **fix the script** and update its last-verified date. The automation library is a deliverable of every launch, not a byproduct.

## Post drafts

For communities (HN, Reddit, X): write the post in the voice of a builder sharing work, grounded in the original pain evidence from `idea.md` — quote the problem, not the feature list. Save drafts to `ideas/<slug>/posts/` and mark `awaiting-user`.

## Budget

3–8 targets per run. End with the checklist table's changed rows and anything `awaiting-user` clearly flagged in chat.
