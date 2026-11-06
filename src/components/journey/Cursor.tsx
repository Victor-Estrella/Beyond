"use client";

import gsap from "gsap";
import { useEffect, useRef, useState } from "react";
import styles from "./Cursor.module.css";

/**
 * A reticle of concentric rings that follows the mouse. Mouse only: on touch
 * devices nothing is rendered and the native cursor is left alone.
 */
export function Cursor() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || !window.matchMedia("(pointer: fine)").matches) return;

    const moveX = gsap.quickTo(element, "x", { duration: 0.35, ease: "power3.out" });
    const moveY = gsap.quickTo(element, "y", { duration: 0.35, ease: "power3.out" });
    let seen = false;

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      if (!seen) {
        seen = true;
        gsap.set(element, { x: event.clientX, y: event.clientY });
        setActive(true);
      }
      moveX(event.clientX);
      moveY(event.clientY);
      const target = event.target;
      const interactive = target instanceof Element && target.closest("button, a, [data-cursor]");
      element.dataset.hover = interactive ? "true" : "false";
    };
    const onLeave = () => setActive(false);
    const onEnter = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && seen) setActive(true);
    };
    const onDown = () => {
      element.dataset.press = "true";
    };
    const onUp = () => {
      element.dataset.press = "false";
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    window.addEventListener("pointerup", onUp, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    document.documentElement.addEventListener("pointerenter", onEnter);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.documentElement.removeEventListener("pointerenter", onEnter);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle(styles.hideNative, active);
    return () => document.documentElement.classList.remove(styles.hideNative);
  }, [active]);

  return (
    <div ref={ref} className={styles.cursor} data-active={active} aria-hidden="true">
      <span className={styles.ring} />
      <span className={styles.ring} />
      <span className={styles.ring} />
      <span className={styles.dot} />
    </div>
  );
}
