// ── useContainerWidth — measure the element, never the window ───────────────────────────────────
//
// Generalised from HealthMonitor's useTwoColumn, which carries the lesson in its own comment: the
// first cut measured window.innerWidth and put the ~950px Station Health POPOUT into the narrow
// layout — "right code, wrong thing measured".
//
// That matters more here, not less. The wall-display layout is meant for a 1920×1080 screen, and the
// way it gets there is the popout: its own window, which can be full-screened on the wall while the
// main app window stays whatever size it is. The window is not a proxy for the space this panel has.
import { useEffect, useRef, useState } from "react";

/** Below this the dashboard stacks; at or above it, the wall grid. 1280 is the point at which a
 *  chart beside a meter column both stay legible — narrower and the chart is a smear. */
export const WALL_MIN_PX = 1280;

/** The wall canvas is AUTHORED at exactly this size and scaled to fit whatever screen it lands on.
 *  Authoring at a fixed size is what makes "no scrolling, at a glance" true on every display rather
 *  than only on a 1920×1080 one: the layout never reflows, so nothing can be pushed off the bottom
 *  by a screen that is 40px shorter than the designer's. */
export const WALL_W = 1920;
export const WALL_H = 1080;

/** Width AND height of the element. The wall canvas needs both to compute its fit-scale — a
 *  width-only fit overflows vertically on any screen shorter than 9:16 of its width, and on a wall
 *  display an overflow is data silently cut off rather than a scrollbar. */
export function useContainerSize(): readonly [React.RefObject<HTMLDivElement>, number, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      // Compared before setting: a ResizeObserver that fires with unchanged numbers would otherwise
      // re-render the whole panel, and this one observes a container that holds live meters.
      setSize(prev => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size.w, size.h] as const;
}

export function useContainerWidth(): readonly [React.RefObject<HTMLDivElement>, number] {
  const [ref, width] = useContainerSize();
  return [ref, width] as const;
}
