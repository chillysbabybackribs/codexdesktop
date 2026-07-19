---
name: clone-live-site
description: Faithfully clone or recreate a live website or page as an interactive, frontend-only local app in Codex Desktop. Use only when the user asks to clone, recreate, replicate, or mirror a specific current site or URL. Do not use for requests to make something like a site, make it better, redesign it, improve it, or take inspiration from it; route those to build-polished-ui instead.
---

# Clone Live Site

Recreate a permitted live website from captured evidence, not memory or generic visual approximation. The result must be a real local frontend whose in-scope layout, assets, responsive behavior, and interactions match the source.

## Entry gate

- If the user explicitly invokes `$clone-live-site` for a clone or recreation, continue.
- Continue only for a specific live site, page, or URL that the user wants cloned, recreated, replicated, or mirrored.
- If the request says **like**, **better**, **redesign**, **improve**, **inspired by**, or otherwise asks for a new direction rather than a faithful copy, stop this workflow and use the direction or reference-matching workflow in `../build-polished-ui/SKILL.md`.
- This workflow is frontend-only. Do not claim to reproduce private backends, authentication, payment processing, protected data, or server behavior.

Before opening the source, warn the user that they must follow the target website's terms and that this workflow is only for sites they own or have permission to recreate. Do not bypass a login, access control, paywall, bot challenge, or technical protection.

## Required companion guidance

1. Read `../build-polished-ui/SKILL.md` and use its **reference-matching path**, visual-contract discipline, accessibility requirements, responsive checks, and production validation. Cloning supplies the visual direction; do not create three alternatives.
2. Load `../imagegen/SKILL.md` only if a required raster image or illustration cannot be copied locally. Follow its built-in-tool-first and project-bound save-path rules. Do not generate editable UI text, logos, icons, fonts, or vector marks.
3. Use the current workspace's `AGENTS.md` and repository instructions as higher-priority implementation and verification constraints.

## Scope contract

Before capture, define the in-scope route or routes and the destination directory. A single-page request includes every state and interaction visible or reachable from that page. Links leaving the requested route or domain may remain real links unless the user asks to clone those destinations too.

Write a compact internal contract containing:

- source URL and canonical final URL;
- in-scope routes, viewports, theme, locale, and auth state;
- destination project and whether it is an existing app or a new prototype;
- visible sections, interactions, and responsive states that must be reproduced;
- dominant motion regions, their fidelity tier (`exact asset`, `behaviorally equivalent`, or `static by source design`), and whether the source changes strategy by breakpoint or reduced-motion preference;
- behavior that must remain simulated because it requires a backend;
- source-evidence directory and local asset directory.

Do not let the scope silently grow from one page into an entire site.

## Phase 1: Workspace and browser preflight

Inspect the destination before making changes:

- read repository instructions, package manifests, routes, design tokens, and nearby components;
- preserve the package manager, framework, architecture, and unrelated user work;
- inspect `git status` and avoid overwriting existing assets or files;
- in the protected Codex Desktop host checkout, never start, stop, or replace the host dev process. Follow the repository's disposable verification rules.

Reuse the active visible browser tab. Do not create a new tab unless the user explicitly asks. Use `browser_navigate` with a useful `readySelector`, then wait for the requested DOM state rather than network idle or a fixed delay.

Confirm the page is the requested source before capture. Stop if the visible result is a wrong page, unrelated redirect, login wall, access challenge, promo or app-install interstitial, loading shell, or error page. Use another already available, user-approved browser surface only when repository guidance permits it. If no approved surface shows the valid source, report the blocker and do not scaffold.

## Phase 2: Capture source evidence

Create a persistent evidence area inside the destination project, normally `.codex/clone-evidence/<source-slug>/`, with `source/`, `states/`, `motion/`, and `manifests/` subdirectories. Keep consumed assets in the app's normal local asset directory, not in the evidence directory.

Capture before writing app code or starting a local server.

### Full-page visual pass

1. Start at the top at the source's normal desktop width.
2. Capture the visible viewport.
3. Scroll in small, overlapping steps. At each step, capture the viewport and record newly visible sections, sticky elements, animation, video, and lazy-loaded content.
4. Continue until the end of the in-scope page. Scroll back to the top and record anything whose state or position changed.
5. Repeat at `390 x 844`. Use viewport emulation only long enough for this pass and restore the normal viewport afterward.
6. Capture the first viewport at desktop, tablet, and mobile sizes. `ui_review` may gather these responsive screenshots and deterministic overflow/runtime checks together, but the model must still inspect the screenshots.

### DOM and style pass

Use `browser_snapshot`, `browser_extract_page`, targeted `browser_run`, and CDP inspection to gather observable source facts. Save bounded evidence rather than flooding chat with a full hydrated DOM.

Record:

