# Premium and Enterprise Evaluation

Evaluate the first viewport for premium visual quality, then evaluate the complete implementation for enterprise readiness. A result must pass both; one cannot compensate for the other.

## Premium visual score: 100 points

| Category | Weight | Five-point behavior |
| --- | ---: | --- |
| Art-direction specificity | 20 | The product remains identifiable after removing its logo and copy. |
| Composition and hierarchy | 15 | Visual masses, negative space, and reading order feel deliberately authored. |
| Media quality and integration | 15 | Imagery is credible, art-directed, well-cropped, and structurally integrated. |
| Typography | 15 | Type character, scale, line breaks, measure, and contrast reinforce the concept. |
| Product and audience relevance | 10 | The design reflects this product, buyer, and primary action rather than a template category. |
| Color, material, and texture | 10 | Palette and surface decisions form a coherent semantic system. |
| Responsive plausibility | 10 | The visual idea survives tablet and mobile instead of merely stacking. |
| Originality without gimmickry | 5 | The page has a memorable device without sacrificing comprehension. |

Convert each category's 1–5 rating to its weighted score. Require at least 82/100 and no category below 3/5 before implementation or handoff.

## Enterprise readiness: required gates

- Truthful content and explicit simulation boundaries
- WCAG-aware semantics, contrast, keyboard behavior, focus, and alternatives
- Responsive behavior at 1440×900, 820×1180, and 390×844
- No horizontal overflow, clipped primary content, console exceptions, or broken requests
- Optimized, dimensioned, replaceable media with documented provenance
- Reusable tokens, cohesive components, production build, type checks, and relevant tests
- Loading, empty, error, success, disabled, and reduced-motion states when the product requires them

## Correction policy

Fix the lowest premium category first unless an enterprise gate is broken. Re-render at the same viewport and rescore. Do not tune decorative details while composition, media, or typography scores remain below four.
