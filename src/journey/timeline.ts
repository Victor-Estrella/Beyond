import gsap from "gsap";
import { SCENE_COUNT, type Point } from "./scenes";
import { BASE_ZOOM, type CameraState, type JourneyState } from "./state";

/**
 * The whole journey as one timeline, 10 units long. ScrollTrigger maps the
 * scroll position onto it, so nothing here ever plays by itself.
 *
 *   0 ─ title ─ 1.05 ═ 1.85 ─ 2.75 ═ 3.45 ─ 4.35 ═ 5.15 ─ 6.05 ═ 6.95 ─ 7.85 ═ 8.65 ─ 9.15 ─ finale ─ 9.8 ─ 10
 *       The Void      Entering       Through       Distortion     Reveal        Event Horizon
 *
 *   ═ marks a transition between two scenes.
 */
export const DURATION = 10;

/** Start and end of each transition. */
const TRANSITIONS: ReadonlyArray<readonly [number, number]> = [
  [1.05, 1.85],
  [2.75, 3.45],
  [4.35, 5.15],
  [6.05, 6.95],
  [7.85, 8.65],
];

/**
 * The last push towards the horizon. It ends a little before the timeline does, so the
 * closing frame is reached even if a mobile browser's toolbar shortens the scrollable distance.
 */
const FINALE: readonly [number, number] = [9.15, 9.8];

/** When each scene's line appears and is gone again (the title scene has none). */
const COPY: ReadonlyArray<readonly [number, number] | null> = [
  null,
  [1.72, 2.85],
  [3.32, 4.45],
  [5.02, 6.15],
  [6.84, 7.95],
  [8.55, 9.32],
];

/** A good place to stop in each scene, as scroll progress (0–1). Used by the navigation. */
export const sceneStops = [0, 2.2, 3.8, 5.5, 7.3, 9.0].map((time) => time / DURATION);

interface CameraPlan {
  /** Zoom reached by the time the scene has fully arrived. */
  arrive: number;
  /** Zoom reached while the scene is held, just before it leaves. */
  hold: number;
  /** Zoom at the moment the scene is gone. */
  leave: number;
  /** While leaving, bring the focus this far towards the centre of the screen. */
  center?: number;
  /** While leaving, steer towards this point instead. */
  steer?: Point;
}

/**
 * The camera flies deep into every scene before the next one takes over: the
 * foreground sweeps past the lens while the next picture grows out of the dark.
 */
export const cameraPlans: CameraPlan[] = [
  { arrive: BASE_ZOOM, hold: 1.18, leave: 3.1, center: 0.5, steer: [0.7, 0.28] },
  { arrive: 1.2, hold: 1.32, leave: 3.0 },
  { arrive: 1.2, hold: 1.32, leave: 3.0 },
  { arrive: 1.2, hold: 1.34, leave: 3.2, center: 0.85, steer: [0.775, 0.365] },
  { arrive: 1.22, hold: 1.36, leave: 3.6, center: 1 },
  { arrive: 1.26, hold: 1.36, leave: 1.9, center: 1, steer: [0.77, 0.3] },
];
const CAMERAS = cameraPlans;

/** Peak motion blur in the middle of each transition; the last one is the plunge. */
const BLUR_PEAKS = [0.07, 0.05, 0.055, 0.09, 0.18];

// Eases that hand over to (or take over from) a steady drift without a visible change of speed.
// `slope` is the speed at the joining end, relative to the tween's average speed.
const easeOutTo = (slope: number) => (t: number) => (1 - slope) * (1 - Math.pow(1 - t, 3)) + slope * t;
const easeInFrom = (slope: number) => (t: number) => (1 - slope) * Math.pow(t, 3) + slope * t;

type Key = readonly [time: number, value: number, ease?: string];
type EffectName = Exclude<keyof JourneyState, "cameras" | "mix">;

