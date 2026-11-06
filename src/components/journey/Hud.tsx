import type { CSSProperties, Ref } from "react";
import { project, scenes } from "@/journey/scenes";
import { sceneStops } from "@/journey/timeline";
import styles from "./Hud.module.css";

interface HudProps {
  /** Index of the scene currently on screen. */
  scene: number;
  /** Receives the element whose vertical scale shows scroll progress. */
  progressRef: Ref<HTMLSpanElement>;
  onNavigate(index: number): void;
}

/**
 * The only interface the journey has: a wordmark, the name of the current
 * scene, and a thin rail showing how far you have travelled.
 */
export function Hud({ scene, progressRef, onNavigate }: HudProps) {
  const current = scenes[scene];

  return (
    <div className={styles.hud} data-hud>
      <p className={styles.wordmark} data-wordmark aria-hidden="true">
        {project.name}
      </p>

      <p className={styles.label} aria-live="polite">
        {/* Re-keyed so each new scene name animates in. */}
        <span key={current.id} className={styles.labelText}>
          <span className={styles.labelNumber}>{current.number}</span>
          <span className={styles.labelTotal}>/ {scenes[scenes.length - 1].number}</span>
          <span className={styles.labelTitle}>{current.title}</span>
        </span>
      </p>

      <nav className={styles.rail} aria-label="Scenes">
        <span className={styles.railTrack} aria-hidden="true">
          <span className={styles.railFill} ref={progressRef} />
        </span>
        {scenes.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className={styles.stop}
            style={{ "--at": sceneStops[index] } as CSSProperties}
            aria-label={`${item.number} — ${item.title}`}
            aria-current={index === scene ? "step" : undefined}
            onClick={() => onNavigate(index)}
          >
            <span className={styles.stopDot} />
            <span className={styles.stopName} aria-hidden="true">
              {item.title}
            </span>
          </button>
        ))}
      </nav>
    </div>
  );
}
