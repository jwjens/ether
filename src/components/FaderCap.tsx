// FaderCap — THE ONE FADER CAP, every fader on the board (Jeff, 2026-10-28: "Make every fader cap look like a real console
// fader: a raised cap with depth (shading and a shadow), grip ridges across it, and a center line that points to the
// scale. The cursor changes to a grab hand on hover, and the cap shows when it's being moved.").
//   vertical   — the channel strips (ConsoleStrip: decks and source faders); the scale is to the LEFT of the cap.
//   horizontal — HFader (MASTER, MONITOR, the aux rows, the station strips); the scale marks cross the track.
// Drawing only: position, size and handling stay with the fader (useFaderControl). Pointer events pass through to the
// fader's own capture area. Theme hooks: --fader-cap-face / --fader-cap-face-off / --fader-cap-line.
import type { CSSProperties, ReactNode } from "react";

export const capFace = (on: boolean, axis: "x" | "y") => {
  const dir = axis === "y" ? "to bottom" : "to right";
  return on
    ? `var(--fader-cap-face, linear-gradient(${dir}, #fbfbfd 0%, #e2e2e8 38%, #c9c9d2 62%, #a9a9b6 100%))`
    : `var(--fader-cap-face-off, linear-gradient(${dir}, #7a7a86 0%, #5c5c67 50%, #45454f 100%))`;
};
/** Raised: a drop shadow under the cap, a light top edge, a dark bottom edge. Lifted further, with a ring, while moved. */
export const capShadow = (dragging: boolean, color: string) => dragging
  ? `0 7px 14px rgba(0,0,0,0.6), 0 0 0 2px ${color}, inset 0 1px 0 rgba(255,255,255,0.75), inset 0 -2px 0 rgba(0,0,0,0.3)`
  : `0 3px 6px rgba(0,0,0,0.55), 0 1px 1px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.75), inset 0 -2px 0 rgba(0,0,0,0.3)`;
/** Grip ridges ACROSS the cap: lines across the direction of travel. */
export const capRidges = (axis: "x" | "y") =>
  `repeating-linear-gradient(${axis === "y" ? "to bottom" : "to right"}, rgba(0,0,0,0.22) 0 1px, rgba(255,255,255,0.35) 1px 2px, transparent 2px 4px)`;

export default function FaderCap({ axis, width, height, on = true, dragging = false, color = "#8868D8", style, children }: {
  axis: "x" | "y"; width: number; height: number; on?: boolean; dragging?: boolean; color?: string; style?: CSSProperties; children?: ReactNode;
}) {
  const v = axis === "y";
  // The ridged zones sit either side of the center line; the middle stays smooth so the line reads.
  const ridge = (side: "a" | "b"): CSSProperties => v
    ? { position: "absolute", left: 4, right: 4, height: Math.max(6, height * 0.3), ...(side === "a" ? { top: 4 } : { bottom: 4 }), backgroundImage: capRidges("y"), opacity: on ? 1 : 0.6 }
    : { position: "absolute", top: 3, bottom: 3, width: Math.max(2, width * 0.28), ...(side === "a" ? { left: 1 } : { right: 1 }), backgroundImage: capRidges("x"), opacity: on ? 1 : 0.6 };
  return (
    <div data-fader-cap={dragging ? "moving" : "still"} style={{
      position: "absolute", width, height, boxSizing: "border-box", pointerEvents: "none",
      background: capFace(on, axis), borderRadius: 3, border: "1px solid rgba(0,0,0,0.55)",
      boxShadow: capShadow(dragging, color),
      ...style,
      // Moved: lifted a little, so the hand on it is seen.
      transform: dragging ? `${style?.transform || ""} scale(1.04)`.trim() : style?.transform,
    }}>
      <div style={ridge("a")} />
      <div style={ridge("b")} />
      {/* THE CENTER LINE — where the fader is read against the scale. It runs out past the cap's edge toward the scale. */}
      <div data-fader-cap-line="1" style={v
        ? { position: "absolute", left: -5, right: 2, top: "50%", height: 2, marginTop: -1, background: `var(--fader-cap-line, ${on ? "#111" : "#222"})` }
        : { position: "absolute", top: -3, bottom: -3, left: "50%", width: 2, marginLeft: -1, background: `var(--fader-cap-line, ${on ? "#111" : "#222"})` }} />
      {children}
    </div>
  );
}
