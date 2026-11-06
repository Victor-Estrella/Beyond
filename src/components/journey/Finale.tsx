import { project } from "@/journey/scenes";
import { SplitText } from "./SplitText";
import styles from "./Finale.module.css";

interface FinaleProps {
  onRestart(): void;
}

/** The closing words, shown once the camera has come to rest at the horizon. */
export function Finale({ onRestart }: FinaleProps) {
  return (
    <footer className={styles.finale} data-finale>
      <p className={styles.closing}>
        <SplitText text={project.closing} />
      </p>
      <div className={styles.extra} data-finale-extra>
        <p className={styles.signature}>
          {project.name} <span aria-hidden="true">—</span> {project.subtitle}
        </p>
        <button type="button" className={styles.restart} onClick={onRestart}>
          <span className={styles.arrow} aria-hidden="true">
            ↑
          </span>
          Begin again
        </button>
      </div>
    </footer>
  );
}
