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

## Choose the workflow

Use the **direct path** when the user supplies a complete visual direction, selected mockup, detailed brand system, or asks to skip exploration. Extract the visual contract and implement.

Use the **direction path** when the desired feeling or visual language is materially unresolved. Create three first-viewport design directions, let the user select one unless they asked Codex to decide, then implement.

Use the **reference-matching path** when an image, existing page, or design is supplied. Inspect it at high detail, record observable properties, and implement against a comparison checklist. Do not invent details that contradict the reference.

For any path, distinguish the requested product depth before implementation. A visual prototype may simulate data and integrations when clearly labeled. A functional site must implement and verify requested routes, forms, persistence, authentication, uploads, external services, and data behavior rather than merely drawing their interfaces.

Ask at most three concise questions only when missing audience, product purpose, required content, or technical constraints would materially alter the result. Otherwise make reasonable assumptions and state them briefly.

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

Do not browse for generic inspiration. Use external retrieval only for factual assets, real products, real people, documented APIs, or when the user requests research.

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
