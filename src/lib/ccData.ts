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
         CASE WHEN s.file_path IS NOT NULL AND s.file_path != '' THEN 1 ELSE 0 END AS has_local,
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

// Push new play_log rows for analytics (Phase 3a). Append-only + incremental: a
// per-station localStorage cursor tracks the highest play_log id already pushed from
// THIS machine; the backend dedupes by row_uuid. Batched so a first-run backfill of a
// long history doesn't block. Called on boot + on a periodic timer.
export async function pushPlayHistory(
  licenseKey: string | null | undefined,
  stationUuid: string | null | undefined,
  stationId: number,
): Promise<void> {
  if (!licenseKey || !stationUuid) return;
  const cursorKey = `ether_ph_cursor_${stationId}`;
  const BATCH = 1000;
  const MAX_BATCHES = 60; // safety cap per run (~60k rows)
  try {
    for (let b = 0; b < MAX_BATCHES; b++) {
      const cursor = Number(localStorage.getItem(cursorKey) || "0");
      const rows: any[] = await query(
        `SELECT id, uuid, title, artist, duration_ms, played_at, category_code, show_name
           FROM play_log
          WHERE station_id = ? AND id > ? AND deleted_at IS NULL
          ORDER BY id LIMIT ?`,
        [stationId, cursor, BATCH],
      );
      if (!rows.length) break;
      const payload = rows.map((r) => ({
        row_uuid: r.uuid || `lid-${stationId}-${r.id}`,
        title: r.title, artist: r.artist, duration_ms: r.duration_ms,
        played_at: r.played_at, category_code: r.category_code, show_name: r.show_name,
      }));
      const res = await fetch(`${ETHER_BACKEND_URL}/api/account/play-history`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-license-key": licenseKey },
        body: JSON.stringify({ station_uuid: stationUuid, rows: payload }),
      });
      if (!res.ok) { console.log(`[PHPUSH] HTTP ${res.status} — stopping`); break; }
      const maxId = rows[rows.length - 1].id;
      localStorage.setItem(cursorKey, String(maxId));
      console.log(`[PHPUSH] pushed ${rows.length} rows (through id ${maxId})`);
      if (rows.length < BATCH) break; // caught up
    }
  } catch (e) { console.log("[PHPUSH] error:", (e as any)?.message ?? e); }
}

// Control Center 2d-3 — create a song from a dashboard upload. The audio is already in
// R2 under `file_key` (uploaded straight from the dashboard via a signed PUT); here we
// create the install-side record so it's playable (the engine fetches R2 audio on demand
// at play time via fetchR2Track). Find-or-create the artist, create the song with the
// file_key + browser-read duration, add it to THIS station's rotation, then re-push the
// library view. IPC create/find handlers return { ok, row }.
export async function addLibrarySong(
  licenseKey: string | null | undefined,
  data: {
    file_key?: string; title?: string; artist?: string;
    category_id?: number | null; duration_ms?: number | null;
    station_id?: number; station_uuid?: string;
  },
): Promise<void> {
  const ether = (window as any).ether;
  const { file_key, title, artist, category_id, duration_ms, station_id, station_uuid } = data;
  if (!file_key || !title || station_id == null) {
    console.warn("[addSong] missing file_key/title/station_id — skipped");
    return;
  }
  try {
    let artist_id: number | null = null;
    if (artist && artist.trim()) {
      const a = await ether.artists.findOrCreateByName(artist.trim());
      artist_id = a?.row?.id ?? a?.id ?? null;
    }
    const songRes = await ether.songs.create({
      title: String(title).trim(),
      artist_id,
      file_key,
      category_id: category_id ?? null,
      duration_ms: duration_ms ?? null,
      rotation_status: "active",
      daypart_mask: 16777215,
    });
    const songId = songRes?.row?.id ?? songRes?.id ?? null;
    if (songId != null) {
      await ether.stationProgramming.create({
        song_id: songId, station_id, category_id: category_id ?? null, rotation_status: "active",
      });
    } else {
      console.warn("[addSong] no song id returned — skipped station_programming");
    }
    console.log(`[addSong] created "${title}" file_key=${file_key} song_id=${songId}`);
    // Materialize: pull the audio down to local + set file_path so the song enters
    // automation rotation (fire-and-forget; the download re-pushes the view when done).
    try { await ether.invoke?.("library:sync-r2:download", { materialize: true }); } catch { /* best-effort */ }
  } catch (e) {
    console.error("[addSong] failed:", (e as any)?.message ?? e);
    return;
  }
  await pushLibrary(licenseKey, station_uuid, station_id);
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
