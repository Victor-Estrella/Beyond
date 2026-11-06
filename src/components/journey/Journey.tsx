"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { startJourney, type JourneyHandle } from "@/journey/controller";
import { scenes } from "@/journey/scenes";
import { Finale } from "./Finale";
import { Hud } from "./Hud";
import { Opening } from "./Opening";
import { Preloader } from "./Preloader";
import { SceneCopy } from "./SceneCopy";
import styles from "./Journey.module.css";

/**
 * The experience: a tall track to scroll through, and a stage pinned to the
 * screen for its whole length. This component only lays out the pieces and
 * relays a few events; the journey itself is run by `startJourney`.
 */
export default function Journey() {
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const journeyRef = useRef<JourneyHandle | null>(null);

  const calm = useReducedMotion();
  const [loadProgress, setLoadProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [scene, setScene] = useState(0);

  // Every visit starts in the void, even after a reload half-way through.
  useEffect(() => {
    history.scrollRestoration = "manual";
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    const canvas = canvasRef.current;
    const fallback = fallbackRef.current;
    if (!track || !canvas || !fallback) return;

    // Offline rendering (scripts/render-video.mjs) opens the page with `?render`. Read
    // synchronously: the WebGL context must be created with the right attributes the first time.
    const render = new URLSearchParams(window.location.search).has("render");
    const journey = startJourney({
      track,
      canvas,
      fallback,
      progressBar: progressRef.current,
      calm,
      render,
      onLoadProgress: (progress) => setLoadProgress((previous) => Math.max(previous, progress)),
      onReady: () => setReady(true),
      onScene: setScene,
    });
    journeyRef.current = journey;

    return () => {
      journey.dispose();
      journeyRef.current = null;
    };
  }, [calm]);

  const goToScene = useCallback((index: number) => journeyRef.current?.goToScene(index), []);
  const restart = useCallback(() => journeyRef.current?.goToScene(0), []);

  return (
    <div ref={trackRef} className={styles.track} data-ready={ready}>
      <div className={styles.stage}>
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
        <div ref={fallbackRef} className={styles.fallback} aria-hidden="true" hidden />

        <Opening />
        {scenes.map((item, index) =>
          item.line ? <SceneCopy key={item.id} scene={item} index={index} /> : null,
        )}
        <Finale onRestart={restart} />

        <Hud scene={scene} progressRef={progressRef} onNavigate={goToScene} />
        <Preloader progress={loadProgress} done={ready} />
      </div>
    </div>
  );
}
