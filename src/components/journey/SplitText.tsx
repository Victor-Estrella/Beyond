import type { CSSProperties } from "react";
import styles from "./SplitText.module.css";

interface SplitTextProps {
  /** Text to split. Wrap a phrase in *asterisks* to set it in italics. */
  text: string;
  /**
   * Wrap every letter in an extra element carrying its position as the CSS variable
   * `--i`, so CSS can stagger an entrance without touching what GSAP animates.
   */
  introClassName?: string;
}

interface Segment {
  text: string;
  emphasis: boolean;
}

function parse(text: string): Segment[] {
  return text
    .split(/(\*[^*]+\*)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("*") ? { text: part.slice(1, -1), emphasis: true } : { text: part, emphasis: false },
    );
}

/**
 * Renders text as individually animatable letters (`[data-char]`), grouped by
 * word so lines only ever break between words. Screen readers get the plain text.
 */
export function SplitText({ text, introClassName }: SplitTextProps) {
  const segments = parse(text);
  let position = 0;

  return (
    <>
      <span className={styles.srOnly}>{segments.map((segment) => segment.text).join("")}</span>
      <span aria-hidden="true">
        {segments.map((segment, segmentIndex) =>
          segment.text.split(/(\s+)/).map((word, wordIndex) => {
            if (word === "") return null;
            if (/^\s+$/.test(word)) return " ";
            return (
              <span
                key={`${segmentIndex}-${wordIndex}`}
                className={segment.emphasis ? `${styles.word} ${styles.emphasis}` : styles.word}
              >
                {Array.from(word).map((char, charIndex) => {
                  const index = position++;
                  const letter = (
                    <span key={charIndex} data-char className={styles.char}>
                      {char}
                    </span>
                  );
                  return introClassName ? (
                    <span key={charIndex} className={introClassName} style={{ "--i": index } as CSSProperties}>
                      {letter}
                    </span>
                  ) : (
                    letter
                  );
                })}
              </span>
            );
          }),
        )}
      </span>
    </>
  );
}
