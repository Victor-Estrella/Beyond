import { SCENE_COUNT, scenes } from "./scenes";

/** Closest zoom a scene is ever shown at; the small margin leaves room for camera drift. */
export const BASE_ZOOM = 1.04;

export interface CameraState {
  /** 1 = the picture exactly covers the screen. */
  zoom: number;
  /** Point of the picture the camera pushes towards (0–1, from the top-left). */
  fx: number;
  fy: number;
  /** 0 = that point stays where it naturally sits on screen, 1 = it is brought to the centre. */
  center: number;
}

/**
 * Everything the scroll position decides. The GSAP timeline is the only writer;
 * renderers only read. Scrolling back simply plays the same values in reverse.
 */
export interface JourneyState {
  cameras: CameraState[];
  /** mix[i] is how far scene i+1 has taken over from scene i (0–1). */
  mix: number[];
  /** Overall brightness; the journey starts near black. */
  exposure: number;
  /** Radial motion blur, as a fraction of the distance to the vanishing point. */
  blur: number;
  /** Strength of the light bending around the gravity point. */
  lens: number;
  /** Slow rotation of whatever surrounds the gravity point. */
  swirl: number;
  /** Colour fringing. */
  aberration: number;
  /** Shift towards orange and gold. */
  warmth: number;
  vignette: number;
  /** Breathing of the light around the gravity point. */
  glow: number;
  /** Slow drifting of the clouds. */
  flow: number;
  /** Particle colour: 0 = cold blue and violet, 1 = embers. */
  ember: number;
  /** How strongly particles orbit the gravity point. */
  orbit: number;
  /** Visibility of the fine star layer. */
  stars: number;
  /** How much of the particle field has joined in (0–1). */
  density: number;
  /** Intensity of the procedural gas. */
  haze: number;
  /** How strongly matter falls into the black hole. */
  pull: number;
}

export function createJourneyState(): JourneyState {
  return {
    cameras: scenes.map((scene) => ({
      zoom: BASE_ZOOM,
      fx: scene.focus[0],
      fy: scene.focus[1],
      center: 0,
    })),
    mix: new Array(SCENE_COUNT - 1).fill(0),
    exposure: 0.1,
    blur: 0,
    lens: 0,
    swirl: 0,
    aberration: 0,
    warmth: 0,
    vignette: 0.6,
    glow: 0,
    flow: 0.4,
    ember: 0,
    orbit: 0,
    stars: 1,
    density: 0.25,
    haze: 0.12,
    pull: 0,
  };
}

/** The two scenes on screen right now and how far the second has taken over. */
export interface ActivePair {
  from: number;
  to: number;
  mix: number;
}

export function activePair(state: JourneyState): ActivePair {
  let from = 0;
  while (from < state.mix.length && state.mix[from] >= 1) from++;
  if (from >= state.mix.length) return { from, to: from, mix: 0 };
  return { from, to: from + 1, mix: Math.max(0, state.mix[from]) };
}

/** Index of the scene the viewer is "in" — the one covering most of the frame. */
export function currentScene(state: JourneyState): number {
  const { from, to, mix } = activePair(state);
  return mix > 0.5 ? to : from;
}

/**
 * Distance travelled so far, derived from how far every camera has pushed in.
 * Particles use it to fly past in step with the zoom — and to fly back on reverse scroll.
 */
export function travelDistance(state: JourneyState): number {
  let distance = 0;
  for (const camera of state.cameras) distance += Math.log(camera.zoom / BASE_ZOOM);
  return distance;
}

/** What a renderer needs to draw one frame. */
export interface Frame {
  state: JourneyState;
  /** Seconds since the experience started; frozen when motion is reduced. */
  time: number;
  /** Seconds since the previous frame. */
  delta: number;
  /** Smoothed pointer position, −1…1 on both axes (0 on touch devices). */
  pointerX: number;
  pointerY: number;
  /** Smoothed scroll speed in timeline-lengths per second (signed). */
  velocity: number;
  /** 0–1: the opening fade from black, played once after loading. */
  intro: number;
  /** Reduced motion: scenes cross-fade plainly and nothing moves on its own. */
  calm: boolean;
}
