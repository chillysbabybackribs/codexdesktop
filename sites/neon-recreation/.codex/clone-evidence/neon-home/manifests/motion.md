# Motion manifest

## `hero-video`

- Region: homepage hero, behind the primary heading and actions.
- Criticality: `dominant`; it occupies most of the first viewport and carries Neon’s visual identity.
- Fidelity tier: exact transferable media asset with source-matched crop and responsive fallback.
- Transport: HTML `<video>` with three local `<source>` entries.
- Activation: autoplay on first load, muted, looped, plays inline, `preload="metadata"`, no controls.
- Timing: 9.375 seconds, 24 fps, playback rate 1, continuous loop.
- Source order:
  1. `hero-av1.mp4`, `video/mp4; codecs=av01.0.05M.08,opus`
  2. `hero.mp4`, `video/mp4`
  3. `hero.webm`, `video/webm`
- Browser-selected source: AV1 in both Neon and the local implementation.
- Intrinsic media: 2880 × 1248, 10-bit YUV 4:2:0, BT.709.
- Source metadata: AV1 1,280,767 bytes; HEVC 1,607,959 bytes; VP9 1,874,483 bytes.
- Geometry:
  - Desktop stage: 1920 × 832, centered, top offset −64px.
  - Mid-desktop stage: 1304 × 565.0625, centered, top offset −50px.
  - Tablet stage: 1016 × 440.267, centered, top offset −8px.
  - Verified live/local mid-desktop bounds: `x=-39, y=50, w=1304, h=565.0625` at a 1226px content viewport.
  - The stage is overflow-clipped and fades to black at the bottom so hero copy remains legible.
- Mobile: video stage hidden; exact 1504 × 652 source illustration renders at 752 × 326, centered on a 40% focal point. Verified local bounds at 390px: `x=-220, y=84, w=752, h=326`.
- Reduced motion: Neon continued autoplay during source inspection. The local clone pauses at frame zero when `prefers-reduced-motion: reduce`; this is the smallest accessibility deviation from the source.
- Visibility: video is confined to the first hero and naturally leaves the viewport with the section.
- Local routes: `public/media/neon-hero-av1.mp4`, `neon-hero.mp4`, `neon-hero.webm`, `neon-hero-mobile.jpg`, and `neon-hero-poster.jpg`.
- Network behavior: local HTTP 200/206 media delivery; no final-page hotlink.
- Deterministic evidence times: 0, 2.344, 4.688, 7.031, and 9.32 seconds.
- Source-frame evidence: `../motion/hero-video/source/frame-00.png` through `frame-04.png`; contact sheet `../motion/hero-video/source-contact-sheet.png`.
- Implementation evidence: `../motion/hero-video/implementation/frame-00.png` through `frame-04.png`; contact sheet `../motion/hero-video/implementation-contact-sheet.png`.

## Supporting motion

- Announcement dots and interface state transitions remain CSS-native.
- All CSS animation and transitions collapse under `prefers-reduced-motion: reduce`.
