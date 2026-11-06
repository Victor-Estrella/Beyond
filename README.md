# BEYOND — A Journey Through the Unknown

A scroll-driven, cinematic journey through the cosmos: from the silence of the
void, through nebulae, to the event horizon of a black hole. The whole
experience is one pinned screen; scrolling moves the camera.

## Running it

```sh
npm install
npm run dev      # http://localhost:3000
npm run build && npm start
```

`npm run images` re-encodes the six source pictures in `assets/source/` into the
WebP variants served from `public/scenes/` (run it again if the sources change).
`npm run depth` estimates a depth map for each picture (Depth Anything V2, on the
CPU; the model is downloaded once).

### Video and frame sequence

```sh
npm run build
npm run video          # out/beyond.mp4 + public/sequence/ (options in the script header)
```

The script opens the production build in a headless Chrome with `?render`,
asks the page for one frame at a time (`window.beyond.renderFrame(progress,
time)`) and screenshots it — the real WebGL stage and the real text, no
re-implementation. ffmpeg encodes the frames to H.264 (`--webm` adds VP9), and
a lighter WebP sequence is written for `/sequence`, where the same journey plays
back frame by frame under the scroll with no live rendering. Defaults: 48 s,
30 fps, 1920×1080, 160 sequence frames at 1440 px. Every frame depends only on
its progress and time, so renders are deterministic.

## How it is built

Next.js (App Router) + React + GSAP ScrollTrigger + a small WebGL 2 renderer.

```
src/
  app/                      layout, page, global styles, icon
  components/journey/       React: layout and text (Opening, SceneCopy, Finale, Hud, Preloader)
  journey/
    scenes.ts               the six scenes: copy, focus points, transition recipes
    state.ts                everything the scroll position decides (cameras, mixes, effects)
    timeline.ts             the GSAP timeline: camera moves, effects and text, scene by scene
    camera.ts               cover-fit framing that zooms towards a focus point
    controller.ts           wires scroll → timeline → state → stage; loading; pointer
    quality.ts              device tiers and the image variant to load
    renderer/
      WebGLStage.ts         draws a frame: gas → relief meshes → post pass → particles
      shaders.ts            relief mesh, post (lens, blur, flow, grade), gas, particles
      textures.ts           on-demand picture loading with fade-in
      particles.ts          stateless star / dust / bokeh field (6000 points)
      DomStage.ts           <img> fallback when WebGL 2 is unavailable
  components/sequence/      the scroll-driven frame-sequence player (/sequence)
scripts/
  optimize-images.mjs       source PNG → WebP variants
  depth-maps.mjs            depth estimation
  render-video.mjs          frames → mp4 / webm / sequence
```

### Two layers of motion

Everything the scroll decides lives in the state and is written only by the
timeline. On top of it, a clock drives the ambient life of the scene — gas
drifting, the accretion disc turning, stars crossing and twinkling, dust
streaming, matter falling into the hole — so the universe keeps moving when the
scroll stops, and scrolling back never fights it. With reduced motion the clock
is frozen.

The timeline never plays by itself: ScrollTrigger scrubs it, so scrolling back
replays everything in reverse. Renderers only read the state; the timeline is
its only writer.

### Transitions

Each pixel of a transition has an "arrival time" mixed from three ingredients —
distance from the vanishing point, a cloud pattern, and the brightness of the
incoming picture — so the nebula seeps in organically while the black hole
sweeps across the frame as a lens wave. Recipes live in `scenes.ts`.

### A flight through reliefs

Each picture has an estimated depth map (`npm run depth`) and is drawn as a
relief: a 160 × 90 grid pushed towards the camera by that depth. One
perspective camera flies forward through all six, their far planes spaced along
the flight path so that leaving one at its final zoom puts the camera exactly
where the next one's arrival expects it. Near matter sweeps past the lens while
the distant light barely moves; as the camera gets close, the picture's far
regions dissolve (sky first, rocks last) and the next picture grows out of the
dark behind them. The timeline's 2D camera values (zoom, focus, centring) are
mapped onto this camera exactly, so framing on every screen size is unchanged.

The composed scene then goes through a post pass: gravitational bending, the
transition's refraction front, motion blur with chromatic fringes, gas drift
along a slow current (a flow map: two phase-shifted reads cross-faded, so it
never snaps back), the procedural nebula, the glow around the hole, and the
grade. Pictures are only ever scaled uniformly and cropped, never stretched;
on narrow screens the crop is centred on each scene's focus point.

### Ambient layers

- Procedural nebula: domain-warped noise rendered at a quarter of the screen,
  tinted from deep blue and violet to magenta, and to embers near the hole; it
  never enters the event horizon.
- Particle field: thousands of stars at a distance (a few slowly crossing the
  view, a few brighter), dust streaming past, bokeh up close. Density follows
  the narrative — sparse in the void, full through the nebula.
- Gravity: light and particles alike are bent around the hole (the same
  deflection in both shaders), magnified near the ring, swallowed inside it;
  matter orbits and spirals in with growing pull towards the horizon.

### Performance and accessibility

- Device tiers (`quality.ts`) set resolution, blur samples, particle count and
  which image variant to load; the stage also lowers resolution and then effects
  by itself when frames run slow.
- `prefers-reduced-motion`: no camera movement, distortion or drifting; scenes
  cross-fade plainly and text simply fades. The stage only redraws when
  something changed.
- Narrative text is real DOM with the plain text available to screen readers;
  the rail is keyboard-navigable.
