# Asset manifest

| Source use | Source asset | Local path | Status | Notes |
| --- | --- | --- | --- | --- |
| Source visual truth | Neon desktop, tablet, and mobile captures | `../source/*.png` | copied evidence | Captured only for QA; never shipped in the page. |
| Source mobile menu state | Neon expanded menu capture | `../states/mobile-menu.png` | copied evidence | Captured only for interaction comparison. |
| Neon logo and wordmark | neon.com brand SVG | none | intentionally not copied | Replaced with a code-native Codex demo mark because the page is tailored to Codex Desktop. |
| Neon hero AV1 | `https://cdn.neonapi.io/public/pages/home/hero/hero-av1.mp4` | `public/media/neon-hero-av1.mp4` | copied locally | Browser-selected source; AV1, 2880 × 1248, 9.375s, 24fps. Permission assumed from the user’s clone request. |
| Neon hero MP4 fallback | `https://cdn.neonapi.io/public/pages/home/hero/hero.mp4` | `public/media/neon-hero.mp4` | copied locally | HEVC fallback; same intrinsic size and timeline. |
| Neon hero WebM fallback | `https://cdn.neonapi.io/public/pages/home/hero/hero.webm` | `public/media/neon-hero.webm` | copied locally | VP9 fallback; same intrinsic size and timeline. |
| Neon hero mobile illustration | Neon `bg-illustration.0v57pgq90-qg1.jpg` | `public/media/neon-hero-mobile.jpg` | copied locally | 1504 × 652 source rendered at the observed 752 × 326 mobile geometry. |
| Neon hero poster | `https://cdn.neonapi.io/public/pages/home/hero/poster.jpg` | `public/media/neon-hero-poster.jpg` | copied locally | 3840 × 1664 reference/poster asset retained locally; source video itself does not declare a poster attribute. |
| Neon product illustrations | Homepage image/video/SVG set | none | intentionally not copied | Capability cards remain accessible Codex-specific HTML/CSS interface previews; only the requested hero background uses exact Neon media. |
| Typeface | Open-source Inter and Geist Mono font files | `public/fonts/*.ttf` | copied locally | Matches the observable typographic character without runtime hotlinking; system fallbacks remain available. |
