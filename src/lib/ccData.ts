import { ETHER_BACKEND_URL } from "./etherBackend";
import { query } from "../db/client";

// Control Center data mirror (Phase 2). Pushes install-owned table rows up so the
// dashboard can view them, and applies remote dashboard edits back through the local
// sync handlers. License-key authed (same pattern as the now-playing / users pushes).

// Push a table's LIVE rows up. Best-effort, one-way (install -> backend). Send only
// live rows; the backend reconcile clause tombstones any row_uuid it no longer sees.
export async function pushCcData(
  licenseKey: string | null | undefined,
  stationUuid: string | null | undefined,
  table: string,
  rows: unknown[],
): Promise<void> {
  if (!licenseKey || !stationUuid) return;
  try {
    const res = await fetch(`${ETHER_BACKEND_URL}/api/account/data/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-license-key": licenseKey },
      body: JSON.stringify({ station_uuid: stationUuid, table, rows }),
    });
    console.log(`[CCPUSH] ${table} sync → HTTP ${res.status}`);
  } catch (e) { console.log(`[CCPUSH] ${table} sync error:`, (e as any)?.message ?? e); }
}

// Gather a table's live rows via the typed sync handlers and push them. Any table in the
// NS map below is supported (categories, clocks, clock_slots, shows).
export async function pushCcTable(
  licenseKey: string | null | undefined,
  stationUuid: string | null | undefined,
  stationId: number,
  table: string,
): Promise<void> {
  if (!licenseKey || !stationUuid) return;
  const nsName = NS[table];
  if (!nsName) return;
  const ether = (window as any).ether;
  let res: any;
  try {
    res = await ether[nsName].list(stationId);
  } catch (e) { console.log(`[CCPUSH] ${table} list failed:`, (e as any)?.message ?? e); return; }
  // IPC list handlers return { rows: [...] } (or { ok, rows }), NOT a bare array.
  const rows: unknown[] = Array.isArray(res) ? res : ((res && res.rows) || []);
  console.log(`[CCPUSH] ${table}: ${rows.length} rows from station ${stationId}`);
  await pushCcData(licenseKey, stationUuid, table, rows);
}

// Push a per-station "library view" (Control Center 2d). songs/artists/albums are
// install-scoped (one shared library); the per-station treatment lives in
// station_programming. So for each station we push ONE denormalized row per song:
// the shared base facts (title/artist/album/duration/file_key/...) annotated with
// THIS station's overrides (category/rotation/energy/daypart), falling back to the
// song's base values where the station has no programming row. Keyed by song uuid,
// under table "library". A slim projection (no raw_metadata) keeps ~5,600 songs to
// ~1-1.5 MB. The backend upserts in chunks + tombstones songs we stop sending.
export async function pushLibrary(
  licenseKey: string | null | undefined,
  stationUuid: string | null | undefined,
  stationId: number,
): Promise<void> {
  if (!licenseKey || !stationUuid) return;
  let rows: any[];
  try {
    rows = await query(
      `SELECT
         s.uuid          AS uuid,
         s.id            AS song_id,
         sp.uuid         AS sp_uuid,
         s.title         AS title,
         ar.name         AS artist,
         al.title        AS album,
         s.genre         AS genre,
         s.duration_ms   AS duration_ms,
         s.bpm           AS bpm,
         s.is_explicit   AS is_explicit,
         s.file_key      AS file_key,
         COALESCE(sp.category_id,     s.category_id)     AS category_id,
         c.code          AS category_code,
         c.name          AS category_name,
         c.color         AS category_color,
         COALESCE(sp.rotation_status, s.rotation_status) AS rotation_status,
         COALESCE(sp.energy,          s.energy)          AS energy,
         COALESCE(sp.daypart_mask,    s.daypart_mask)    AS daypart_mask
       FROM songs s
       LEFT JOIN station_programming sp ON sp.song_id = s.id AND sp.station_id = ? AND sp.deleted_at IS NULL
       LEFT JOIN artists    ar ON ar.id = s.artist_id
       LEFT JOIN albums     al ON al.id = s.album_id
       LEFT JOIN categories c  ON c.id  = COALESCE(sp.category_id, s.category_id)
       WHERE s.deleted_at IS NULL
       ORDER BY s.title COLLATE NOCASE`,
      [stationId],
    );
  } catch (e) { console.log(`[CCPUSH] library query failed:`, (e as any)?.message ?? e); return; }
  // Stamp the station's local id on each row so the dashboard can create a
  // station_programming row (song_id + station_id) when editing treatment.
  for (const r of rows) r.station_id = stationId;
  console.log(`[CCPUSH] library: ${rows.length} songs for station ${stationId}`);
  await pushCcData(licenseKey, stationUuid, "library", rows);
}

// Whitelist of CC-mirrored tables -> the window.ether preload namespace that owns them.
// Used for both the read push (list) and the write (create/update/delete). Add a domain
// by adding one entry here (+ pushing it on boot below + a dashboard editor).
const NS: Record<string, string> = {
  categories: "categories",
  clocks: "clocks",
  clock_slots: "clockSlots",
  shows: "shows",
  songs: "songs",
  station_programming: "stationProgramming",
  artists: "artists",
  albums: "albums",
};

// Edits to these tables change a song's row in the per-station library VIEW, so after
// applying we re-push pushLibrary() (the synthesized "library" mirror) rather than the
// raw table. Everything else re-pushes its own table.
const LIBRARY_TABLES = new Set(["songs", "station_programming", "artists", "albums"]);

// Apply a remote dashboard edit to the local DB via the existing typed sync handlers
// (they wrap writes in withMutation -> HLC mutation -> syncs), then re-push the changed
// table so the dashboard reflects it. Whitelisted tables/ops only.
export async function applyDbMutation(
  licenseKey: string | null | undefined,
  data: { table: string; op: string; uuid?: string; payload?: any; station_id?: number; station_uuid?: string },
): Promise<void> {
  const ether = (window as any).ether;
  const ns = NS[data.table] ? ether[NS[data.table]] : null;
  if (!ns) { console.warn("[db:apply] unsupported table:", data.table); return; }
  try {
    if (data.op === "create") await ns.create(data.payload);
    else if (data.op === "update") await ns.update(data.uuid, data.payload);
    else if (data.op === "delete") await ns.delete(data.uuid, data.station_id);
    else { console.warn("[db:apply] unsupported op:", data.op); return; }
  } catch (e) {
    console.error("[db:apply] handler failed:", data.table, data.op, e);
    return;
  }
  if (data.station_uuid) {
    if (LIBRARY_TABLES.has(data.table)) {
      await pushLibrary(licenseKey, data.station_uuid, data.station_id as number);
    } else {
      await pushCcTable(licenseKey, data.station_uuid, data.station_id as number, data.table);
    }
  }
}
