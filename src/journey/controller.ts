import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { detectQuality, renderQuality, type Quality } from "./quality";
import { DomStage } from "./renderer/DomStage";
import type { Stage } from "./renderer/types";
import { WebGLStage } from "./renderer/WebGLStage";
import { SCENE_COUNT } from "./scenes";
import { createJourneyState, currentScene, type Frame, type JourneyState } from "./state";
import { buildTimeline, DURATION, sceneStops } from "./timeline";

export interface JourneyOptions {
  /** The tall element whose scroll range drives the journey. */
  track: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Container for the non-WebGL fallback pictures. */
  fallback: HTMLElement;
  /** Element whose vertical scale shows scroll progress. */
  progressBar: HTMLElement | null;
  /** Reduced motion. */
  calm: boolean;
  /**
   * Offline rendering: no scrolling, no clock. Frames are requested one by one
   * through `window.beyond.renderFrame(progress, time)` (see scripts/render-video.mjs).
   */
  render: boolean;
  onLoadProgress(progress: number): void;
  onReady(): void;
  onScene(index: number): void;
}

export interface JourneyHandle {
  /** Travels to a scene (or back to the start with 0). */
  goToScene(index: number): void;
  dispose(): void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What the render script talks to. */
export interface RenderBridge {
  ready: boolean;
  /** Length of the journey in timeline units, for information. */
  duration: number;
  sceneStops: number[];
  /** Draws one frame: `progress` 0–1 along the journey, `time` in seconds for the ambient motion. */
  renderFrame(progress: number, time: number): Promise<void>;
}

declare global {
  interface Window {
    beyond?: RenderBridge;
  }
}

function createStage(canvas: HTMLCanvasElement, fallback: HTMLElement, quality: Quality, render: boolean): Stage {
  const gl = WebGLStage.context(canvas, render);
  if (gl) {
    try {
      return new WebGLStage(canvas, gl, quality, render);
    } catch (error) {
      console.warn("[beyond] WebGL stage unavailable, using the simplified one.", error);
    }
  }
  canvas.hidden = true;
  return new DomStage(fallback);
}

/**
 * Wires everything together: scroll position → timeline → state → stage.
 * Returns a handle to navigate and to tear it all down again.
 */
export function startJourney(options: JourneyOptions): JourneyHandle {
  const { track, canvas, fallback, progressBar, calm, render } = options;
  gsap.registerPlugin(ScrollTrigger);

  const quality = render ? renderQuality : detectQuality();
  const state = createJourneyState();
  const stage = createStage(canvas, fallback, quality, render);
  if (render) return startRendering(options, state, stage, quality);
  const intro = { value: 0 };
  const frame: Frame = {
    state,
    time: 0,
    delta: 0,
    pointerX: 0,
    pointerY: 0,
    pointerActive: false,
    velocity: 0,
    intro: 0,
    calm,
  };

  let disposed = false;
  let timeline!: gsap.core.Timeline;
  let trigger!: ScrollTrigger;

  const context = gsap.context(() => {
    timeline = buildTimeline({ state, root: track, calm, textBlur: quality.textBlur });
    trigger = ScrollTrigger.create({
      trigger: track,
      start: "top top",
      end: "bottom bottom",
      // The scrub delay gives the camera weight: it eases after the scroll instead of snapping to it.
      scrub: calm ? 0.15 : 1,
      animation: timeline,
    });
  }, track);

  // Loading: the first scene must be ready before the curtain lifts; the second follows right behind.
  options.onLoadProgress(0.12);
  const fontsReady = Promise.race([document.fonts?.ready ?? Promise.resolve(), wait(2500)]);
  const firstScene = stage.load(0).then(() => {
    if (!disposed) options.onLoadProgress(0.75);
  });
  void stage.load(1);
  let introTween: gsap.core.Tween | null = null;
  void Promise.all([firstScene, fontsReady]).then(() => {
    if (disposed) return;
    options.onLoadProgress(1);
    options.onReady();
    introTween = gsap.to(intro, { value: 1, duration: calm ? 0.8 : 2.8, delay: 0.35, ease: "power2.out" });
  });

  // Pointer: the camera leans a little towards it. Mouse only — touch has no hover position.
  let pointerTargetX = 0;
  let pointerTargetY = 0;
  const onPointerMove = (event: PointerEvent) => {
    if (calm || event.pointerType !== "mouse") return;
    frame.pointerActive = true;
    pointerTargetX = (event.clientX / window.innerWidth) * 2 - 1;
    pointerTargetY = (event.clientY / window.innerHeight) * 2 - 1;
  };
  window.addEventListener("pointermove", onPointerMove, { passive: true });

  let dirty = true;
  const resizeObserver = new ResizeObserver(() => {
    stage.resize();
    dirty = true;
  });
  resizeObserver.observe(canvas.parentElement ?? canvas);

  let startedAt = -1;
  let lastProgress = 0;
  let lastIntro = -1;
  let velocity = 0;
  let scene = -1;
  let sinceRetry = 0;

  const preloadAround = (index: number) => {
    // The scene on screen, the one after it, and one more so it is ready when its turn comes.
    void stage.load(index);
    void stage.load(index + 1);
    void stage.load(index + 2);
    void stage.load(index - 1);
  };

  const tick = (time: number, deltaMs: number) => {
    if (disposed) return;
    if (startedAt < 0) startedAt = time;
    const delta = Math.min(deltaMs / 1000, 0.1);
    const progress = timeline.progress();

    const rawVelocity = delta > 0 ? (progress - lastProgress) / delta : 0;
    velocity += (rawVelocity - velocity) * (1 - Math.exp(-delta * 8));

    const follow = 1 - Math.exp(-delta * 3.5);
    frame.pointerX += (pointerTargetX - frame.pointerX) * follow;
    frame.pointerY += (pointerTargetY - frame.pointerY) * follow;
    frame.time = calm ? 0 : time - startedAt;
    frame.delta = delta;
    frame.velocity = calm ? 0 : velocity;
    frame.intro = intro.value;

    const current = currentScene(state);
    sinceRetry += delta;
    if (current !== scene) {
      scene = current;
      options.onScene(current);
      preloadAround(current);
    } else if (sinceRetry > 2) {
      // Covers a picture that failed to load the first time (for example, a dropped connection).
      sinceRetry = 0;
      preloadAround(current);
    }

    if (progressBar && progress !== lastProgress) {
      progressBar.style.transform = `scaleY(${progress.toFixed(4)})`;
    }

    // With reduced motion nothing moves by itself, so only draw when something changed.
    const changed = dirty || progress !== lastProgress || intro.value !== lastIntro || stage.isBusy();
    lastProgress = progress;
    lastIntro = intro.value;
    dirty = false;
    if (calm && !changed) return;

    stage.render(frame);
  };
  gsap.ticker.add(tick);

  // Programmatic travel: scroll at a pace that lets the journey be seen, and let go the moment the user scrolls.
  let travel: gsap.core.Tween | null = null;
  const cancelTravel = () => {
    travel?.kill();
    travel = null;
  };
  window.addEventListener("wheel", cancelTravel, { passive: true });
  window.addEventListener("touchstart", cancelTravel, { passive: true });
  window.addEventListener("keydown", cancelTravel);

  return {
    goToScene(index: number) {
      const stop = sceneStops[Math.max(0, Math.min(sceneStops.length - 1, index))];
      const target = trigger.start + (trigger.end - trigger.start) * stop;
      cancelTravel();
      if (calm) {
        window.scrollTo(0, target);
        return;
      }
      const position = { y: window.scrollY };
      const screens = Math.abs(target - position.y) / window.innerHeight;
      travel = gsap.to(position, {
        y: target,
        duration: Math.min(4.5, Math.max(1.2, screens * 0.55)),
        ease: "power2.inOut",
        onUpdate: () => window.scrollTo(0, position.y),
        onComplete: () => {
          travel = null;
        },
      });
    },

    dispose() {
      disposed = true;
      cancelTravel();
      introTween?.kill();
      gsap.ticker.remove(tick);
      resizeObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("wheel", cancelTravel);
      window.removeEventListener("touchstart", cancelTravel);
      window.removeEventListener("keydown", cancelTravel);
      context.revert();
      stage.dispose();
      canvas.hidden = false;
    },
  };
}

/**
 * The offline variant: every picture is loaded up front, the timeline is driven
 * by `renderFrame` instead of the scroll position, and nothing moves by itself
 * between frames, so a frame depends only on (progress, time).
 */
function startRendering(options: JourneyOptions, state: JourneyState, stage: Stage, quality: Quality): JourneyHandle {
  const { track, canvas, calm } = options;
  let disposed = false;
  let timeline!: gsap.core.Timeline;
  const context = gsap.context(() => {
    timeline = buildTimeline({ state, root: track, calm, textBlur: quality.textBlur });
  }, track);

  const frame: Frame = {
    state,
    time: 0,
    delta: 0,
    pointerX: 0,
    pointerY: 0,
    pointerActive: false,
    velocity: 0,
    intro: 1,
    calm,
  };
  let lastTime = 0;
  let lastScene = 0;
  const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const bridge: RenderBridge = {
    ready: false,
    duration: DURATION,
    sceneStops,
    async renderFrame(progress, time) {
      if (disposed) return;
      timeline.progress(Math.min(1, Math.max(0, progress)), false);
      const scene = currentScene(state);
      if (scene !== lastScene) {
        lastScene = scene;
        options.onScene(scene);
      }
      frame.time = calm ? 0 : time;
      frame.delta = Math.max(0, time - lastTime);
      lastTime = time;
      stage.resize();
      stage.render(frame);
      // Lets the browser composite the canvas and the text before a screenshot is taken.
      await nextPaint();
      await nextPaint();
    },
  };
  window.beyond = bridge;
  track.dataset.render = "true";

  options.onLoadProgress(0.1);
  void Promise.all([
    ...Array.from({ length: SCENE_COUNT }, (_, index) => stage.load(index)),
    Promise.race([document.fonts?.ready ?? Promise.resolve(), wait(4000)]),
  ]).then(async () => {
    if (disposed) return;
    // Depth maps load alongside the pictures; give them a moment, then skip every fade-in.
    await wait(500);
    stage.settle();
    timeline.progress(0, false);
    stage.render(frame);
    await nextPaint();
    options.onLoadProgress(1);
    options.onReady();
    options.onScene(0);
    bridge.ready = true;
  });

  return {
    goToScene() {},
    dispose() {
      disposed = true;
      if (window.beyond === bridge) delete window.beyond;
      delete track.dataset.render;
      context.revert();
      stage.dispose();
      canvas.hidden = false;
    },
  };
}
