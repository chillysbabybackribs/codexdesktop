# Quality Gates

Do not hand off until every applicable required gate passes.

## Visual direction

- [ ] The page has one clear focal point and primary action.
- [ ] The implemented result follows the selected visual contract.
- [ ] The first viewport has deliberate hierarchy and negative space.
- [ ] Typography has an intentional scale, measure, and line-height system.
- [ ] Colors have semantic roles and adequate contrast.
- [ ] Surfaces, radii, borders, and shadows follow a consistent vocabulary.
- [ ] Product visuals look credible rather than like generic placeholders.
- [ ] Decorative elements support the composition without competing with content.

## Content

- [ ] The headline communicates a benefit or differentiated promise.
- [ ] Supporting copy is specific and concise.
- [ ] Button labels describe outcomes.
- [ ] Navigation and proof elements are relevant.
- [ ] No lorem ipsum, unexplained sample data, or fabricated customer claims remain.

## Interaction

- [ ] All visible controls work.
- [ ] Hover, focus, active, and disabled states are intentional.
- [ ] Dialogs open, trap focus, close through all expected routes, and restore focus.
- [ ] Zoom, pan, and reset stay within valid bounds.
- [ ] Loading, empty, and error states exist when the surface requires them.
- [ ] Motion explains state and respects reduced-motion preferences.

## Responsive

- [ ] Desktop at 1440 × 900 is balanced and matches the visual contract.
- [ ] Tablet reflows rather than merely shrinking.
- [ ] Mobile at roughly 390px has no horizontal overflow.
- [ ] Touch targets are at least 44px.
- [ ] Long text, navigation, controls, and media remain usable.
- [ ] Secondary product rails collapse before primary content becomes illegible.

## Accessibility

- [ ] Landmarks and heading hierarchy are semantic.
- [ ] Keyboard navigation reaches every action in a logical order.
- [ ] Focus is always visible.
- [ ] Icon-only controls have accessible names.
- [ ] Color is not the only carrier of meaning.
- [ ] Meaningful images have alternatives and decorative images are hidden.
- [ ] Text and interactive states meet appropriate contrast targets.

## Engineering

- [ ] Existing architecture and unrelated user changes are preserved.
- [ ] Components are cohesive without premature abstraction.
- [ ] Styling uses reusable tokens rather than scattered magic values.
- [ ] No console errors, missing keys, broken assets, or failed requests remain.
- [ ] The production build, types, and relevant tests pass.
- [ ] Placeholder media is isolated and straightforward to replace.

## Final review question

Ask: “If the logo and copy were removed, would this still look intentionally designed for this product?” If the answer is no, strengthen the product-specific visual and interaction decisions before handoff.
