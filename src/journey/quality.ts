export type QualityTier = "high" | "medium" | "low";

export interface Quality {
  tier: QualityTier;
  /** Upper bound for the canvas pixel ratio. */
  maxPixelRatio: number;
  /** Upper bound for the number of pixels drawn per frame. */
  maxPixels: number;
  /** Samples used for motion blur. */
  blurTaps: number;
  /** Number of particles drawn. */
  particles: number;
  /** Depth-aware parallax inside each picture. */
  depth: boolean;
  /** Drifting clouds and the rotating accretion disc. */
  fluid: boolean;
  /** Blur on text while it enters and leaves. */
  textBlur: boolean;
  /** Which image variant to load. */
  images: "full" | "lite";
}

const presets: Record<QualityTier, Quality> = {
  high: {
    tier: "high",
    maxPixelRatio: 2,
    maxPixels: 2560 * 1440,
    blurTaps: 14,
    particles: 6000,
    depth: true,
    fluid: true,
    textBlur: true,
    images: "full",
  },
  medium: {
    tier: "medium",
    maxPixelRatio: 1.5,
    maxPixels: 1920 * 1080,
    blurTaps: 9,
    particles: 3200,
    depth: true,
    fluid: true,
    textBlur: false,
    images: "full",
  },
  low: {
    tier: "low",
    maxPixelRatio: 1,
    maxPixels: 1280 * 720,
    blurTaps: 5,
    particles: 1400,
    depth: false,
    fluid: false,
    textBlur: false,
    images: "lite",
  },
};

/** For offline rendering: everything on, no resolution cap, no adaptive downgrade. */
export const renderQuality: Quality = {
  tier: "high",
  maxPixelRatio: 4,
  maxPixels: 7680 * 4320,
  blurTaps: 24,
  particles: 6000,
  depth: true,
  fluid: true,
  textBlur: true,
  images: "full",
};

interface NavigatorHints {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
}

/** A first guess from what the browser tells us; the renderer refines it by measuring frames. */
export function detectQuality(): Quality {
  if (typeof window === "undefined") return presets.medium;

  const hints = navigator as Navigator & NavigatorHints;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = hints.deviceMemory ?? 8;
  const touch = window.matchMedia("(pointer: coarse)").matches;
  const saveData = hints.connection?.saveData === true;

  if (saveData || memory <= 2 || cores <= 2) return presets.low;
  if (touch) return cores >= 6 && memory >= 4 ? presets.medium : presets.low;
  return cores >= 8 && memory >= 8 ? presets.high : presets.medium;
}

export function lowerTier(quality: Quality): Quality | null {
  if (quality.tier === "high") return presets.medium;
  if (quality.tier === "medium") return presets.low;
  return null;
}
