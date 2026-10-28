// THE BOARD'S FADER BANK LAYOUT (Jeff, 2026-10-28): strips like a digital console's fader banks.
//   1. Every strip has a minimum width at which the cap, ON, PFL, EQ and the source name all fit; never narrower.
//      Above it, strips spread to fill the space.
//   2. When they don't fit, the board scrolls sideways; Master Out stays pinned on the right; an overview above the
//      board shows every fader, the visible ones highlighted, and a click jumps there.
//   3. Narrow (below NARROW_BELOW_PX): the dB number leaves the cap and shows while the fader moves; the source dropdown
//      shows a short name (full name on hover); ON and PFL stack.
// Pure numbers and geometry, so the rules are tests.

/** The narrowest a strip ever gets: fader column (54) + gap (14) + meter (32) + side padding (16), with room to spare. */
export const STRIP_MIN_PX = 118;
/** Below this a strip uses its narrow layout (ON and PFL side by side need ~140 px). */
export const NARROW_BELOW_PX = 150;

export const isNarrowStrip = (widthPx: number) => widthPx > 0 && widthPx < NARROW_BELOW_PX;

/** A strip's place in the scrolling row (offsetLeft / offsetWidth). */
export type StripBox = { key: string; left: number; width: number };

/** Which strips are visible in the viewport [scrollLeft, scrollLeft + viewWidth): at least half of the strip showing. */
export function visibleStrips(strips: readonly StripBox[], scrollLeft: number, viewWidth: number): string[] {
  const a = scrollLeft, b = scrollLeft + viewWidth;
  return strips.filter(s => {
    const shown = Math.min(b, s.left + s.width) - Math.max(a, s.left);
    return shown >= s.width / 2;
  }).map(s => s.key);
}

/** Where to scroll so `key` is in view: unchanged if it already is, else just enough to bring it fully in. */
export function scrollToShow(strips: readonly StripBox[], key: string, scrollLeft: number, viewWidth: number): number {
  const s = strips.find(x => x.key === key);
  if (!s) return scrollLeft;
  if (s.left < scrollLeft) return s.left;
  if (s.left + s.width > scrollLeft + viewWidth) return Math.max(0, s.left + s.width - viewWidth);
  return scrollLeft;
}

/** Does the row overflow its viewport (the overview is shown only then)? */
export const overflows = (contentWidth: number, viewWidth: number) => contentWidth > viewWidth + 1;
