# Motion capture and fidelity contract

Use this workflow whenever a live page contains visible motion. Motion evidence is required before implementation because static screenshots cannot identify the transport, timeline, activation rules, responsive replacement, or correct local asset.

## 1. Classify every motion region

Create `manifests/motion.md`. Give each region a stable id and record:

| Field | Required evidence |
| --- | --- |
| Region and location | Selector or component description, route, viewport, bounds, stacking context, and nearby content |
| Criticality | `dominant`, `supporting`, or `incidental`, with the reason |
| Transport | video, animated image, SVG/SMIL, CSS transition/keyframes, Web Animations API, canvas 2D, WebGL, Lottie, Rive, Spline, marquee, parallax, scroll-driven, or interaction-driven |
| Activation | first load, autoplay, hover, focus, tap, selected state, intersection/visibility, scroll position, route transition, or user-controlled |
| Timing | delay, duration, iterations, direction, easing, playback rate, sequence order, pause/reset behavior, and loop seam |
| Media sources | DOM source list, browser-selected `currentSrc`, MIME type/codecs, network URL, status/range behavior, poster, animation JSON, sprites, shaders, workers, and script/library sources |
| Geometry | intrinsic dimensions, rendered bounds, aspect ratio, object fit/position, overflow crop, transforms, masks, filters, opacity, blend mode, z-index, and overlays |
| Responsive behavior | source/geometry/activation changes at desktop, tablet, mobile, coarse pointer, and orientation |
| Preferences | `prefers-reduced-motion`, data-saver, and any source-controlled pause or static fallback |
| Local route | permitted local asset or implementation module, fallbacks, and manifest status |
| Evidence | frame paths, state screenshots, network artifact, and comparison artifacts |

Treat motion as **dominant** when it is behind or adjacent to the main message, occupies roughly 20% or more of the first viewport, controls the visual identity, or materially changes how the layout is perceived. A missing or generic replacement for dominant motion is P1.

## 2. Discover the real transport before capturing frames

Start a fresh network journal before navigation, reload, scrolling, hovering, or selecting a state. Record relevant Image, Media, Fetch, XHR, Script, Worker, and WebSocket traffic. Media commonly arrives as HTTP 206 range responses; a zero encoded length from cache does not mean the asset is empty.

Inspect the rendered document, including open shadow roots, for:

- `video`, `source`, `track`, `audio`, animated `img`/`picture`, SVG animation, and CSS background images;
- `canvas` size versus rendered size and whether a 2D, WebGL, or WebGL2 context is active;
- `document.getAnimations({ subtree: true })`, each effect target, keyframes, computed timing, current time, playback rate, and play state;
- script URLs and globals associated with GSAP, Framer Motion, Lottie, Rive, Spline, Three.js, Pixi, or custom renderers;
- IntersectionObserver- or visibility-driven playback, hover/focus/tap activation, scroll-linked transforms, and route-transition wrappers.

For every video record at least:

- `currentSrc` and every nested source URL/type/media query;
- `autoplay`, `muted`, `loop`, `playsInline`, `preload`, `controls`, `poster`, `crossOrigin`, and `disablePictureInPicture`;
- `duration`, `currentTime`, `playbackRate`, `readyState`, `networkState`, `videoWidth`, `videoHeight`, `paused`, `ended`, and `error`;
- computed object fit/position, opacity, transform, filter, blend mode, bounds, parent crop, and overlays;
- `canPlayType()` result for each declared codec when codec choice matters.

Do not infer that a poster is the animation or that the first DOM source is the selected source. The browser's `currentSrc` and the network journal are the ground truth.

## 3. Capture deterministic temporal evidence

Create `motion/<region-id>/source/` and capture a minimum sequence that represents the timeline.

### Video and seekable media

1. Record the original paused state, current time, playback rate, volume/mute state, and loop state.
2. Wait for metadata. Select timeline points at `0`, `25%`, `50%`, `75%`, and just before the end. Add points around any visible transition or loop seam.
3. Pause, set `currentTime`, wait for `seeked`, then wait for `requestVideoFrameCallback` when available before capturing. A fixed delay alone is not evidence that the decoded frame is ready.
4. Capture the whole viewport and a focused crop of the motion region at each point.
5. Restore the original time and playback state.
6. Separately capture natural autoplay from a fresh load and verify that time advances at the expected rate.

If seeking is blocked by the transport, capture a start-relative sequence using `requestVideoFrameCallback` frame metadata and record the media time associated with each screenshot.

### CSS and Web Animations API

Record computed keyframes and timing. For deterministic captures, pause the relevant animations and assign the same timeline positions on source and implementation. Restore their play states afterward. Do not rely on two screenshots taken at uncontrolled phases.