/** Animates one value of the state through a list of keyframes. */
function keyframes(tl: gsap.core.Timeline, state: JourneyState, name: EffectName, keys: Key[]) {
  state[name] = keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [fromTime, fromValue] = keys[i - 1];
    const [toTime, toValue, ease] = keys[i];
    if (fromValue === toValue) continue;
    tl.fromTo(
      state,
      { [name]: fromValue },
      { [name]: toValue, duration: toTime - fromTime, ease: ease ?? "sine.inOut", immediateRender: false },
      fromTime,
    );
  }
}

function planCamera(tl: gsap.core.Timeline, camera: CameraState, index: number) {
  const plan = CAMERAS[index];
  const arrival = index > 0 ? TRANSITIONS[index - 1] : null;
  const departure = index < SCENE_COUNT - 1 ? TRANSITIONS[index] : FINALE;
  const holdStart = arrival ? arrival[1] : 0;
  const holdEnd = departure[0];
  const holdSpeed = (plan.hold - plan.arrive) / (holdEnd - holdStart);

  if (arrival) {
    const duration = arrival[1] - arrival[0];
    const slope = Math.min(1, (holdSpeed * duration) / (plan.arrive - BASE_ZOOM));
    tl.fromTo(
      camera,
      { zoom: BASE_ZOOM },
      { zoom: plan.arrive, duration, ease: easeOutTo(slope), immediateRender: false },
      arrival[0],
    );
  }

  tl.fromTo(
    camera,
    { zoom: plan.arrive },
    { zoom: plan.hold, duration: holdEnd - holdStart, ease: "none", immediateRender: false },
    holdStart,
  );

  const duration = departure[1] - departure[0];
  const last = index === SCENE_COUNT - 1;
  const slope = Math.min(1, (holdSpeed * duration) / (plan.leave - plan.hold));
  tl.fromTo(
    camera,
    { zoom: plan.hold },
    // The final approach speeds up and then comes to rest; every other exit keeps accelerating.
    { zoom: plan.leave, duration, ease: last ? "power2.inOut" : easeInFrom(slope), immediateRender: false },
    departure[0],
  );

  if (plan.center !== undefined || plan.steer) {
    tl.to(
      camera,
      {
        center: plan.center ?? 0,
        fx: plan.steer ? plan.steer[0] : camera.fx,
        fy: plan.steer ? plan.steer[1] : camera.fy,
        duration,
        ease: "power2.inOut",
      },
      departure[0],
    );
  }
}

