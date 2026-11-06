import { SCENE_COUNT, scenes } from "../scenes";
import { activePair, type Frame } from "../state";
import type { Stage } from "./types";

/**
 * Fallback for browsers without WebGL 2: the same journey told with stacked
 * <img> elements — zoom and cross-fades only, no shader effects or particles.
 * It reads the same state as the WebGL stage, so timing and text stay identical.
 */
export class DomStage implements Stage {
  readonly kind = "dom" as const;

  private images: HTMLImageElement[] = [];
  private loading = new Map<number, Promise<void>>();

  constructor(private container: HTMLElement) {
    container.hidden = false;
    for (const scene of scenes) {
      const image = document.createElement("img");
      image.alt = "";
      image.decoding = "async";
      image.draggable = false;
      image.width = scene.full.width;
      image.height = scene.full.height;
      image.style.objectPosition = `${scene.focus[0] * 100}% ${scene.focus[1] * 100}%`;
      image.style.opacity = "0";
      container.appendChild(image);
      this.images.push(image);
    }
  }

  load(index: number): Promise<void> {
    if (index < 0 || index >= SCENE_COUNT) return Promise.resolve();
    let pending = this.loading.get(index);
    if (!pending) {
      const image = this.images[index];
      const scene = scenes[index];
      image.srcset = `${scene.lite.src} ${scene.lite.width}w, ${scene.full.src} ${scene.full.width}w`;
      image.sizes = "max(100vw, 178vh)";
      image.src = scene.full.src;
      pending = image.decode().catch(() => {
        this.loading.delete(index);
      });
      this.loading.set(index, pending);
    }
    return pending;
  }

  resize() {}

  isBusy() {
    return false;
  }

  settle() {}

  render(frame: Frame) {
    const { state } = frame;
    const { from, to, mix } = activePair(state);
    const eased = mix * mix * (3 - 2 * mix);
    const brightness = Math.min(1.3, state.exposure * frame.intro);

    this.images.forEach((image, index) => {
      const visible = index === from || (index === to && mix > 0);
      if (!visible) {
        if (image.style.opacity !== "0") image.style.opacity = "0";
        return;
      }
      const camera = state.cameras[index];
      image.style.opacity = index === to && to !== from ? eased.toFixed(3) : "1";
      image.style.zIndex = index === to ? "2" : "1";
      image.style.transformOrigin = `${camera.fx * 100}% ${camera.fy * 100}%`;
      image.style.transform = `scale(${Math.max(1, camera.zoom).toFixed(4)})`;
      image.style.filter = `brightness(${brightness.toFixed(3)})`;
    });
  }

  dispose() {
    this.container.replaceChildren();
    this.container.hidden = true;
    this.images = [];
    this.loading.clear();
  }
}
