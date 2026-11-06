import type { SceneDef } from "@/journey/scenes";
import { SplitText } from "./SplitText";
import styles from "./SceneCopy.module.css";

interface SceneCopyProps {
  scene: SceneDef;
  index: number;
}

/** The label and narrative line of one scene. The timeline finds it by `data-copy`. */
export function SceneCopy({ scene, index }: SceneCopyProps) {
  return (
    <section className={styles.copy} data-copy={index} aria-label={scene.title}>
      <div className={styles.inner} data-copy-inner>
        <p className={styles.eyebrow} data-eyebrow>
          <span>{scene.number}</span>
          <span className={styles.rule} aria-hidden="true" />
          <span>{scene.title}</span>
        </p>
        <p className={styles.line}>
          <SplitText text={scene.line} />
        </p>
      </div>
    </section>
  );
}
