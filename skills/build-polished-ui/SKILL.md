---
name: build-polished-ui
description: Design and implement high-quality web UI examples, landing pages, dashboards, product surfaces, and component showcases through a visual-contract-first workflow. Use when Codex is asked to build, redesign, prototype, or demonstrate a polished frontend; provide multiple visual directions; match the quality of a supplied reference; turn an image or brief into working UI; create an interactive application mockup; or improve a page that feels generic, unfinished, or visually weak. Covers design exploration, generated visual previews, implementation briefs, responsive frontend implementation, interaction design, accessibility, visual QA, and production validation.
---

# Build Polished UI

Produce intentional product design, not decorated boilerplate. Establish what “good” looks like before implementing, translate the selected direction into an explicit visual contract, and verify the working result against that contract.

## Operating principles

- Lead with the product story and primary user action.
- Make every visual choice support hierarchy, comprehension, trust, or delight.
- Keep concepts comparable during design exploration: hold copy, viewport, and content constant while varying the visual system.
- Treat references as evidence, not inspiration to approximate loosely.
- Prefer a few strong decisions over many decorative effects.
- Build the complete interaction, including empty, hover, focus, active, loading, error, reduced-motion, and responsive states when applicable.
- Treat generated concepts, running previews, and deployments as different artifacts. Never present a concept image as implemented UI or a local preview as shipped work.
- Never claim visual parity without inspecting rendered output.
- Treat premium visual quality and enterprise readiness as separate gates. The result must pass both; a beautiful concept cannot compensate for a brittle implementation, and a correct implementation cannot compensate for generic art direction.
- Do not claim image generation was used merely because an image appears in the result. Confirm the generation tool call or image-generation trace item, record the resulting workspace asset, and ensure the active reasoning model can inspect image inputs.

## Choose the workflow

Use the **direct path** when the user supplies a complete visual direction, selected mockup, detailed brand system, or asks to skip exploration. Extract the visual contract and implement.

Use the **direction path** when the desired feeling or visual language is materially unresolved. Create three first-viewport design directions. Let the user select one when the options represent materially different brand positions; when the user delegated the decision, score the directions against the premium rubric and implement the strongest without adding an unnecessary pause.

Use the **reference-matching path** when an image, existing page, or design is supplied. Inspect it at high detail, record observable properties, and implement against a comparison checklist. Do not invent details that contradict the reference.

For any path, distinguish the requested product depth before implementation. A visual prototype may simulate data and integrations when clearly labeled. A functional site must implement and verify requested routes, forms, persistence, authentication, uploads, external services, and data behavior rather than merely drawing their interfaces.

Ask at most three concise questions only when missing audience, product purpose, required content, or technical constraints would materially alter the result. Otherwise make reasonable assumptions and state them briefly.

## Ambiguity triage and live reconnaissance

Before committing to a visual direction, identify the decisions that the brief does and does not support. The material unknowns are: audience and their immediate need, category conventions, brand position, primary conversion action, real content/assets, and technical constraints.

**Ask the user** about intent, taste, and business choices that cannot be learned elsewhere. Ask one to three high-leverage questions only when the answer would change the product story, information architecture, interaction model, or visual direction. Do not ask questions merely to defer progress, and do not ask the user for public facts that can be researched.

**Research live examples** when the uncertainty is external: current category conventions, the language used by a real audience, credible interaction patterns, available assets, or contemporary references. Use the artifact-first web research and browser tools to inspect two to four relevant live sources. Inspect rendered pages rather than search snippets and extract only observable decisions: hierarchy, conversion strategy, media treatment, density, responsive behavior, and accessibility-relevant patterns.

When a question is needed, start a provisional research pass from the facts already supplied while awaiting the answer. As soon as the user responds, actively refine the queries from their words, re-rank the examples, and discard anything that no longer fits. Search terms should combine the user's product, audience, desired or avoided qualities, conversion context, geography or price position when relevant, and intended medium. Do not lock a direction around examples gathered before an answer that materially changes the brief.

Treat live research as evidence, not a moodboard. It must answer named design decisions, such as: how the category establishes trust or scarcity; which language users encounter; which conventions are useful or tired; and what real content constraints affect the surface. Never copy a source's distinctive brand, copy, layout, asset, or geometry. Do not browse undirected galleries or collect examples without a decision they are meant to inform.

