import type { Frame } from "../state";

/**
 * Something that can draw the journey. There are two: the WebGL stage, and a
 * plain-DOM stage for browsers where WebGL 2 is unavailable.
 */
export interface Stage {
  readonly kind: "webgl" | "dom";
  /** Starts loading a scene's picture if needed. Resolves once it can be drawn. */
  load(index: number): Promise<void>;
  /** Tells the stage its container changed size. */
  resize(): void;
  render(frame: Frame): void;
  /** True while the stage is animating on its own (for example, a picture fading in). */
  isBusy(): boolean;
  /** Skips any fade-ins in progress (offline rendering). */
  settle(): void;
  dispose(): void;
}