function planPicture(tl: gsap.core.Timeline, state: JourneyState, calm: boolean) {
  // Scene-to-scene mixes.
  TRANSITIONS.forEach(([start, end], index) => {
    const target = {
      get value() {
        return state.mix[index];
      },
      set value(v: number) {
        state.mix[index] = v;
      },
    };
    tl.fromTo(
      target,
      { value: 0 },
      { value: 1, duration: end - start, ease: "sine.inOut", immediateRender: false },
      start,
    );
  });

  // Light. Out of the dark at the start; a flare as the black hole is revealed; dimming at the end.
  keyframes(tl, state, "exposure", [
    [0, 0.2],
    [0.95, 1, "power1.out"],
    [6.1, 1],
    [6.5, calm ? 1 : 1.18, "power2.in"],
    [7.0, 1, "power2.out"],
    [FINALE[0], 1],
    [FINALE[1], 0.74],
  ]);
  keyframes(tl, state, "vignette", [
    [0, 0.7],
    [1.85, 0.45],
    [5.15, 0.4],
    [8.65, 0.5],
    [FINALE[0], 0.5],
    [FINALE[1], 0.9],
  ]);
  keyframes(tl, state, "warmth", [
    [4.35, 0],
    [5.15, 0.18],
    [6.95, 0.3],
    [8.65, 0.4],
  ]);
  keyframes(tl, state, "ember", [
    [4.35, 0],
    [5.15, 0.45],
    [6.95, 0.8],
    [8.65, 1],
  ]);
  keyframes(tl, state, "stars", [
    [0, 1],
    [1.85, 0.8],
    [5.15, 0.55],
    [8.65, 0.3],
  ]);
  // The void is sparse and quiet; the nebula fills with matter; the hole keeps most of it.
  keyframes(tl, state, "density", [
    [0, 0.25],
    [1.05, 0.35],
    [1.85, 0.7],
    [3.45, 1],
    [5.15, 0.9],
    [6.95, 0.8],
    [8.65, 0.9],
  ]);
  // Procedural gas: faint in the void, thickest through the nebula, warm embers near the hole.
  keyframes(tl, state, "haze", [
    [0, 0.12],
    [1.05, 0.25],
    [1.85, 0.6],
    [2.75, 0.75],
    [3.45, 0.9],
    [5.15, 0.6],
    [6.95, 0.55],
    [8.65, 0.5],
    [FINALE[1], 0.3],
  ]);

  if (calm) {
    for (const name of ["blur", "lens", "swirl", "aberration", "glow", "flow", "orbit", "pull"] as const) state[name] = 0;
    return;
  }

  state.cameras.forEach((camera, index) => planCamera(tl, camera, index));

  // Motion blur swells in the middle of each transition. After the plunge it
  // lingers a little, so the arrival at the horizon visibly decelerates.
  const blur: Key[] = [[0, 0]];
  TRANSITIONS.forEach(([start, end], index) => {
    const lastOne = index === TRANSITIONS.length - 1;
    blur.push([start, 0]);
    blur.push([start + (end - start) * (lastOne ? 0.5 : 0.55), BLUR_PEAKS[index], "power2.in"]);
    blur.push([end + (lastOne ? 0.3 : 0.05), 0, "power2.out"]);
  });
  keyframes(tl, state, "blur", blur);

  // Gravity makes itself felt before the black hole is seen, and never lets go.
  keyframes(tl, state, "lens", [
    [3.6, 0],
    [4.35, 0.3],
    [5.15, 0.6],
    [6.95, 0.7],
    [8.65, 0.9],
    [FINALE[1], 1],
  ]);
  // The disc rotates while a scene is held and rests during transitions.
  keyframes(tl, state, "swirl", [
    [5.15, 0],
    [5.5, 0.7],
    [5.95, 0.7],
    [6.15, 0],
    [6.95, 0],
    [7.25, 1],
    [7.75, 1],
    [7.95, 0],
    [8.75, 0],
    [9.05, 1],
  ]);
  keyframes(tl, state, "aberration", [
    [4.0, 0],
    [5.15, 0.004],
    [6.5, 0.011],
    [6.95, 0.005],
    [8.25, 0.018],
    [8.95, 0.006],
    [FINALE[1], 0.009],
  ]);
  keyframes(tl, state, "glow", [
    [5.15, 0],
    [5.6, 0.6],
    [6.95, 1],
  ]);
  keyframes(tl, state, "flow", [
    [0, 0.35],
    [1.85, 1],
    [5.15, 0.8],
    [6.95, 0.5],
    [8.65, 0.35],
  ]);
  keyframes(tl, state, "orbit", [
    [5.15, 0],
    [6.95, 0.6],
    [8.65, 1],
  ]);
  keyframes(tl, state, "pull", [
    [5.15, 0],
    [6.95, 0.35],
    [8.65, 0.9],
    [FINALE[1], 1],
  ]);
}

interface TextOptions {
  calm: boolean;
  blur: boolean;
}