Before implementation, maintain a compact internal decision record: user-provided answers, live findings, remaining assumptions, and how each one affects the design. Share only the useful conclusion with the user unless they ask for the research notes.

## Phase 1: Understand the product

Before designing, write a compact internal brief containing:

1. Product and audience.
2. Single most important action.
3. User promise in one sentence.
4. Required content and interactions.
5. Existing brand, framework, assets, and repository constraints.
6. Trust signals or proof available.
7. Target viewport and delivery format.

Inspect the existing project before changing it. Preserve its package manager, architecture, design tokens, routing, and unrelated user work. Identify the smallest set of files needed.

Do not browse for undirected generic inspiration. For an ambiguous brief, use bounded live research to resolve real category, audience, content, and convention decisions before selecting a direction. Use external retrieval for factual assets, real products, real people, documented APIs, and this decision-oriented reconnaissance.

### Calibrate to examples and taste

Use the user's answers and live reconnaissance to choose the examples. A source is relevant only when it matches at least two of product category, audience, conversion context, editorial/media strategy, or stated desired/avoided qualities. Prefer live, currently rendered examples for category and interaction evidence; use the local example manifest as a bounded visual-calibration library.

Before establishing directions, retrieve at most two relevant good examples and one paired counterexample from `examples/manifest.json`. Prefer product, audience, composition, and media-strategy matches over palette matches. Run `node scripts/select-examples.mjs "<product and desired visual direction>"` from this skill directory when the relevant examples are not obvious.

Read each selected example's brief and critique, then inspect its reference image. Extract reusable decisions; do not copy its brand name, copy, distinctive asset, or exact geometry. Use the counterexample to name the failure mode that the new result must avoid.

If a confirmed `.codex/ui-taste.json` exists in the workspace, use it to rank directions. Never infer or persist a durable taste profile without user confirmation, and never let a taste profile override product suitability. See [taste-profile.md](references/taste-profile.md).

## Phase 2: Establish a visual contract

### Direction path

Create exactly three meaningfully distinct first-viewport directions. Keep these variables identical across them:

- conceptual desktop viewport: 1440 × 900, 16:10;
- copy, information architecture, and primary action;
- product capabilities shown;
- approximate content density.

Vary high-impact design decisions such as palette, typography character, composition, density, surface treatment, and imagery. Do not create three color swaps of the same layout.

Each direction must show only what belongs in the first viewport:

- navigation or product header;
- hero message and primary action;
- realistic product surface, meaningful visual, or proof element;
- only the beginning of supporting content when naturally visible.

Use image generation for expressive mockups when available. Generate clean page concepts without browser chrome, device montages, unrelated logos, or watermarks. If image generation is unavailable, provide implementation-ready written directions and ask the user to choose; do not pretend they are visual previews.

Before using supplied references or generated concepts, confirm that the active reasoning model accepts image input. Before claiming image generation is available, confirm that the `image_gen` tool is callable. The reasoning model and image-generation model are separate capability boundaries: the former must inspect references and renders; the latter creates raster assets.

Inspect every generated concept before presenting it. Reject or regenerate concepts with malformed text, inconsistent shared content, impossible interface geometry, missing primary actions, or obvious divergence from the product brief. A compelling image that cannot reasonably guide implementation is not a valid direction.

For each option, record:

- short title and design thesis;
- exact palette with hex values and semantic roles;
- font families, weights, sizes, line heights, and tracking;
- max width, regions, grid, gutters, and key spacing;
- border, radius, shadow, texture, and imagery rules;
- component treatment and application-window anatomy;
- hover, focus, entrance, modal, and reduced-motion behavior;
- tablet and mobile adaptation.

Present the three previews as numbered options with minimal prose. Wait for selection unless the user explicitly delegated the choice.

Score each direction using [evaluation-rubric.md](references/evaluation-rubric.md). Require at least 82/100 and no category below 3/5. If no direction passes, revise the weakest category before presenting or selecting a direction.

### Reference-matching or direct path

Inspect every supplied or selected image. Build an observable checklist:

- page background and dominant color ratios;
- headline width, line breaks, scale, weight, and alignment;
- header height and horizontal anchors;
- primary visual size and position;
- negative-space distribution;
- surface radius, border, shadow, and layering;
- accent geometry and recurring motifs;
- density and visible content below the fold.

