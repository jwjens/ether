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

import { useState, useEffect } from "react";

// ─── Types ────────────────────────────────────────────────────

interface ActiveStation {
  id: number;
  name: string;
}

export interface UseActiveStationResult {
  /** Active station row ID. Defaults to 1 while loading. */
  stationId: number;
  /** Active station display name. Empty string while loading. */
  stationName: string;
  /** False until the first IPC response arrives. Gate queries behind this. */
  isReady: boolean;
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
      notifyAll({ id: row.id, name: row.name ?? "" }, true);
    } else {
      // No active station found — fall back to id=1, mark not-ready so callers wait
      notifyAll({ id: 1, name: "" }, false);
    }
  } catch {
    if (v !== _version) return;
    notifyAll({ id: 1, name: "" }, false);
  }
}

// ─── Hook ─────────────────────────────────────────────────────

export function useActiveStation(): UseActiveStationResult {
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

  const stationId   = station?.id ?? 1;
  const stationName = station?.name ?? "";

  if (ready && !station?.id) {
    console.error("useActiveStation: ready but no station id — migration incomplete?");
  }

  return { stationId, stationName, isReady: ready };
}
