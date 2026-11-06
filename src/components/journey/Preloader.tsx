import styles from "./Preloader.module.css";

interface PreloaderProps {
  /** 0–1. */
  progress: number;
  done: boolean;
}

/** A curtain of darkness with a single hairline, lifted once the first scene is ready. */
export function Preloader({ progress, done }: PreloaderProps) {
  const percent = Math.round(progress * 100);
  return (
    <div
      className={styles.preloader}
      data-done={done}
      role="progressbar"
      aria-label="Loading"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-hidden={done}
    >
      <span className={styles.bar}>
        <span className={styles.fill} style={{ transform: `scaleX(${progress})` }} />
      </span>
      <span className={styles.caption}>Entering the unknown</span>
    </div>
  );
}
