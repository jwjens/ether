// src/lib/stickyScroll.ts — FEEDS NEVER MOVE THE SCREEN (Jeff, 2026-10-12).
//
// docs/health-monitor-jump-and-freeze-2026-10-12.md. Jeff: "the Health Monitor never moves, resizes, scrolls, auto-raises
// or takes focus by itself. New events appear without changing its position or the operator's scroll position (if the
// operator is scrolled up, stay there; at most show a 'new events' badge)."
//
// The cause was `element.scrollIntoView()` on every new line: it scrolls EVERY scrollable ancestor until the element is
// visible, so the Master Out console dragged the whole Master Out column down and the MASTER/MONITOR faders left the
// screen. A feed may only ever scroll ITS OWN box, and only when the operator is already at its bottom.
import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Feeds following their OWN box (the allowed programmatic scroll). The scroll sense (src/lib/perfSense.ts) skips
 *  these, so anything else that scrolls with no operator input is reported as unprompted (round 2 §5). */
export const ownFeedScrolls = new WeakMap<Element, number>();
function followOwn(el: HTMLElement) { ownFeedScrolls.set(el, performance.now()); el.scrollTop = el.scrollHeight; }

/** The nearest ancestor (or the element itself) that actually scrolls vertically. */
export function ownScroller(el: Element | null): HTMLElement | null {
  let n: HTMLElement | null = el as HTMLElement | null;
  while (n) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
    n = n.parentElement;
  }
  return null;
}

/** Bring a feed's end into view by scrolling ONLY the feed's own scroller — never the page or the panels around it. */
export function scrollOwnToBottom(endMarker: Element | null) {
  const s = ownScroller(endMarker);
  if (s) followOwn(s);
}

const AT_BOTTOM_PX = 24;

/**
 * A feed that follows new rows only while the operator is at its bottom.
 *   ref      — the feed's own scrolling element
 *   onScroll — attach to it
 *   unseen   — rows that arrived while the operator was scrolled up (show a badge; 0 = none)
 *   jump     — the badge's action: go to the newest row and follow again
 * `rowCount` is a running total of rows ever appended (an id, not the current length), so a capped buffer still counts.
 */
export function useStickyScroll(rowCount: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const lastCount = useRef(rowCount);
  const [unseen, setUnseen] = useState(0);

  const onScroll = useCallback(() => {
    const el = ref.current; if (!el) return;
    const b = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    atBottom.current = b;
    if (b) setUnseen(0);
  }, []);

  useLayoutEffect(() => {
    const added = rowCount - lastCount.current;
    lastCount.current = rowCount;
    if (added <= 0) return;
    const el = ref.current; if (!el) return;
    if (atBottom.current) followOwn(el);   // its own box only
    else setUnseen(n => n + added);
  }, [rowCount]);

  const jump = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setUnseen(0);
  }, []);

  return { ref, onScroll, unseen, jump };
}
