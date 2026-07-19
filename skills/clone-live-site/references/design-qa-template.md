# Clone design QA template

Save this as `design-qa.md` in the cloned project's root. Add one comparison entry per required viewport and interaction state.

```markdown
# Design QA

## Scope

- Source URL:
- Canonical source URL:
- In-scope routes:
- Theme, locale, and auth state:
- Source evidence root:
- Local preview URL:

## Comparison evidence

### <viewport and state>

- Viewport:
- State:
- Source screenshot:
- Implementation screenshot:
- Side-by-side comparison:
- Focused region comparisons, or why none were needed:
- Interactions tested:
- Console exceptions:
- Failed requests or broken assets:
- Overflow, clipping, landmarks, headings, and touch-target result:

## Required fidelity surfaces

- Composition and content order:
- Fonts, typography, and wrapping:
- Spacing, layout rhythm, radii, and elevation:
- Colors and semantic tokens:
- Images, video, logos, and icon fidelity:
- Copy and app-specific content:
- Interaction and responsive behavior:
- Accessibility and reduced motion:

## Findings

- [P0/P1/P2/P3] <short title>
  - Location:
  - Evidence:
  - Impact:
  - Fix:

## Correction history

### Pass <n>

- Earlier P0/P1/P2 findings:
- Fixes made:
- Post-fix screenshots:
- Post-fix comparison:
- Remaining findings:

## Asset substitutions

- <asset, reason, replacement, and fidelity limitation>

## Follow-up polish

- <remaining P3 only>

final result: passed
```

Use `final result: blocked` instead when evidence is missing or any actionable P0/P1/P2 issue remains. The final result line must be the last nonblank line in the file.

