# Interaction Patterns

## Zoomable application video or GIF

Implement the media shell so placeholder content can later be replaced by a real asset without restructuring the page.

### Closed state

- Render a `button` or place labeled controls inside a non-interactive media figure.
- Show a realistic poster frame, centered play action, and a labeled expand control.
- Preserve the specified aspect ratio with `aspect-ratio`.
- Keep controls visible over both bright and dark content through local scrims.
- Never autoplay audible media.

### Modal state

- Use a dialog with `aria-modal="true"` and an accessible title.
- Move focus into the dialog on open.
- Trap Tab and Shift+Tab within the dialog.
- Close on Escape, backdrop activation, and the close button.
- Restore focus to the invoker after close.
- Prevent background scrolling while preserving the page’s scrollbar width.

### Zoom and pan

- Provide labeled zoom-in, zoom-out, and reset controls.
- Use defined zoom steps such as 1, 1.25, 1.5, 2, and 2.5.
- Disable zoom-out at 1× and zoom-in at the maximum.
- Show the current zoom percentage.
- Enable pointer or touch panning only above 1×.
- Clamp translation so blank space cannot be dragged into the viewport.
- Reset translation when returning to 1×.
- Support wheel-plus-modifier zoom only if it does not interfere with ordinary page scrolling.
- Treat pinch zoom as an enhancement, not the only control.

For a placeholder, animate a CSS transform on a stable poster scene. For real video, transform the video wrapper rather than the browser’s native control layer.

### Playback placeholder

If no video exists, make the play button visibly toggle a simulated playing state. Animate a restrained progress indicator or application cursor only if the user expects a demonstration. Label it clearly as a preview placeholder in surrounding content; do not fabricate duration or imply a real recording exists.

### Motion and performance

- Animate opacity and transform, not layout-heavy properties.
- Use approximately 180ms for backdrop opacity and 220–300ms for media scaling.
- Pause background or simulated playback when the modal closes or document becomes hidden.
- Remove nonessential animation under reduced motion.
- Avoid large continuous filters or shadows that degrade mobile performance.

## Interaction acceptance tests

1. Open with mouse, touch, Enter, and Space where applicable.
2. Traverse every control in a sensible order.
3. Confirm focus never escapes the open dialog.
4. Confirm Escape closes and focus returns.
5. Confirm backdrop clicks close but media clicks do not.
6. Reach minimum and maximum zoom without errors.
7. Pan to all edges without exposing blank space.
8. Reset to an exact 1× centered state.
9. Resize while open and keep media within bounds.
10. Verify reduced-motion behavior.