- semantic regions, component hierarchy, exact visible copy, links, and control labels;
- measured bounds, grids, gutters, spacing, alignment, breakpoints, sticky positions, and stacking;
- computed colors, typography, font-face sources, weights, line heights, tracking, borders, radii, shadows, and background treatments;
- image, SVG, video, poster, sprite, mask, cursor, icon, stylesheet, and font URLs used by the rendered page;
- hover, focus, active, selected, disabled, loading, error, empty, expanded, and modal states that exist in scope;
- desktop-to-mobile reflow, reordering, hiding, replacement, overflow, and touch behavior.

Use screenshots as visual truth and DOM/style data as implementation evidence. Do not implement a state from a screenshot alone when browser evidence for that state is available.

### Motion and temporal-media pass

Treat visible motion as a first-class fidelity surface. A screenshot records composition, not animation transport, timing, frame content, crop behavior, or responsive fallbacks. If any in-scope region contains video, animated raster media, SVG animation, CSS/WAAPI animation, canvas, WebGL, Lottie, Rive, Spline, a marquee, parallax, or state-driven transition, read and follow `references/motion-capture.md` before implementation.

Create `manifests/motion.md` and one evidence folder per motion region under `motion/`. For each region:

- classify it as transferable media, code-native animation, runtime-rendered animation, or interaction/scroll-driven motion;
- assign criticality. Motion is **dominant** when it sits behind or beside the primary message, occupies roughly 20% or more of the first viewport, or materially carries the source's brand character. Missing or generically substituting dominant motion is a blocking P1;
- capture the actual transport and all fallbacks: `currentSrc`, nested `<source>` entries, MIME types/codecs, posters, intrinsic dimensions, duration, frame rate when available, autoplay/muted/loop/plays-inline/preload/controls state, canvas resolution, loaded animation libraries, and CSS/WAAPI keyframes and timing;
- start network capture before navigation or state activation and record media, range responses, animation JSON, sprites, shaders, workers, and responsive variants. DOM URLs alone are insufficient because the browser may select only one codec or lazy-load a source;
- record container bounds, overflow crop, object fit/position, transforms, masks, filters, blend modes, opacity, stacking, overlays, and the text or controls layered above the motion;
- capture time-aligned source frames or states using media timeline control or animation timeline control, not arbitrary screenshots taken at unknown phases;
- test desktop, tablet, mobile, reduced-motion, first load, loop seam, offscreen/on-screen behavior, hover/focus/tap activation, and any visibility-triggered play/pause behavior that exists in scope;
- restore the source's playback, scroll, and interaction state after inspection.

Do not write app code until every dominant motion region has a resolved implementation route and evidence set. If the original permitted asset cannot be acquired and a behaviorally equivalent recreation cannot be validated at matched timestamps, mark QA blocked instead of replacing it with a gradient, generic CSS bars, or a static poster.

### Interaction pass

Build an interaction matrix in `manifests/interactions.md`. For every in-scope control, record the start state, action, resulting state or navigation, keyboard behavior, and evidence path.

- Test one control at a time.
- Return to the same starting state before the next test.
- Include navigation, links, buttons, inputs, forms, menus, drawers, dialogs, tabs, accordions, carousels, filters, hover/focus states, sticky behavior, and media controls.
- Save a screenshot whenever the visible state changes; record nonvisual state changes from DOM or accessibility evidence.
- Never submit a destructive, financial, publishing, messaging, account, or production-changing action merely to observe it. Inspect safely or stop at the confirmation boundary.

## Phase 3: Acquire local assets

Create `manifests/assets.md` with one entry per visible required asset: source URL, source element or CSS use, local path, dimensions, crop/focal point, license or permission note when known, and status (`copied`, `generated replacement`, `font substitute`, `icon substitute`, or `blocked`).

- Save authorized source assets locally. Never hotlink them in the final app.
- Preserve original SVG, raster, video, and font files when they can be fetched and their use is permitted.
- Preserve codec fallbacks, posters, animation data, sprites, shaders, and worker files that are required for the observed motion path. Inspect downloaded media metadata and verify it decodes locally before implementation.
- Do not replace visible source imagery or motion with CSS art, gradients, emoji, text glyphs, placeholder blocks, handmade SVGs, generic stock assets, or a static frame. In a faithful clone, a source video is a video unless the source itself uses a static fallback at that viewport or preference.
- If an inaccessible raster photo or illustration is necessary, load `$imagegen`, use the source screenshot as a reference, generate only the missing underlying visual, inspect it, and copy the selected output into the destination project before use.
- Do not use image generation for logos, wordmarks, UI text, icons, fonts, or code-native vector marks. Obtain the authorized original. For a non-brand icon only, use the closest matching open-source icon family and record the substitution. Do not default to Lucide unless it is genuinely the closest match.
- If a fidelity-critical logo, font, icon, video, or other asset cannot be copied or acceptably substituted, stop and mark QA blocked instead of hiding the gap.

Do not begin implementation until desktop and mobile capture, key states, the interaction matrix, the motion manifest, and every required visible asset have a resolved manifest status.

## Phase 4: Build the local frontend

Build only from captured source evidence and the asset manifest.

