// useFaderControl — HOW EVERY FADER IS HANDLED (Jeff, 2026-10-13, docs/fader-handling-plan-2026-10-13.md):
//   1. Grab without jumping: pressing on the cap or the track never moves the fader. It moves only by the distance the
//      pointer moves after the press (relative drag), like a real console.
//   2. Shift + drag = fine: the movement is divided by Preferences' fine factor.
//   3. Mouse wheel steps the wheel step; arrow keys step when the fader has focus, Shift + arrow the fine step (all dB,
//      all Preferences — faderFeel()).
//   4. `active` is true while dragging (and briefly after a wheel/arrow step) so the fader's dB readout can light up.
//   5. Double-click = 0 dB, unity (Jeff, 2026-10-28: "Double-clicking any fader sets it to 0 dB (unity)."). A fader whose
//      top is below 0 dB goes to its top, the nearest it can be.
// Stores hold gain; the law (faderLaw.ts) only decides where a gain is drawn. One law, every fader.
import { isPlainKey } from "./plainKey";
import { useCallback, useEffect, useRef, useState } from "react";
import { gainToPos, posToGain, topGain, stepGain, faderFeel } from "./faderLaw";

export interface FaderControlOpts {
  gain: number;
  topDb: number;
  onChange: (gain: number) => void;
  /** "y" = vertical (up is louder), "x" = horizontal (right is louder). */
  axis: "x" | "y";
  /** The element whose length is the travel (the track). */
  trackRef: React.RefObject<HTMLElement | null>;
  /** Pixels of the track that are not travel (e.g. the cap's height on a vertical fader whose cap stays inside). */
  insetPx?: number;
  disabled?: boolean;
}

export function useFaderControl({ gain, topDb, onChange, axis, trackRef, insetPx = 0, disabled = false }: FaderControlOpts) {
  const [dragging, setDragging] = useState(false);
  const [stepping, setStepping] = useState(false);
  const stepTimer = useRef<number | null>(null);
  // The latest values, for the wheel listener (attached once, not re-bound every render).
  const live = useRef({ gain, topDb, onChange, disabled });
  live.current = { gain, topDb, onChange, disabled };

  const flashStep = useCallback(() => {
    setStepping(true);
    if (stepTimer.current != null) window.clearTimeout(stepTimer.current);
    stepTimer.current = window.setTimeout(() => setStepping(false), 1200);
  }, []);
  useEffect(() => () => { if (stepTimer.current != null) window.clearTimeout(stepTimer.current); }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const track = trackRef.current; if (!track) return;
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    try { (el as HTMLElement).focus?.({ preventScroll: true }); } catch { /* ignore */ }
    setDragging(true);
    // Where the fader IS — the press itself changes nothing.
    let pos = gainToPos(live.current.gain, live.current.topDb);
    let last = axis === "y" ? e.clientY : e.clientX;
    const onMove = (ev: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      const len = Math.max(1, (axis === "y" ? rect.height : rect.width) - insetPx);
      const now = axis === "y" ? ev.clientY : ev.clientX;
      const moved = axis === "y" ? last - now : now - last;   // up / right = louder
      last = now;
      const factor = ev.shiftKey ? 1 / Math.max(1, faderFeel().fine) : 1;
      pos = Math.max(0, Math.min(1, pos + (moved / len) * factor));
      live.current.onChange(Math.min(posToGain(pos, live.current.topDb), topGain(live.current.topDb)));
    };
    const onUp = () => {
      setDragging(false);
      el.removeEventListener("pointermove", onMove as any);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove as any);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }, [axis, trackRef, insetPx, disabled]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    if (disabled || !isPlainKey(e)) return;   // arrows step the fader; Shift (fine step) stays, Ctrl/Alt/Meta do not
    const up = e.key === "ArrowUp" || e.key === "ArrowRight";
    const down = e.key === "ArrowDown" || e.key === "ArrowLeft";
    if (!up && !down) return;
    e.preventDefault();
    const f = faderFeel();
    onChange(stepGain(gain, up ? 1 : -1, e.shiftKey ? f.arrowFineDb : f.arrowDb, topDb));
    flashStep();
  }, [disabled, gain, topDb, onChange, flashStep]);

  const onDoubleClick = useCallback((e?: React.MouseEvent<HTMLElement>) => {
    if (disabled) return;
    e?.preventDefault();
    onChange(Math.min(1, topGain(topDb)));
    flashStep();
  }, [disabled, topDb, onChange, flashStep]);

  // The wheel: a non-passive listener so the page does not scroll while a fader is being stepped.
  useEffect(() => {
    const el = trackRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const v = live.current; if (v.disabled || e.deltaY === 0) return;
      e.preventDefault();
      v.onChange(stepGain(v.gain, e.deltaY < 0 ? 1 : -1, faderFeel().wheelDb, v.topDb));
      flashStep();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [trackRef, flashStep]);

  return { onPointerDown, onKeyDown, onDoubleClick, tabIndex: disabled ? -1 : 0, dragging, active: dragging || stepping };
}
