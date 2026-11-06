import { project } from "@/journey/scenes";
import { SplitText } from "./SplitText";
import styles from "./Opening.module.css";

/** Scene 01: the title card, and the invitation to scroll. */
export function Opening() {
  return (
    <header className={styles.opening}>
      <div className={styles.lockup}>
        <h1 className={styles.title} data-title>
          <SplitText text={project.name} introClassName={styles.introChar} />
        </h1>
        <div className={styles.subtitleIntro}>
          <p className={styles.subtitle} data-subtitle>
            {project.subtitle}
          </p>
        </div>
      </div>

      <div className={styles.hintIntro}>
        <div className={styles.hint} data-hint aria-hidden="true">
          <span>Scroll to begin</span>
          <span className={styles.hintLine} />
        </div>
      </div>
    </header>
  );
}