Read [visual-contract.md](references/visual-contract.md) for the full schema and comparison rules.

## Phase 3: Implement the system

Implement the selected direction as a coherent system rather than a screenshot trace.

Build the complete requested experience, not only the hero or selected first viewport. Implement every requested route, section, form, interaction, and applicable loading, empty, success, confirmation, disabled, and error state. Keep simulated behavior explicit; never imply that a backend, payment flow, authentication system, upload pipeline, or external integration works unless it is implemented and verified.

Write realistic, product-specific copy. Do not leave placeholder prose, unexplained sample data, or vague claims. Do not fabricate customers, testimonials, usage statistics, performance results, certifications, or endorsements.

### Asset escalation

Decide the dominant-media strategy before writing the hero implementation:

- When the product promise depends on place, people, atmosphere, physical materials, food, craft, fashion, architecture, or lifestyle, use supplied photography, generated raster imagery, or a deliberately chosen illustration asset. A CSS shape or generic gradient is not an equivalent substitute.
- Use code-native SVG, CSS, or canvas when illustration, diagram, data, interface structure, or geometric identity is the intended brand medium.
- Do not generate raster UI text that should remain editable, responsive, searchable, or accessible. Generate the underlying scene or product asset and implement typography and controls in code.
- Record asset provenance, intended crop, responsive focal point, dimensions, alternative text, optimization plan, and replacement boundary.
- For project-bound generated imagery, copy the selected output into the workspace before referencing it. Never leave a consumed asset only in a tool cache or generated-images directory.

### Foundation

- Define semantic CSS custom properties for canvas, surfaces, text, muted text, border, primary, accent, success, warning, shadow, radius, and motion.
- Use a consistent spacing rhythm, normally an 8px base with purposeful exceptions.
- Use fluid type and spacing with `clamp()` where it improves scaling.
- Keep line lengths readable: roughly 8–14 words for display lines and 45–75 characters for body copy.
- Use available project fonts or reliable fallbacks. Do not add a dependency solely to imitate a common sans-serif.
- Prefer layout primitives—grid, flexbox, intrinsic sizing, and aspect-ratio—over brittle absolute positioning.

### Composition

- Give the first viewport one unmistakable focal point.
- Make the primary action visually dominant; keep secondary actions quieter.
- Use asymmetry only when it strengthens direction and balance.
- Preserve deliberate negative space. Do not fill every region with cards.
- Avoid the generic “centered heading plus three identical cards” pattern unless the product genuinely calls for it.
- Avoid indiscriminate gradients, glass effects, glowing blobs, excessive pill shapes, and arbitrary decorative icons.

### Product visuals and placeholders

Make application previews credible. Include realistic hierarchy, labels, panels, state, data shapes, controls, and chrome. Do not use empty gray rectangles labeled “dashboard.”

For video or GIF placeholders:

- use a stable aspect ratio and poster-style application scene;
- include play state, progress, time, mute, and expand controls when appropriate;
- separate the placeholder implementation so a real `video`, GIF, or poster can replace it later;
- support opening a modal or lightbox;
- support zoom controls when requested, with an obvious reset;
- constrain panning to the media bounds at magnified scale;
- close through Escape, backdrop, and a labeled close button;
- restore focus to the invoking control;
- trap focus while modal content is open;
- lock background scroll without shifting layout.

See [interaction-patterns.md](references/interaction-patterns.md) for a detailed zoomable-media contract.

### Motion

- Use motion to explain hierarchy, causality, or state change.
- Keep interface transitions near 160–260ms with a consistent easing curve.
- Prefer opacity and transform for smooth animation.
- Avoid perpetual motion except for subtle, non-distracting status cues.
- Honor `prefers-reduced-motion: reduce` by removing nonessential movement.

### Responsive behavior

Design at desktop, tablet, and mobile widths. Do not merely scale desktop down.

Define a collapse strategy for every complex component: preserve, reflow, reorder, scroll, simplify, replace, or hide it. Choose deliberately for navigation, tables, sidebars, action groups, media compositions, dashboards, and dense controls rather than applying one global breakpoint rule.

