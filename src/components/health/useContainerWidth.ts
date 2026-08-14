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

export function useContainerWidth(): readonly [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
