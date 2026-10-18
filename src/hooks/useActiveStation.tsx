/**
 * useActiveStation — reactive active-station ID/name for renderer components
 *
 * Same module-cache + listener-set pattern as usePlan. Components read
 * stationId from this hook instead of hardcoding 1 or querying the DB directly.
 *
 * Usage:
 *   const { stationId, stationName, isReady } = useActiveStation();
 *   if (!isReady) return null; // wait before issuing scoped queries
 */

import { useState, useEffect, createContext, useContext, type ReactNode } from "react";

// ─── Types ────────────────────────────────────────────────────

interface ActiveStation {
  id: number;
  name: string;
  uuid: string;
}

export interface UseActiveStationResult {
  /** Active station row ID. Defaults to 1 while loading. */
  stationId: number;
  /** Active station display name. Empty string while loading. */
  stationName: string;
  /** Active station's backend UUID (== local stations.uuid for onboarded
   *  stations, per OB18). Empty string while loading or if unset. Used by the
   *  now-playing push to key per-station state on the backend. */
  stationUuid: string;
  /** False until the first IPC response arrives. Gate queries behind this. */
  isReady: boolean;
}

// ─── Station scope (Screen Builder, docs/screen-builder-design-2026-10-18.md §2.3) ────
//
// A module on a built surface belongs to ONE station — the layout's (decision 1) — named explicitly,
// never read off the machine-global cache below. <StationScope> carries that station; the hook reads
// the NEAREST scope first and falls back to the global active station only where no scope exists, so
// every caller outside a scope behaves exactly as before.
//
// A scope is a resolved station by construction (whoever mounts it already knows the row), so it is
// always ready — there is no id=1 loading window inside a scope.

export interface ScopedStation {
  id: number;
  name: string;
  uuid: string;
}

const StationScopeContext = createContext<ScopedStation | null>(null);

export function StationScope({ station, children }: { station: ScopedStation; children: ReactNode }) {
  return <StationScopeContext.Provider value={station}>{children}</StationScopeContext.Provider>;
}

/** The nearest StationScope's station, or null outside every scope. */
export function useStationScope(): ScopedStation | null {
  return useContext(StationScopeContext);
}

// ─── Module-level cache (shared across all hook instances) ────

let _cached: ActiveStation | null = null;
let _cachedReady = false;

/**
 * Monotonically-increasing version counter. Each loadActiveStation() call
 * captures its version; stale responses (superseded by a later load) are
 * discarded without calling notifyAll.
 */
let _version = 0;

const _listeners = new Set<(s: ActiveStation | null, ready: boolean) => void>();

function notifyAll(s: ActiveStation | null, ready: boolean): void {
  _cached = s;
  _cachedReady = ready;
  _listeners.forEach(fn => fn(s, ready));
}

async function loadActiveStation(): Promise<void> {
  const v = ++_version;
  try {
    const row = await (window as any).ether.stations.getActive();
    if (v !== _version) return; // superseded by a newer load (e.g. rapid station switch)
    if (row?.id) {
      notifyAll({ id: row.id, name: row.name ?? "", uuid: row.uuid ?? "" }, true);
    } else {
      // No active station (e.g. no account signed in yet — stations:get-active is scoped to the
      // signed-in license) is a real, RESOLVED state, not "still loading". Mark ready (id=1
      // fallback) so the first-run gate in App.tsx can complete and route to account sign-in.
      // (Was `false`, which hung the gate and dropped fresh-install / signed-out states onto the
      // PIN profile picker instead of the account sign-in screen.)
      notifyAll({ id: 1, name: "", uuid: "" }, true);
    }
  } catch {
    if (v !== _version) return;
    notifyAll({ id: 1, name: "", uuid: "" }, false);
  }
}

/**
 * Synchronous cache read — safe for timers/module-level functions that can't
 * call hooks. Returns 1 until the async load resolves (which happens on first
 * component mount, well before any 10-second timer fires).
 */
export function getActiveStationIdSync(): number {
  return _cached?.id ?? 1;
}

// ─── Hook ─────────────────────────────────────────────────────

export function useActiveStation(): UseActiveStationResult {
  const scope = useContext(StationScopeContext);
  const [station, setStation] = useState<ActiveStation | null>(_cached);
  const [ready, setReady]     = useState(_cachedReady);

  // Subscribe to future notifyAll calls (mirrors usePlan listener pattern)
  useEffect(() => {
    const listener = (s: ActiveStation | null, r: boolean) => {
      setStation(s);
      setReady(r);
    };
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
  }, []);

  // Initial load + station-switched event listener
  useEffect(() => {
    if (!_cached || !_cachedReady) loadActiveStation();

    const handler = () => {
      // Clear cache so the upcoming load is treated as fresh, not a no-op
      _cached = null;
      _cachedReady = false;
      loadActiveStation();
    };
    window.addEventListener("station-switched", handler);
    return () => window.removeEventListener("station-switched", handler);
  }, []);

  // Inside a scope the scope IS the station. The hooks above still run (hook order never changes),
  // so a component that moves in or out of a scope keeps working.
  if (scope) return { stationId: scope.id, stationName: scope.name, stationUuid: scope.uuid, isReady: true };

  const stationId   = station?.id ?? 1;
  const stationName = station?.name ?? "";
  const stationUuid = station?.uuid ?? "";

  if (ready && !station?.id) {
    console.error("useActiveStation: ready but no station id — migration incomplete?");
  }

  return { stationId, stationName, stationUuid, isReady: ready };
}