- In an existing app, reuse its components, routing, tokens, and conventions.
- For a new prototype, create the smallest self-contained project that fits the workspace's existing package manager and standard frontend tooling. Do not introduce an unrelated framework or global dependency.
- Keep exact source copy, information architecture, visual hierarchy, and responsive behavior unless technical or legal constraints require a documented deviation.
- Reproduce the observed motion system, not merely its first frame. Preserve source ordering, codecs, poster behavior, autoplay policy, loop behavior, playback rate, timeline duration, crop, overlays, activation rules, breakpoint replacements, and reduced-motion treatment. Use the smallest implementation that matches the evidence; do not rebuild an ordinary transferable video as canvas or CSS.
- Implement source UI text and controls in accessible HTML/CSS, never as rasterized text.
- Implement every in-scope interaction in the matrix. Use realistic local mock data for frontend states, and label simulated backend outcomes honestly in code and handoff notes.
- Do not add visual ideas, extra sections, decorative effects, invented claims, or routes unsupported by the source.
- Use semantic landmarks, correct heading order, native controls, visible focus, keyboard behavior, reduced motion, suitable contrast, meaningful alt text, and at least 44px mobile touch targets.

Only after the route is ready, install dependencies if needed and start the project's normal local preview command in a persistent terminal session. Use an available loopback port, wait for a useful DOM selector, and keep the preview running through handoff. A listening port or successful build is not visual verification.

## Phase 5: Compare and correct

Preserve source and implementation screenshots at the same viewport, route, theme, content, and interaction state. Create a side-by-side comparison artifact for each required state so both images can be judged together.

At minimum compare:

- desktop `1440 x 900`;
- tablet around `820 x 1180`;
- mobile `390 x 844`;
- every captured interaction state that changes appearance or layout.
- every dominant motion region at matched timeline positions and activation states, including its mobile and reduced-motion variants.

Compare in descending impact order:

1. composition, content order, and major-region proportions;
2. typography, font loading, wrapping, and scale;
3. spacing, alignment, density, and negative space;
4. imagery, crop, asset fidelity, and icon family;
5. colors, surfaces, borders, radii, shadows, and motion;
6. hover, focus, keyboard, responsive, and reduced-motion behavior.

Use `ui_review` for the implementation's desktop, tablet, and mobile audit. Inspect every screenshot, test primary interactions in the browser, and check console exceptions, failed requests, broken assets, overflow, clipping, headings, landmarks, and touch targets. For motion, also verify that playback advances, the intended codec/source loads, the poster does not flash incorrectly, the loop seam is acceptable, crop and overlays remain aligned throughout the timeline, offscreen media obeys the source policy, and reduced motion matches the source. Fix the largest visible mismatch first, capture again at the same viewport and timeline position, and repeat until no P0/P1/P2 issue remains.

## Phase 6: Blocking design QA

Create project-root `design-qa.md` using `references/design-qa-template.md`.

- The report must name the source visual truth, implementation capture, viewport, state, full-view comparison artifact, any focused-region evidence, interaction checks, console/network checks, findings, and correction history.
- When motion exists, the report must also name the motion manifest, source and implementation timeline frames or recordings, tested timestamps/states, selected media source and codec, playback/loop result, responsive and reduced-motion result, and any dropped-frame or load failure evidence.
- Classify findings as P0, P1, P2, or P3. P0/P1/P2 are blocking; P3 may remain as follow-up polish.
- Set `final result: passed` only when source and implementation evidence were both inspected and no actionable P0/P1/P2 finding remains.
- If source capture, implementation capture, responsive inspection, state comparison, required asset acquisition, or browser verification is unavailable, set `final result: blocked` and stop.
- Do not hand off unless `design-qa.md` exists and ends with `final result: passed`.

Run the destination project's production build, type checks, and relevant tests after visual QA. Follow repository-specific verification commands and do not start a competing Codex Desktop host process.

## Handoff

Keep the verified local preview running. Return the clickable loopback URL first, followed by:

`I've finished building. Let me know if I can tighten anything up or build out more functionality.`

Then briefly report:

- what route and states were cloned;
- validation performed and the `design-qa.md` path;
- copied assets and any recorded substitutions;
- honest frontend-only or simulated-behavior limitations;
- remaining P3 iteration notes, if any.

Do not claim pixel-perfect, identical, deployed, or production-ready unless the evidence supports that exact claim.

## Failure handling

- Invalid or blocked source: stop before scaffolding and describe the visible blocker.
- Missing evidence or unresolved required asset: record it and set QA blocked.
- Missing dominant-motion evidence, an unauthorized/unavailable required animation asset, a static or generic substitute for source motion, or an implementation whose timeline cannot be compared deterministically: record it and set QA blocked.
- Preview unavailable: production checks may continue, but visual QA remains blocked.
- Reference omits a necessary minor state: infer the smallest behavior consistent with captured states and label it as an inference.
- Source requires private server behavior: reproduce only the permitted frontend state with explicit simulation, or narrow scope with the user.

## References

- `references/motion-capture.md`: blocking workflow for discovering, acquiring, reproducing, and validating video, canvas, WebGL, CSS/WAAPI, and interaction-driven motion.
- `references/design-qa-template.md`: required final clone QA structure.
