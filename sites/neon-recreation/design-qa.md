# Design QA

## Scope

- Source URL: `https://neon.com/`
- Canonical source URL: `https://neon.com/`
- In-scope routes: public homepage only, tailored to current Codex Desktop capabilities.
- Theme, locale, and auth state: dark theme, English, unauthenticated.
- Source evidence root: `.codex/clone-evidence/neon-home/`
- Local preview URL: `http://127.0.0.1:4178/`

## Comparison evidence

### Desktop first viewport

- Viewport: 1440 × 900.
- State: top of page, navigation closed.
- Source screenshot: `.codex/clone-evidence/neon-home/source/desktop-top.png`
- Implementation screenshot: `.codex/clone-evidence/neon-home/implementation/desktop-top.png`
- Side-by-side comparison: `.codex/clone-evidence/neon-home/comparisons/desktop-top-side-by-side.png`
- Focused region comparisons, or why none were needed: the full first viewport contains the complete header, hero, actions, and capability summaries.
- Interactions tested: desktop Product popover opened, exposed three items, and closed.
- Console exceptions: none.
- Failed requests or broken assets: none.
- Overflow, clipping, landmarks, headings, and touch-target result: no horizontal overflow or unintended clipping; header/nav/main/footer landmarks and one H1 present; desktop controls are adequately sized.

### Tablet first viewport

- Viewport: 820 × 1180.
- State: top of page, mobile-style navigation closed.
- Source screenshot: `.codex/clone-evidence/neon-home/source/tablet-top.png`
- Implementation screenshot: `.codex/clone-evidence/neon-home/implementation/tablet-top.png`
- Side-by-side comparison: `.codex/clone-evidence/neon-home/comparisons/tablet-top-side-by-side.png`
- Focused region comparisons, or why none were needed: the full viewport shows the complete responsive hero and the horizontal capability rail.
- Interactions tested: menu trigger, hero actions, and capability overflow behavior.
- Console exceptions: none.
- Failed requests or broken assets: none.
- Overflow, clipping, landmarks, headings, and touch-target result: page-level horizontal overflow is absent; capability cards intentionally scroll within their rail; controls meet the 44px target.

### Mobile first viewport

- Viewport: 390 × 844.
- State: top of page, menu closed.
- Source screenshot: `.codex/clone-evidence/neon-home/source/mobile-top.png`
- Implementation screenshot: `.codex/clone-evidence/neon-home/implementation/mobile-top.png`
- Side-by-side comparison: `.codex/clone-evidence/neon-home/comparisons/mobile-top-side-by-side.png`
- Focused region comparisons, or why none were needed: the full viewport contains the complete mobile header, visual field, headline, actions, and start of the capability rail.
- Interactions tested: hero primary action updated the hash and began scrolling to `#primitives`; capability rail scrolls horizontally.
- Console exceptions: none.
- Failed requests or broken assets: none.
- Overflow, clipping, landmarks, headings, and touch-target result: no page-level horizontal overflow; no broken imagery or missing alt text; all interactive targets meet the 44px target.

### Mobile menu

- Viewport: 390 × 844.
- State: expanded mobile menu.
- Source screenshot: `.codex/clone-evidence/neon-home/states/mobile-menu.png`
- Implementation screenshot: `.codex/clone-evidence/neon-home/implementation/mobile-menu.png`
- Side-by-side comparison: `.codex/clone-evidence/neon-home/comparisons/mobile-menu-side-by-side.png`
- Focused region comparisons, or why none were needed: the full viewport shows all stacked navigation rows and bottom actions.
- Interactions tested: opens from the labelled trigger; five navigation links are visible; Escape closes and restores focus to the Open menu trigger.
- Console exceptions: none.
- Failed requests or broken assets: none.
- Overflow, clipping, landmarks, headings, and touch-target result: no overflow; menu items and actions are comfortably touch sized.

## Required fidelity surfaces

- Composition and content order: preserves the announcement/header/media-led hero/action/capability sequence and the alternating long-form black and mint product stories.
- Fonts, typography, and wrapping: local Inter and Geist Mono files reproduce the source's low-weight display typography and technical metadata; hero wrapping was corrected after the first comparison pass.
- Spacing, layout rhythm, radii, and elevation: generous section pacing, square diagrams, one-pixel rules, action-only pills, and a restrained product-window shadow match the source contract.
- Colors and semantic tokens: matte black, cool gray, white, pale mint, vivid green, acid yellow, and a small orange technical accent are defined as semantic CSS properties.
- Images, video, logos, and icon fidelity: the exact Neon hero AV1, HEVC, VP9, mobile illustration, and poster assets are local; the Codex wordmark and interface diagrams remain product-specific.
- Copy and app-specific content: database claims were replaced with verified current Codex Desktop capabilities: two runtimes, native Chromium, turn checkpoints, cross-provider review, multi-pane sessions, and disposable verification.
- Interaction and responsive behavior: desktop popovers, mobile menu, tabbed product surface, copy-command feedback, in-page links, horizontal mobile rail, and deliberate diagram reflow are implemented.
- Accessibility and reduced motion: semantic landmarks and heading order, labelled menu controls, native buttons/links, visible focus, Escape close/focus restoration, 44px touch targets, and a reduced-motion override are present.

