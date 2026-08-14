// ── healthData — where the dashboard's numbers come from ────────────────────────────────────────
//
// Health Monitor redesign, Phase 1.
//
// THREE CORRECTIONS TO THE SPEC'S §0/§2, all verified against the tree on 2026-08-13. Binding a card
// to a field that does not exist is how a dashboard ends up confidently showing "—" forever, which is
// the exact failure mode this codebase has been fixing for two days.
//
//   1. DESIGNATION IS NOT ON THE library-health SNAPSHOT. The spec says
//      `library-health:get → stations[].designation`; there is no such field
//      (electron/library-health.js:335-342 returns runway / goals / material / pool / skips).
//      Designation comes from its own IPC, `designation:status`, which returns one row per station.
//
//   2. THERE IS NO `engine:getQueue` IPC. Nothing in the tree registers that channel. The queue is
//      daemon-owned and mirrored into the renderer's engine object; the length is read in-process as
//      `engine.getQueue().length` (the pattern src/canvas/widgets/Widgets.tsx:18 already uses).
//
//   3. The KV handler lives at `electron/sync/handlers/station_config_kv.js`, not
//      `electron/station_config_kv.js`.
//
// Runway and goals ARE on the snapshot exactly as the spec says.

export interface RunwayInfo {
  metric?: string; days: number | null; hours: number | null;
  level?: string; gapAt?: number | null; through?: number | null; capped?: boolean; reason?: string;
}

export interface GoalsInfo { declared?: number; totalCats?: number; mismatches?: any[]; composition?: any[]; }

export interface StationHealth {
  stationId: number;
  station?: string;
  name?: string;
  level?: string;
  runway?: RunwayInfo;
  goals?: GoalsInfo;
  [k: string]: any;
}

export interface LibrarySnapshot { stations?: StationHealth[]; [k: string]: any; }

export interface DesignationRow {
  stationId: number; station?: string; state?: string; level?: string;
  holder?: string | null; holderName?: string | null; writeError?: string | null;
  [k: string]: any;
}

const invoke = (channel: string, ...args: any[]): Promise<any> => {
  const eth = (window as any).ether;
  if (!eth?.invoke) return Promise.reject(new Error("IPC unavailable"));
  return eth.invoke(channel, ...args);
};

/** The library/rotation snapshot — the same call and cadence the existing Health Monitor uses. */
export async function fetchLibraryHealth(): Promise<LibrarySnapshot | null> {
  try {
    const s = await invoke("library-health:get");
    return s && typeof s === "object" ? s : null;
  } catch { return null; }        // IPC absent (browser/dev) — the cards render their unknown state
}

/** Designation, per station. Its own IPC — see correction 1 above. */
export async function fetchDesignation(): Promise<DesignationRow[]> {
  try {
    const rows = await invoke("designation:status");
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

/**
 * Compare two station ids that may not share a type.
 *
 * The snapshot is built in the main process where ids are INTEGERs from SQLite; the renderer's
 * active-station id has travelled through IPC and app state and is not guaranteed to still be a
 * number. `2 === "2"` is false, and the failure is silent and total: the panel finds no station and
 * renders every card as unknown while the data sits right there. Compared by value, and null/undefined
 * never matches anything.
 */
function sameStation(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/** Pick one station out of the snapshot. Returns null rather than the wrong station's health. */
export function stationFrom(snap: LibrarySnapshot | null, stationId: number | null | undefined): StationHealth | null {
  if (!snap || !Array.isArray(snap.stations) || stationId == null) return null;
  return snap.stations.find(s => sameStation(s.stationId, stationId)) ?? null;
}

export function designationFor(rows: DesignationRow[], stationId: number | null | undefined): DesignationRow | null {
  if (stationId == null) return null;
  return rows.find(r => sameStation(r.stationId, stationId)) ?? null;
}

/** Poll cadences, from the spec §2. */
export const POLL_SNAPSHOT_MS = 30_000;
export const POLL_QUEUE_MS = 5_000;