function planText(tl: gsap.core.Timeline, root: HTMLElement, { calm, blur }: TextOptions) {
  const q = gsap.utils.selector(root);
  const soft = (px: number) => (blur && !calm ? { filter: `blur(${px}px)` } : {});
  const sharp = blur && !calm ? { filter: "blur(0px)" } : {};

  // Opening title: the camera flies through it.
  tl.to(q("[data-hint]"), { opacity: 0, duration: 0.14, ease: "none" }, 0.02);
  tl.to(q("[data-subtitle]"), { opacity: 0, y: calm ? 0 : -14, duration: 0.3, ease: "power1.in" }, 0.2);
  const titleChars = q("[data-title] [data-char]");
  titleChars.forEach((char, index) => {
    const offset = index - (titleChars.length - 1) / 2;
    tl.fromTo(
      char,
      { xPercent: 0, opacity: 1, ...sharp },
      {
        xPercent: calm ? 0 : offset * 60,
        opacity: 0,
        ...soft(16),
        duration: 0.55,
        ease: "power2.in",
        immediateRender: false,
      },
      0.34 + Math.abs(offset) * 0.025,
    );
  });
  if (!calm) {
    tl.fromTo(
      q("[data-title]"),
      { scale: 1 },
      { scale: 1.22, duration: 0.95, ease: "power1.in", immediateRender: false },
      0.08,
    );
  }
  tl.fromTo(q("[data-wordmark]"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3, ease: "none" }, 0.95);

  // One line per scene: letters settle into focus, then the block drifts past the camera.
  COPY.forEach((window, index) => {
    if (!window) return;
    const [start, end] = window;
    const block = q(`[data-copy="${index}"]`);
    tl.fromTo(block, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.02, ease: "none" }, start);
    tl.fromTo(
      q(`[data-copy="${index}"] [data-eyebrow]`),
      { opacity: 0, x: calm ? 0 : -18 },
      { opacity: 1, x: 0, duration: 0.24, ease: "power2.out" },
      start,
    );
    tl.fromTo(
      q(`[data-copy="${index}"] [data-char]`),
      { opacity: 0, yPercent: calm ? 0 : 38, ...soft(10) },
      { opacity: 1, yPercent: 0, ...sharp, duration: 0.2, ease: "power2.out", stagger: { amount: 0.26 } },
      start + 0.05,
    );
    tl.fromTo(
      q(`[data-copy="${index}"] [data-copy-inner]`),
      { opacity: 1, scale: 1, ...sharp },
      {
        opacity: 0,
        scale: calm ? 1 : 1.07,
        ...soft(10),
        duration: 0.3,
        ease: "power1.in",
        immediateRender: false,
      },
      end - 0.3,
    );
    tl.set(block, { autoAlpha: 0 }, end);
  });

  // Closing words.
  tl.to(q("[data-hud]"), { autoAlpha: 0, duration: 0.25, ease: "none" }, 9.22);
  tl.fromTo(q("[data-finale]"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.02, ease: "none" }, 9.36);
  tl.fromTo(
    q("[data-finale] [data-char]"),
    { opacity: 0, yPercent: calm ? 0 : 30, ...soft(12) },
    { opacity: 1, yPercent: 0, ...sharp, duration: 0.22, ease: "power2.out", stagger: { amount: 0.2 } },
    9.38,
  );
  tl.fromTo(
    q("[data-finale-extra]"),
    { autoAlpha: 0 },
    { autoAlpha: 1, duration: 0.14, ease: "none" },
    9.68,
  );
}

export interface TimelineOptions {
  state: JourneyState;
  root: HTMLElement;
  /** Reduced motion: no camera movement or distortion, plain fades only. */
  calm: boolean;
  /** Whether text may be blurred while it moves (costly on weaker devices). */
  textBlur: boolean;
}

export function buildTimeline({ state, root, calm, textBlur }: TimelineOptions): gsap.core.Timeline {
  const tl = gsap.timeline({ paused: true, defaults: { overwrite: false } });
  planPicture(tl, state, calm);
  planText(tl, root, { calm, blur: textBlur });
  // Pads the timeline to its full length so the last frame is held for a moment.
  tl.set({}, {}, DURATION);
  return tl;
}