## Interactive video demonstration

- Route/state: homepage `#interactive-demo`, initial poster/play state and active `Execution branch` inspection state.
- Desktop evidence: `.codex/clone-evidence/neon-home/implementation/interactive-video-desktop.png`.
- Mobile evidence: `.codex/clone-evidence/neon-home/implementation/interactive-video-mobile.png`.
- Playback: native HTML video with local AV1/HEVC/VP9 sources, play/pause, scrubbing, mute, fullscreen request, current-time display, and three timeline chapters.
- Hotspots: three timed native buttons appear over the recording; selecting one pauses playback, applies its focal zoom, and opens contextual content.
- Zoom and pan: 100–250% controls, click-to-reset, hotspot focal origins, and pointer drag constrained to 42% of the scaled overflow. Verified drag changed the frame translation from `0,0` to `70,35` at 165%.
- Keyboard: Space toggles playback while the player has focus; arrows seek; plus/minus zoom; zero and Escape reset the inspection. Global Escape reset was verified from the active inspection state.
- Development upload: the new control previews `video/*` files through a local object URL, labels the private local state, and restores the bundled demo without a reload.
- Responsive behavior: desktop retains the full control and chapter rails; mobile uses a 4:3 crop, icon-only hotspots, two-row controls, and a full-width inspection panel.
- Accessibility: native labelled controls, live contextual content, visible focus, 44px minimum touch targets including invisible timeline hit areas, no autoplay, and reduced animation under `prefers-reduced-motion`.
- Runtime result: no page-level horizontal overflow, broken media, console exception, or failed request at desktop, tablet, or mobile.

## Findings

- No open P0, P1, P2, or P3 findings in the hero motion region.

## Correction history

### Pass 1

- Earlier P0/P1/P2 findings: desktop hero wrapped to three display lines and pushed the capability summaries below the first viewport; tablet/mobile hero content also sat too low.
- Fixes made: reduced desktop display scale to the source's 1440px behavior, widened the display measure, moved hero content upward, and reduced tablet/mobile top offsets.
- Post-fix screenshots: `.codex/clone-evidence/neon-home/implementation/desktop-top.png`, `tablet-top.png`, and `mobile-top.png`.
- Post-fix comparison: all three files in `.codex/clone-evidence/neon-home/comparisons/`.
- Remaining findings: none in the requested hero motion scope.

## Asset substitutions

- Neon logo/wordmark: replaced with a code-native Codex demo mark to avoid representing the tailored page as Neon.
- Neon hero video and mobile illustration: copied locally with AV1/HEVC/VP9 fallbacks and source-matched responsive geometry; no runtime hotlinking.
- Neon capability-card media: still replaced by Codex-specific HTML/CSS interface previews because the page content remains tailored to this codebase.
- Typeface: open-source Inter and Geist Mono files are copied locally under `public/fonts/`; system fallbacks remain available.

## Validation

- `npm run build`: passed with Vite 7.3.6; 24 modules transformed.
- Responsive visual review: passed at 1440 × 900, 820 × 1180, and 390 × 844.
- Runtime checks: no exceptions, failed requests, broken images, missing alt text, or page-level horizontal overflow.
- Premium visual score: 90/100; no assessed category below 4/5.

## Motion evidence

- Motion manifest: `.codex/clone-evidence/neon-home/manifests/motion.md`.
- Source frames: `.codex/clone-evidence/neon-home/motion/hero-video/source/`.
- Implementation frames: `.codex/clone-evidence/neon-home/motion/hero-video/implementation/`.
- Contact sheets: `source-contact-sheet.png` and `implementation-contact-sheet.png` in the hero-video evidence directory.
- Tested timeline positions: 0, 2.344, 4.688, 7.031, and 9.32 seconds.
- Selected source and codec: local `neon-hero-av1.mp4`, AV1 Main, 2880 × 1248, 24fps, 9.375 seconds, 10-bit BT.709.
- Playback and loop: autoplay begins muted and inline; `currentTime` advanced 0.7506 seconds during a 0.75-second wall-clock sample; loop and source duration match Neon.
- Geometry: the live source and local implementation both measured `x=-39, y=50, w=1304, h=565.0625` at the same mid-desktop content viewport.
- Responsive result: 1920/1304/1016px desktop/tablet stages match the source classes; mobile replaces video with the exact illustration at 752 × 326 and the observed focal crop.
- Reduced motion: local clone pauses at frame zero; documented accessibility deviation because the inspected source continued autoplay.
- Network/decode result: selected AV1 loaded locally; no media 404, CORS error, decode error, or remote media request. No material playback failure observed.

## Follow-up polish

- If this disposable concept becomes a real product surface, confirm redistribution rights for Neon’s copied hero assets or replace them with an original commissioned motion system.

final result: passed
