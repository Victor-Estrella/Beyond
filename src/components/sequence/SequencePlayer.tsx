"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef, useState } from "react";
import styles from "./SequencePlayer.module.css";

interface SequenceManifest {
  count: number;
  width: number;
  height: number;
  /** URL pattern with `{index}`. */
  pattern: string;
  pad: number;
}

type Status = "loading" | "ready" | "missing";

const frameUrl = (manifest: SequenceManifest, index: number) =>
  manifest.pattern.replace("{index}", String(index).padStart(manifest.pad, "0"));

/**
 * Frames are fetched in an order that keeps every part of the journey covered
 * early: first and last, then the middle, then quarters, and so on. Whatever
 * the scroll position, a nearby frame is ready soon.
 */
function loadOrder(count: number): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  const push = (index: number) => {
    if (!seen.has(index)) {
      seen.add(index);
      order.push(index);
    }
  };
  push(0);
  push(count - 1);
  for (let step = count - 1; step >= 1; step = Math.floor(step / 2)) {
    for (let index = 0; index < count; index += step) push(index);
    if (step === 1) break;
  }
  for (let index = 0; index < count; index++) push(index);
  return order;
}

/**
 * Plays the rendered frame sequence under the scroll. Between two frames it
 * cross-fades, so the motion stays smooth even where frames are sparse.
 */
export function SequencePlayer() {
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [loaded, setLoaded] = useState(0);

  useEffect(() => {
    const track = trackRef.current;
    const canvas = canvasRef.current;
    if (!track || !canvas) return;

    let disposed = false;
    let manifest: SequenceManifest | null = null;
    const frames: (HTMLImageElement | null)[] = [];
    const playhead = { progress: 0 };
    let drawn = -1;

    const context = canvas.getContext("2d");
    if (!context) return;

    const draw = () => {
      if (!manifest || disposed) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssWidth = canvas.clientWidth;
      const cssHeight = canvas.clientHeight;
      const width = Math.round(cssWidth * dpr);
      const height = Math.round(cssHeight * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        drawn = -1;
      }

      const position = playhead.progress * (manifest.count - 1);
      const key = Math.round(position * 1000);
      if (key === drawn) return;
      drawn = key;

      // Nearest loaded frames on either side of the playhead.
      const below = Math.floor(position);
      const above = Math.min(manifest.count - 1, below + 1);
      let a = below;
      while (a >= 0 && !frames[a]) a--;
      let b = above;
      while (b < manifest.count && !frames[b]) b++;
      const imageA = a >= 0 ? frames[a] : null;
      const imageB = b < manifest.count ? frames[b] : null;
      if (!imageA && !imageB) return;

      // Cover-fit, like the live stage.
      const scale = Math.max(width / manifest.width, height / manifest.height);
      const drawWidth = manifest.width * scale;
      const drawHeight = manifest.height * scale;
      const x = (width - drawWidth) / 2;
      const y = (height - drawHeight) / 2;

      context.globalAlpha = 1;
      context.drawImage((imageA ?? imageB)!, x, y, drawWidth, drawHeight);
      if (imageA && imageB && a !== b) {
        context.globalAlpha = (position - a) / (b - a);
        context.drawImage(imageB, x, y, drawWidth, drawHeight);
        context.globalAlpha = 1;
      }
    };

    gsap.registerPlugin(ScrollTrigger);
    const trigger = ScrollTrigger.create({
      trigger: track,
      start: "top top",
      end: "bottom bottom",
      scrub: 0.6,
      animation: gsap.to(playhead, { progress: 1, ease: "none", paused: true }),
      onUpdate: () => draw(),
    });
    gsap.ticker.add(draw);
    const resize = new ResizeObserver(() => {
      drawn = -1;
      draw();
    });
    resize.observe(canvas);

    void (async () => {
      try {
        const response = await fetch("/sequence/manifest.json", { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        manifest = (await response.json()) as SequenceManifest;
      } catch {
        if (!disposed) setStatus("missing");
        return;
      }
      if (disposed) return;
      frames.length = manifest.count;
      frames.fill(null);

      let count = 0;
      const order = loadOrder(manifest.count);
      // A few downloads at a time keep the first frames arriving quickly.
      const workers = Array.from({ length: 4 }, async () => {
        while (order.length && !disposed) {
          const index = order.shift()!;
          const image = new Image();
          image.decoding = "async";
          image.src = frameUrl(manifest!, index);
          try {
            await image.decode();
            frames[index] = image;
            count++;
            drawn = -1;
            setLoaded(count);
            if (count === 1) setStatus("ready");
          } catch {
            // A missing frame is skipped; its neighbours fill in.
          }
        }
      });
      await Promise.all(workers);
    })();

    return () => {
      disposed = true;
      gsap.ticker.remove(draw);
      resize.disconnect();
      trigger.kill();
    };
  }, []);

  return (
    <div ref={trackRef} className={styles.track}>
      <div className={styles.stage}>
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
        {status === "missing" ? (
          <div className={styles.notice}>
            <p>No frame sequence has been rendered yet.</p>
            <p>
              Run <code>npm run build</code> and then <code>npm run video</code>.
            </p>
          </div>
        ) : (
          <p className={styles.caption} aria-live="polite">
            <span>Frame sequence</span>
            <span>{status === "loading" ? "Loading…" : `${loaded} frames`}</span>
          </p>
        )}
      </div>
    </div>
  );
}