- Recompose multi-column heroes below approximately 900px.
- Preserve the product visual’s legibility; collapse secondary rails before shrinking essential content.
- Maintain 44px minimum touch targets.
- Keep primary content within viewport gutters and prevent horizontal overflow.
- Preserve useful hierarchy when navigation collapses.
- Test long labels, narrow widths, and text wrapping.

### Accessibility

- Use semantic landmarks and correct heading order.
- Ensure every control is a native interactive element or has equivalent keyboard behavior.
- Provide visible `:focus-visible` treatment.
- Label icon-only controls.
- Maintain suitable text and UI contrast.
- Avoid conveying meaning through color alone.
- Keep decorative imagery out of the accessibility tree; give meaningful imagery concise alternatives.
- Announce dynamic status changes when users need them.

## Phase 4: Render and inspect

Run the application and inspect the real page. A successful build is not visual verification.

Keep the validation surfaces explicit:

- **design concept:** a static proposal used to select observable visual direction;
- **running preview:** the real implementation used to inspect rendering and behavior;
- **deployment or checkpoint:** a stable shareable build, created only when supported and requested.

Do not substitute one surface for another when reporting completion.

Validate at representative widths:

- desktop: 1440 × 900;
- tablet: approximately 820 × 1180;
- mobile: approximately 390 × 844.

At minimum inspect:

1. First-viewport composition and line breaks.
2. Visual comparison with the selected preview or reference.
3. Navigation and every primary action.
4. Modal, video, zoom, pan, reset, and close behaviors when present.
5. Keyboard traversal, Escape behavior, and focus restoration.
6. Overflow, clipping, awkward wraps, and touch targets.
7. Reduced-motion behavior.
8. Console errors and broken assets.

Compare the render with the visual contract in descending impact order:

1. composition and element placement;
2. scale and typography;
3. spacing and negative space;
4. colors and surface treatment;
5. borders, shadows, and small details.

Record the largest visible mismatches, fix them in impact order, render again at the same viewport, and compare again. Complete at least one correction pass whenever a material mismatch is present. Continue until no high-impact mismatch remains; do not spend time tuning tiny shadows while the hero proportions are wrong.

Use [quality-gates.md](references/quality-gates.md) as the final acceptance checklist.
Use [evaluation-rubric.md](references/evaluation-rubric.md) to score premium visual quality separately from enterprise readiness. Require the same 82/100 threshold for the rendered implementation, not only the selected concept.

When the `ui_review` tool is available, use it for the desktop, tablet, and mobile pass so viewport screenshots and deterministic DOM/runtime diagnostics are gathered together. The model must still inspect the screenshots; deterministic checks do not judge taste.

## Phase 5: Validate and hand off

Run the project’s production build, type checks, and relevant tests. Do not introduce a new toolchain solely for validation.

Report:

- what was built;
- the chosen visual direction and its defining qualities;
- key interactions and responsive behavior;
- validation performed;
- any honest limitation, especially placeholder media or missing real product assets;
- the preview, deployment, or relevant file links available to the user.

Do not expose internal process noise. Do not claim pixel-perfect or identical output unless a rendered comparison supports that claim.

## Failure handling

- If image generation fails, continue with detailed written directions or implement a user-supplied direction.
- If browser preview is unavailable, run production validation and clearly state that visual inspection remains outstanding.
- If deployment is unavailable or outside scope, provide the verified local result and say that no stable deployment was created.
- If the reference omits a required state, infer the smallest consistent behavior and label it as an inference.
- If real media is unavailable, create an attractive, functional placeholder without fabricating a recording.
- If an existing design system conflicts with a reference, preserve product consistency unless the user explicitly prioritizes the reference.

## Resources

- [visual-contract.md](references/visual-contract.md): extraction and implementation schema for selected previews and references.
- [interaction-patterns.md](references/interaction-patterns.md): accessible zoomable video and application-preview behavior.
- [quality-gates.md](references/quality-gates.md): visual, responsive, accessibility, and production acceptance criteria.
- [evaluation-rubric.md](references/evaluation-rubric.md): weighted premium score and separate enterprise readiness gates.
- [taste-profile.md](references/taste-profile.md): opt-in workspace taste preferences and persistence rules.
- [examples/manifest.json](examples/manifest.json): contrastive example index and bounded retrieval policy.
- [evals/benchmark-prompts.json](evals/benchmark-prompts.json): cross-category regression prompt set.
