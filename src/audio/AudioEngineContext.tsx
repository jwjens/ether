import React, { createContext, useContext, useEffect } from "react";
import { AudioEngine } from "./engine-rodio";
import { getEngine, initializeRegistry } from "./engine-registry";
import { useActiveStation } from "../hooks/useActiveStation";

// ── NO DEFAULT STATION. THE ABSENCE OF A PROVIDER IS AN ERROR, NOT A ONE. ────────────────────────
//
// This was `createContext<number>(1)`. A default of `1` is indistinguishable from a real station 1,
// so a component rendered outside the provider commanded station 1 — silently, with no throw, no
// warning and no visual difference. That is what made the pop-out defect invisible: every pop-out
// window mounts its own React root (src/main.tsx) and NONE of them mounted this provider, so every
// component in every window that resolved its engine through the context was addressing the wrong
// station. Carts loaded onto station 1's cart channel while the operator listened to station 2.
//
// The reach of that default, measured 2026-09-08: BoutiqueCartWall, PhoneDesk, VoiceTracker,
// MasterOutput, ConsoleStrip, UpNext, Spots and HealthMonitor all call useAudioEngine() and all
// render in pop-out windows.
//
// `null` cannot be mistaken for a station. useAudioEngine() throws on it, by name, with the fix in
// the message — Jeff's rule: "a wrong station silently is worse than a throw. If a component can't
// resolve a station it should say so, not guess."
const AudioEngineContext = createContext<number | null>(null);

/**
 * @param gate  Render children only once the active station has RESOLVED, rather than during the
 *              one-IPC-round-trip window in which useActiveStation() still reports its id=1
 *              fallback. Pop-out windows pass this: a blank moment in a window costs nothing, and
 *              a cart fired into station 1 because the answer had not arrived yet costs air.
 *
 *              The dashboard deliberately does NOT gate. useActiveStation marks itself ready even
 *              when there is no active station (no account signed in), but its CATCH path leaves
 *              ready=false — and gating the main window on that would mean a failed stations IPC
 *              renders no app at all, with no route to sign-in and nothing on screen to say why.
 *              A dead-ended main window is a worse failure than the one this fixes.
 */
export function AudioEngineProvider({ children, gate }: { children: React.ReactNode; gate?: boolean }) {
  const { stationId, isReady } = useActiveStation();

  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.stations?.list) return;
    ether.stations.list()
      .then((rows: { id: number }[]) => {
        if (Array.isArray(rows)) {
          initializeRegistry(rows.map((r: { id: number }) => r.id));
        }
      })
      .catch((e: unknown) => {
        console.error("[engine-registry] stations.list failed, falling back to [1]:", e);
        initializeRegistry([1]);
      });
  }, []);

  if (gate && !isReady) {
    // Says so rather than guessing. Not a spinner: this window is not loading content, it is waiting
    // to be told which station it belongs to, and if that never arrives the operator should read that
    // sentence rather than watch an animation.
    return (
      <div style={{
        height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--bg-primary, #07070b)", color: "var(--text-tertiary, #505060)",
        fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12, padding: 24, textAlign: "center",
      }}>
        Waiting for the active station…
      </div>
    );
  }

  return (
    <AudioEngineContext.Provider value={stationId}>
      {children}
    </AudioEngineContext.Provider>
  );
}

export function useAudioEngine(): AudioEngine;
export function useAudioEngine(stationId: number): AudioEngine;
export function useAudioEngine(stationId?: number): AudioEngine {
  const contextStationId = useContext(AudioEngineContext);
  const resolved = stationId ?? contextStationId;
  if (resolved == null) {
    // Loud, named, and carrying its own fix. This throw reaches the operator as the window's error
    // screen (RootBoundary in src/main.tsx) — which is the point: a window that cannot tell which
    // station it commands must not command one.
    throw new Error(
      "useAudioEngine() was called with no AudioEngineProvider above it, so there is no active " +
      "station to command. Every window root must mount <AudioEngineProvider> (see src/main.tsx); " +
      "code that runs above the provider must call getEngine(stationId) explicitly instead."
    );
  }
  return getEngine(resolved);
}
