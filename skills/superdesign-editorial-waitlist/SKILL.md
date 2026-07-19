---
name: superdesign-editorial-waitlist
description: Build a cinematic editorial waitlist landing page using the verified Superdesign Editorial Waitlist reference: matte charcoal, warm earth tones, oversized typography, a brutalist grid, subtle noise, layered text depth, and restrained motion. Use when the user explicitly requests this reference or an editorial waitlist style; do not use for ordinary waitlist pages.
---

# Superdesign Editorial Waitlist

Use this as a visual contract for an editorial waitlist or invite-only landing page. It is a distilled implementation guide from the public [Superdesign Editorial Waitlist reference](https://superdesign.dev/library/superdesign-editorial-waitlist), not its gated full prompt. Do not use the Superdesign name, logo, or source copy in the output unless the user supplies permission and content for them.

## Product fit

Use this direction for luxury technology, architecture, creative agencies, exclusive memberships, or other products that should convey quiet confidence and deliberate scarcity. Do not add fake member counts, launch dates, testimonials, or availability claims.

## Visual contract

- Set the primary canvas to matte charcoal `#181818`; use warm beige `#EBDCC4` for dominant text.
- Keep accent colors in a narrow earth-tone family: coral, rust, sage, and deep brown. Define them as semantic CSS variables before using them.
- Use a brutalist, refined grid with generous negative space. Prefer hard alignments and broad editorial columns to card-heavy SaaS composition.
- Make the hero headline oversized, uppercase where appropriate, edge-aware, and tightly set. Use a display line-height near `0.85` only when readability remains intact on narrow screens.
- Add subtle fixed viewport noise with CSS or a lightweight local asset. It must be decorative, non-interactive, and hidden from assistive technology.
- Create text depth by duplicating a headline: a transparent, stroked back layer offset by `4px 4px` in muted brown; a warm-beige front layer. Keep both layers synchronized and expose only one semantic heading to screen readers.
- Do not use gradients, box shadows, soft glass surfaces, rounded pill buttons, generic dashboard cards, or decorative icon clusters.

## Page structure

Build the complete flow as four purposeful regions:

1. Minimal navigation with a quiet wordmark and one restrained action.
2. Oversized hero headline with a concise exclusivity proposition.
3. Bottom content grid that carries the supporting statement and proof-free context.
4. Email capture and footer, with labelled input, visible validation, submit/loading/success/error states, and an explicit privacy expectation when applicable.

Keep the primary action obvious without making it look like a bright SaaS CTA. A squared or subtly rounded control with strong contrast is preferable to a pill.

## Signature details

- A 64px circular waitlist badge may sit at the bottom-right of the desktop composition. Use a 1px `#35211A` border and a text path reading `WAITING LIST • WAITING LIST •` rotating once every 12 seconds.
- Respect `prefers-reduced-motion: reduce`: render the badge static and remove nonessential entrance motion.
- The badge must not obscure the form, footer links, or mobile content; reflow or remove it below the smallest useful breakpoint.

## Responsive and quality checks

- Preserve the editorial hierarchy on mobile instead of shrinking desktop type indiscriminately. Recompose the bottom grid into a readable vertical sequence.
- Keep text and controls accessible: semantic landmarks, one real `h1`, labelled email field, keyboard-visible focus, 44px minimum touch targets, and contrast checked against the matte background.
- Render the real page at desktop, tablet, and mobile widths. Check headline wrapping, the noise overlay, the text-depth alignment, the form states, overflow, reduced motion, and badge placement before handoff.
