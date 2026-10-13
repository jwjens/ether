// useFaderTop — the top (maximum, dB) of each fader group, as SAVED (Jeff, 2026-10-11: "The maximum for each fader group
// is a visible setting, not hard-coded"). Read from main (board:sound-settings) and shared by every fader in a window;
// refreshed when any window changes it (board:sound-settings-changed). Until the saved values are read the defaults
// stand: channel +10, AUX rows +10, MASTER 0, MONITOR 0 (src/lib/faderLaw.ts DEFAULT_TOP_DB).
import { useEffect, useState } from "react";
import { DEFAULT_TOP_DB, setFaderLaw, setFaderFeel, type FaderGroup } from "./faderLaw";
import { useActiveStation } from "../hooks/useActiveStation";

type Tops = Record<FaderGroup, number>;
let tops: Tops = { ...DEFAULT_TOP_DB };
let loadedFor: number | null = null;
const listeners = new Set<(t: Tops) => void>();
let wired = false;

function ether(): any { return (window as any).ether; }
async function load(stationId: number) {
  try {
    const s = await ether()?.invoke?.("board:sound-settings", stationId);
    if (s && s.faderTopDb) {
      // The fader law and how a fader feels (Preferences → Faders, 2026-10-13) arrive with the tops; a fresh tops object
      // re-renders every fader so each redraws on the saved law.
      setFaderLaw(s.faderLaw);
      setFaderFeel(s.faderFeel);
      tops = { ...DEFAULT_TOP_DB, ...s.faderTopDb }; loadedFor = stationId; listeners.forEach(l => l(tops));
    }
  } catch { /* main not ready — the defaults stand until it is */ }
}
function wire() {
  if (wired) return;
  wired = true;
  try { ether()?.on?.("board:sound-settings-changed", () => { if (loadedFor != null) void load(loadedFor); }); } catch { /* no bridge */ }
}

/** The saved top, in dB, of one fader group. */
export function useFaderTop(group: FaderGroup): number {
  const { stationId } = useActiveStation();
  const [t, setT] = useState<Tops>(tops);
  useEffect(() => {
    wire();
    const l = (n: Tops) => setT(n);
    listeners.add(l);
    if (stationId != null && loadedFor !== stationId) void load(stationId);
    return () => { listeners.delete(l); };
  }, [stationId]);
  return t[group];
}
