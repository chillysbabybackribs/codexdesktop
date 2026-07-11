# Visual Contract

Use this document after a direction is selected or a visual reference is supplied. Record observable decisions before editing source.

## Contract schema

### Product story

- Audience:
- User promise:
- Primary action:
- Supporting proof:
- Required first-viewport content:

### Composition

- Reference viewport:
- Content max width:
- Outer gutters:
- Header height:
- Hero layout and column ratio:
- Primary visual bounds:
- Vertical anchors:
- Elements intentionally crossing the fold:

### Typography

For every tier record family, fallback, weight, size, line height, tracking, max width, and expected line breaks:

- display;
- section heading;
- body;
- label/eyebrow;
- UI and button text.

### Color and surface

Record semantic roles rather than a palette alone:

- canvas;
- primary and elevated surfaces;
- strong and muted text;
- hairline and strong borders;
- primary and hover action;
- secondary accent;
- selection, focus, success, warning, and error;
- shadow tint and opacity.

### Shape and texture

- radius scale;
- border widths;
- shadow recipes;
- grid, grain, or pattern behavior;
- decorative geometry rules;
- icon style and stroke weight.

### Motion

- entrance order and distance;
- hover displacement or scale;
- modal transition;
- duration and easing tokens;
- reduced-motion replacement.

### Responsive transformation

Record changes at desktop, tablet, and mobile. Describe reflow, hidden secondary content, navigation behavior, media aspect ratio, and type scaling.

## Comparison method

Compare at the same viewport whenever possible. Use this order:

1. Silhouette: do the largest masses occupy the same regions?
2. Hierarchy: is attention drawn to the same element first, second, and third?
3. Proportion: are headline, product visual, and whitespace ratios comparable?
4. Typography: do character, weight, wrapping, and density match?
5. Surface: do contrast, borders, shadows, and accents match?
6. Detail: do controls, icons, and micro-spacing feel consistent?

Classify mismatches as high, medium, or low impact. Fix all high-impact mismatches before fine detail. The visual image governs observable appearance; the written brief governs hidden behavior and tokens. User requirements override both.

## Anti-drift rules

- Do not replace prominent imagery with a generic gradient.
- Do not change hero alignment because a framework template makes another alignment easier.
- Do not add sections merely to make the page feel longer.
- Do not introduce colors absent from the contract without a semantic need.
- Do not shrink the primary product visual to accommodate decorative content.
- Do not preserve generated-preview text errors; use the approved real copy.
