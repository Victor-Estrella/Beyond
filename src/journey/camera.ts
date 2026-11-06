import { IMAGE_ASPECT, type Point } from "./scenes";
import type { CameraState } from "./state";

/** The rectangle of a picture that is visible on screen, in 0–1 image units. */
export interface ViewWindow {
  cx: number;
  cy: number;
  /** Width and height of the visible region. */
  w: number;
  h: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Works out which part of a picture the camera sees.
 *
 * The picture always covers the screen with its proportions intact ("cover" fit):
 * it is only ever scaled uniformly and cropped, never stretched. Zooming keeps the
 * focus point pinned in place so the scene grows out of it, as it would when
 * travelling towards it.
 *
 * @param panX, panY  extra camera offset as a fraction of the visible region
 */
export function viewWindow(
  camera: CameraState,
  screenAspect: number,
  panX = 0,
  panY = 0,
  out: ViewWindow = { cx: 0.5, cy: 0.5, w: 1, h: 1 },
): ViewWindow {
  // Visible region at zoom 1.
  const coverW = screenAspect < IMAGE_ASPECT ? screenAspect / IMAGE_ASPECT : 1;
  const coverH = screenAspect < IMAGE_ASPECT ? 1 : IMAGE_ASPECT / screenAspect;

  const zoom = Math.max(1, camera.zoom);
  const w = coverW / zoom;
  const h = coverH / zoom;

  // Where the focus sits on screen when nothing is zoomed (0–1), optionally pulled to the centre.
  const restX = clamp(camera.fx, coverW / 2, 1 - coverW / 2);
  const restY = clamp(camera.fy, coverH / 2, 1 - coverH / 2);
  const anchorX = 0.5 + ((camera.fx - restX) / coverW) * (1 - camera.center);
  const anchorY = 0.5 + ((camera.fy - restY) / coverH) * (1 - camera.center);

  out.w = w;
  out.h = h;
  out.cx = clamp(camera.fx + (0.5 - anchorX + panX) * w, w / 2, 1 - w / 2);
  out.cy = clamp(camera.fy + (0.5 - anchorY + panY) * h, h / 2, 1 - h / 2);
  return out;
}

/**
 * The 3D camera's field of view, as tan(fov / 2). With the picture one unit
 * tall, a camera this far away sees exactly the window `viewWindow` describes:
 * distance = window.h / (2 · TAN_HALF_FOV).
 */
export const TAN_HALF_FOV = 0.52;

/** How far the camera stands from a picture's far plane to see a window of this height. */
export function cameraDistance(windowHeight: number): number {
  return windowHeight / (2 * TAN_HALF_FOV);
}

/** Where a point of the picture lands on screen (0–1 from the top-left; may fall outside). */
export function toScreen(point: Point, view: ViewWindow): [number, number] {
  return [0.5 + (point[0] - view.cx) / view.w, 0.5 + (point[1] - view.cy) / view.h];
}
