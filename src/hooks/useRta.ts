// useRta — SLICE 8: the live RTA for ONE target while a rack view shows it (docs/dsp-channel-rta.md).
//
// `target` = a fader's engine slot, "master", or null (not listening). While mounted with a target the view renews
// its LEASE every 2 s (the daemon clears the engine's tap when renewals stop — a closed or crashed window turns it off
// by itself) and says "" on unmount. Frames arrive as audio:rta by station UUID; only this station's frames for this
// target are taken. PEAK HOLD: per FINE point (the old master rack's white markers — Jeff's 2026-09-26 ruling brought
// them back), ON unless the viewer turns it off (this supersedes ruling 3's "off by default"; flagged in the doc).
import { useEffect, useRef, useState } from "react";
import { useActiveStation } from "./useActiveStation";
import { holdStep, type Hold, type RtaFrame } from "../components/rack/rta";

const PEAK_KEY = "ether_rta_peak_hold_v2";   // v2: the default became ON with the old rack's markers

export function useRta(target: string | null) {
  const { stationId, stationUuid } = useActiveStation();
  const [frame, setFrame] = useState<RtaFrame | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [peakHold, setPeakHoldState] = useState<boolean>(() => { try { return localStorage.getItem(PEAK_KEY) !== "0"; } catch { return true; } });
  const hold = useRef<Hold | null>(null);
  const [held, setHeld] = useState<number[] | null>(null);

  const setPeakHold = (on: boolean) => {
    setPeakHoldState(on);
    hold.current = null;
    setHeld(null);
    try { localStorage.setItem(PEAK_KEY, on ? "1" : "0"); } catch { /* per-viewer convenience only */ }
  };

  // The lease: subscribe now, renew every 2 s, stop on unmount.
  useEffect(() => {
    const audio = (window as any).ether?.audio;
    if (stationId == null || !target || !audio?.rtaSubscribe) { setFrame(null); return; }
    let alive = true;
    const renew = async () => {
      try {
        const r = await audio.rtaSubscribe(stationId, target);
        if (alive) setUnavailable(r && r.ok === false ? (r.reason || "the live spectrum is not available") : null);
      } catch { /* the service answers on the next renewal */ }
    };
    void renew();
    const t = setInterval(renew, 2000);
    return () => { alive = false; clearInterval(t); try { audio.rtaSubscribe(stationId, ""); } catch { /* lease lapses by itself */ } };
  }, [stationId, target]);

  // The frames.
  useEffect(() => {
    const audio = (window as any).ether?.audio;
    if (!audio?.onRta || !target) return;
    hold.current = null;
    const h = audio.onRta((f: RtaFrame) => {
      if (!f || (stationUuid && f.stationUuid && f.stationUuid !== stationUuid) || f.target !== target) return;
      setFrame(f);
      if (peakHold && f.fed && Array.isArray(f.finePost)) {
        hold.current = holdStep(hold.current, f.finePost, performance.now());
        setHeld(hold.current.v);
      }
    });
    return () => audio.offRta?.(h);
  }, [stationUuid, target, peakHold]);

  return { frame, unavailable, peakHold, setPeakHold, held: peakHold ? held : null };
}