### Canvas, WebGL, Lottie, Rive, Spline, and custom runtimes

Record the backing resolution, rendered bounds, renderer/library, input assets, and activation triggers. Use the runtime's documented timeline or pause/seek API when exposed. Otherwise capture a start-relative multi-frame sequence with timestamps and treat deterministic parity as unresolved if the two sequences cannot be aligned.

Do not copy protected application code, bypass controls, or defeat obfuscation. If a proprietary runtime cannot be acquired or recreated from permitted observable evidence, block faithful QA or narrow the scope with the user.

### Scroll- and interaction-driven motion

Record the input as part of the state: exact scroll offset/progress, viewport, pointer position, hover/focus/selected state, or gesture. Capture before, during, and after states. Return to the same initial state between tests.

## 4. Test responsive and preference variants independently

At desktop, tablet, and mobile, re-run transport discovery instead of assuming the same element merely resizes. The source may:

- swap video codecs, files, posters, crops, or object positions;
- hide a desktop video and render a mobile-specific still image;
- play only the visible item in a horizontal rail;
- change autoplay to tap-to-play on coarse pointers;
- reduce particle counts or replace canvas/WebGL;
- disable parallax or all nonessential motion under `prefers-reduced-motion`.

Emulate reduced motion and record what the source actually does. The implementation should match that observed behavior. If the source has no reduced-motion treatment, the clone must still avoid inaccessible essential motion and document the smallest safe deviation.

## 5. Acquire and verify permitted assets

When permission allows copying:

- download the original browser-selected media and its declared codec fallbacks, poster, and auxiliary animation files to the project's normal asset directory;
- preserve query-version information in the manifest even if the local filename is normalized;
- inspect media metadata with an available tool such as `ffprobe`: codec, pixel format, dimensions, duration, frame rate, bitrate, audio tracks, alpha, color space, and file size;
- verify each local source decodes in the target browser and that source ordering selects the intended codec;
- never hotlink the final implementation.

Use the original transferable asset when fidelity requires it. Do not rebuild an ordinary video as CSS or canvas. Do not turn animated editable interface text into raster media.

If the user permits adaptation rather than a strict clone, a behaviorally equivalent replacement may be acceptable only when its transport, timeline, crop, responsive strategy, and matched-time visual comparisons are documented. It remains a blocking deviation for a faithful clone unless the user explicitly accepts it.

## 6. Implement the observed behavior

For video, reproduce the source's markup and behavior: source order and codec declarations, poster, autoplay/mute/loop/plays-inline/preload policy, dimensions/aspect ratio, object fit/position, crop container, overlay stack, visibility rules, and breakpoint fallback. Preserve controls only when the source exposes them.

For code-native motion, reproduce the measured timing and state machine rather than approximating it with a perpetual decorative loop. Use transform and opacity where the source does, keep layout-affecting animation intentional, and clean up observers, event listeners, RAF loops, and renderer resources.

Honor reduced motion. Avoid downloading or decoding expensive hidden media when the source uses a static responsive fallback. Do not autoplay sound.

## 7. Blocking motion QA

For every dominant region, create source and implementation evidence at identical viewport, crop, state, and timeline position. Produce a contact sheet or side-by-side artifact containing at least the five sampled frames.

Verify:

- the expected local source and codec loaded with no 404, decode error, CORS failure, or unintended remote request;
- natural autoplay begins when expected and `currentTime` advances near wall-clock rate;
- duration, playback rate, sequence order, and loop behavior match;
- the first frame/poster transition does not flash, jump, or expose an empty background;
- crop, focal point, overlay opacity, masks, filters, and text alignment remain correct throughout the timeline;
- visibility and interaction triggers play, pause, reset, or preserve progress like the source;
- desktop, tablet, mobile, orientation, and reduced-motion variants match;
- `getVideoPlaybackQuality()` or equivalent diagnostics show no material dropped-frame problem during the QA run;
- media requests complete successfully and runtime exceptions remain empty.

Classify a missing dominant region, static substitute, wrong responsive variant, broken autoplay, persistent poster flash, materially wrong timing/crop, or untestable timeline as P1. Do not set `final result: passed` until it is fixed or the user explicitly narrows the fidelity requirement.

## 8. Why first-viewport screenshots are insufficient

A polished animated hero can look convincing in one frame while being fundamentally wrong: the implementation may use the wrong codec, a poster instead of playback, an uncontrolled CSS approximation, a different crop halfway through the loop, no mobile replacement, or motion that ignores reduced preferences. Static visual QA still applies, but it cannot close motion QA.
