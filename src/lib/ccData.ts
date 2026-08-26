import { ETHER_BACKEND_URL } from "./etherBackend";
import { query } from "../db/client";
import { queryScoped } from "../db/stationScoped";
import { selectAttachedStationsToMaterialize, chooseActiveStation } from "./provisioning";

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

// ── FLEET HEALTH FRAMES (web Health Monitor) ──────────────────────────────────────────────────────
// Pushed as table "health" on THIS channel — no second channel, per the design doc §1. The frame is
// assembled in the main process (electron/health-frame.js via the health:frames IPC), so there is one
// builder and the renderer only carries it. One push per station: /api/account/data/sync validates
// station ownership per call.
//
// The backend does NOT tombstone-sweep table "health" (index.js, the `table !== "health"` guard):
// many machines write frames for one station and each only ever sends its own row, so a sweep would
// make them delete each other. Stale rows go dark by AGE at the reader instead.
export async function pushHealthFrames(
  licenseKey: string | null | undefined,
  cadenceSec: number,
): Promise<number> {
  if (!licenseKey) return 0;
  let frames: { stationUuid: string; row: any }[] = [];
  try {
    frames = (await (window as any).ether?.invoke?.("health:frames", cadenceSec)) || [];
  } catch (e) { console.log("[CCPUSH] health frames unavailable:", (e as any)?.message ?? e); return 0; }
  if (!Array.isArray(frames) || frames.length === 0) return 0;
  for (const f of frames) {
    if (!f?.stationUuid || !f?.row) continue;
    await pushCcData(licenseKey, f.stationUuid, "health", [f.row]);
  }
  return frames.length;
}

// ── JUKEBOX PUBLIC POOL (Phase 2) ────────────────────────────────────────────────────────────────
// Publish the songs a phone may search, keyed by this station's PUBLIC SLUG.
//
// THE INSTALL OWNS THE POOL. The backend never derives it, because the two facts that define it live
// only here: which categories the operator ticked, and whether the file is actually playable on THIS
// machine. A guest must never be offered a song that would be dead air in front of the room.
//
// The predicate below is the wall's own (Jukebox.tsx runQuery) — deliberately copied rather than
// approximated, so the phone and the wall can never disagree about what is in the pool. Including
// skipScoping: `songs` has no station_id, and the injected predicate silently binds to
// artists.station_id and returns ZERO rows (the 156-vs-0 bug of 2026-08-18).
export async function pushJukeboxPool(
  licenseKey: string | null | undefined,
  stationUuid: string | null | undefined,
  stationId: number,
  stationName: string | null | undefined,
): Promise<void> {
  if (!licenseKey || !stationUuid) return;
  try {
    const eth = (window as any).ether;
    // Read config exactly as the wall does (Jukebox.tsx: stationConfigKv.list -> find by key), so the
    // two cannot drift on how they interpret the operator's settings.
    const r: any = await eth?.stationConfigKv?.list?.(stationId);
    const kv: any[] = (r && r.rows) || [];
    const get = (k: string) => kv.find(x => x.key === k)?.value;

    const slug = String(get("jukebox_request_url") ?? "").trim().toLowerCase();
    if (!slug) return;   // no public URL configured → nothing to publish, and no QR to scan either

    let categoryIds: number[] = [];
    try {
      const raw = get("jukebox_categories");
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) categoryIds = parsed.map((n: any) => parseInt(n, 10)).filter(Number.isFinite);
    } catch { categoryIds = []; }
    if (!categoryIds.length) return;   // nothing ticked → an empty pool is not worth publishing

    const inList = categoryIds.map(() => "?").join(",");
    const rows = await queryScoped<any>(
      `SELECT s.uuid, s.title, a.name AS artist, s.duration_ms
         FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
        WHERE s.deleted_at IS NULL AND s.file_path IS NOT NULL AND TRIM(s.file_path) <> ''
          AND (s.content_class IS NULL OR s.content_class = 'MUSIC')
          AND s.uuid IS NOT NULL
          AND s.category_id IN (${inList})
        ORDER BY s.title`,
      categoryIds, stationId, { skipScoping: true });

    // UUID is the identity on the wire, never the local integer id — the phone's pick has to survive
    // being resolved on a machine whose integer ids mean something else entirely.
    const songs = rows.map(r => ({
      uuid: r.uuid, title: r.title, artist: r.artist ?? null, duration_ms: r.duration_ms ?? null,
    }));

    const res = await fetch(`${ETHER_BACKEND_URL}/api/account/jukebox/pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-license-key": licenseKey },
      body: JSON.stringify({ station_uuid: stationUuid, slug, station_name: stationName ?? null, songs }),
    });
    console.log(`[JUKEBOX] published pool "${slug}": ${songs.length} songs → HTTP ${res.status}`);
  } catch (e) {
    console.log("[JUKEBOX] pool publish failed:", (e as any)?.message ?? e);
  }
}

// ── JUKEBOX LIVE STATE (lobby display) ───────────────────────────────────────────────────────────
// What the room-facing lobby screen shows: what is playing, what is next, and who asked for it.
//
// Published by the JUKEBOX WINDOW, because that window is the only place these facts exist together —
// it already polls the routed deck every second and the request list every five. Nothing new is
// measured here; this is the same state the wall renders, addressed to the lobby.
//
// If the operator closes the Jukebox window the state stops updating, and the lobby says
// "reconnecting…" while holding its last frame. That is honest: with the window shut there is nothing
// driving the deck either.
export async function pushJukeboxState(
  licenseKey: string | null | undefined,
  slug: string | null | undefined,
  state: {
    nowPlaying: { title: string; artist: string | null; requester: string | null } | null;
    upNext: { title: string; artist: string | null; requester: string | null } | null;
    queue: { title: string; artist: string | null; requester: string | null }[];
    autoOn: boolean;
    onAir: boolean;
  },
): Promise<void> {
  const s = String(slug ?? "").trim().toLowerCase();
  if (!licenseKey || !s) return;
  try {
    await fetch(`${ETHER_BACKEND_URL}/api/account/jukebox/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-license-key": licenseKey },
      body: JSON.stringify({ slug: s, state }),
    });
  } catch (e) {
    // Best-effort by design: the lobby going stale must never disturb the room the wall is serving.
    console.log("[JUKEBOX] state publish failed:", (e as any)?.message ?? e);
  }
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
        `SELECT id, uuid, title, artist, duration_ms, played_at, category_code, show_name, file_path
           FROM play_log
          -- ANN excluded: the Control Center's history is a song history; an announcement
          -- airing is proven in the local play log, not in the dashboard's track list.
          WHERE station_id = ? AND id > ? AND deleted_at IS NULL AND (content_class IS NULL OR content_class = 'MUSIC')
          ORDER BY id LIMIT ?`,
        [stationId, cursor, BATCH],
      );
      if (!rows.length) break;
      const payload = rows.map((r) => ({
        row_uuid: r.uuid || `lid-${stationId}-${r.id}`,
        title: r.title, artist: r.artist, duration_ms: r.duration_ms,
        played_at: r.played_at, category_code: r.category_code, show_name: r.show_name,
        file_path: r.file_path ?? null,   // v19: affidavit join key
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
  const { file_key, title, artist, category_id, duration_ms, station_uuid } = data;
  // Resolve the install's local station_id from the UUID (dashboard never supplies the integer).
  let station_id: number | null = data.station_id ?? null;
  if (station_uuid) {
    const resolved = await resolveLocalStationId(ether, station_uuid);
    if (resolved == null) {
      console.error(`[addSong] station ${station_uuid} not found on this install — cannot add song. Let the station sync down first.`);
      return;
    }
    station_id = resolved;
  }
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
  spots: "spots",   // mirrored for the advertiser affidavit (advertiser/isci/file_path)
};

// Edits to these tables change a song's row in the per-station library VIEW, so after
// applying we re-push pushLibrary() (the synthesized "library" mirror) rather than the
// raw table. Everything else re-pushes its own table.
const LIBRARY_TABLES = new Set(["songs", "station_programming", "artists", "albums"]);

// Station-scoped tables whose remote create/delete must carry THIS install's local integer
// station_id. (Install-scoped library tables — songs/artists/albums — ignore station_id.)
const STATION_SCOPED = new Set(["categories", "clocks", "clock_slots", "shows", "station_programming", "spots"]);

// Resolve this install's LOCAL integer station_id from the station UUID the dashboard sends.
// The dashboard knows the station only by UUID and cannot know the install's local integer id,
// so the install is the source of truth — this is what lets the dashboard seed the FIRST row of
// a brand-new station (there's no existing row to read the id from). Returns null when the
// station is not on this install; callers MUST bail rather than write a guessed/null station_id.
async function resolveLocalStationId(ether: any, stationUuid: string | undefined | null): Promise<number | null> {
  if (!stationUuid) return null;
  try {
    const res = await ether.stations.list();
    const rows = Array.isArray(res) ? res : (res?.rows || []);
    const match = rows.find((s: any) => s.uuid === stationUuid);
    return match?.id ?? null;
  } catch { return null; }
}

// Sign-in import of cloud-STAGED programming: pull dashboard-authored categories/clocks/shows/
// clock_slots (created with no running install) and apply them locally via the db:apply path,
// resolving station_uuid + cross-row parent UUIDs (clock_uuid, category_uuid) to LOCAL integer
// ids in dependency order. Rows carry their stable row_uuid (uuid-passthrough) so a re-import is a
// no-op (UNIQUE uuid) and mark-imported stops re-delivery. Categories may carry an explicit `id`
// (cloned from DJ Deniro's scheme) so the borrowed library's songs match OV's clock_slots.
export async function importStagedProgramming(licenseKey: string | null | undefined): Promise<{ imported: number }> {
  if (!licenseKey) return { imported: 0 };
  const ether = (window as any).ether;
  let imported = 0;
  try {
    const local = await ether.stations.list();
    const stations = Array.isArray(local) ? local : (local?.rows || []);
    for (const st of stations) {
      if (!st?.uuid) continue;
      let rows: any[] = [];
      try {
        const res = await fetch(`${ETHER_BACKEND_URL}/api/account/station/${encodeURIComponent(st.uuid)}/staged/pending`, {
          headers: { "x-license-key": licenseKey },
        });
        const data = await res.json().catch(() => ({}));
        rows = Array.isArray(data.rows) ? data.rows : [];
      } catch { continue; }
      if (rows.length === 0) continue;

      const uuidToLocalId = new Map<string, number>();   // staged row_uuid -> local integer id (categories, clocks)
      const applied: string[] = [];
      for (const r of rows) {
        const table = r.table_name as string;
        const p: any = { ...r.payload, uuid: r.row_uuid };   // uuid-passthrough (stable identity / idempotency)
        // Resolve cross-row parent FKs from staged UUIDs -> local integer ids (parents already applied).
        if (table === "shows" && p.clock_uuid != null) { p.clock_id = uuidToLocalId.get(p.clock_uuid) ?? null; delete p.clock_uuid; }
        if (table === "clock_slots") {
          if (p.clock_uuid != null)    { p.clock_id    = uuidToLocalId.get(p.clock_uuid)    ?? null; delete p.clock_uuid; }
          if (p.category_uuid != null) { p.category_id = uuidToLocalId.get(p.category_uuid) ?? null; delete p.category_uuid; }
        }
        // Apply through the db:apply path: resolves station_uuid -> local station_id, stamps it,
        // and generates a NORMAL local mutation that syncs up. (Core sync/merge path untouched.)
        await applyDbMutation(licenseKey, { table, op: "create", payload: p, station_uuid: st.uuid });
        // Record the local id of parents so dependent rows can resolve their FKs.
        if (table === "categories" || table === "clocks") {
          try {
            const got = await query<{ id: number }>(`SELECT id FROM ${table} WHERE uuid = ? AND deleted_at IS NULL LIMIT 1`, [r.row_uuid]);
            const id = got?.[0]?.id;
            if (id != null) uuidToLocalId.set(r.row_uuid, id);
          } catch { /* parent lookup failed — dependents will resolve to null and be skipped */ }
        }
        applied.push(r.row_uuid);
        imported++;
      }
      if (applied.length > 0) {
        try {
          await fetch(`${ETHER_BACKEND_URL}/api/account/station/${encodeURIComponent(st.uuid)}/staged/mark-imported`, {
            method: "POST",
            headers: { "x-license-key": licenseKey, "Content-Type": "application/json" },
            body: JSON.stringify({ row_uuids: applied }),
          });
        } catch { /* best-effort; uuid-UNIQUE keeps a re-run idempotent even if this ack is lost */ }
      }
    }
  } catch (e) {
    console.warn("[import-staged] failed:", (e as any)?.message ?? e);
  }
  return { imported };
}

// Periodic reconcile: ensure every cloud station for this license exists in the LOCAL stations
// table, so a station created in the dashboard materializes on a running install WITHOUT a
// sign-out/in (the only other path is OnboardingFlow at sign-in). Reuses the exact mechanism
// onboarding uses (/account/connect → stations.create with the backend uuid).
//
// STRICTLY ADDITIVE — creates stations missing locally; never deletes a local station absent
// from the cloud (that pruning is a separate, deliberately-deferred reconciliation), never
// switches the active station, and reuses this install's existing machine_id (no new seat).
// Best-effort: returns the number created; swallows errors so the next tick just retries.

// Write the authoritative license into ALL THREE slots the transport resolves from
// (transport-http.js _getLicenseKey), so a stale value cannot survive in any of them:
//   1) install_config_kv.account_license_key   — the anchor, highest priority
//   2) stations.owner_license_key              — every station
//   3) station_config_kv.license_key           — the legacy slot an old build wrote
// Idempotent; safe to run on every reconcile.
export async function stampLicenseEverywhere(key: string): Promise<void> {
  const ether = (window as any).ether;
  try { await ether.installConfigKv.upsertByKey("account_license_key", key); }
  catch (e) { console.warn("[reconcile] anchor stamp failed:", (e as any)?.message ?? e); }
  try {
    const local = await ether.stations.list();
    const list = (Array.isArray(local) ? local : (local?.rows || [])) as any[];
    for (const st of list) {
      if (st?.deleted_at) continue;
      if (st?.owner_license_key !== key) {
        try { await ether.stations.setOwnerLicense(st.id, key); } catch { /* per-station best effort */ }
      }
      // READ BEFORE WRITE. This runs on App.tsx's 20s syncCloud interval, and slot 3 is
      // station_config_kv — a SYNCED table, so an unconditional upsert here journals a CRDT mutation
      // per station per tick and every peer replays it forever. The owner_license_key stamp above has
      // always been guarded; this one was not, which is what produced 2,312 no-op `license_key`
      // mutations (100% of them) in a single day across two machines.
      //
      // The main-process writer refuses no-ops too (electron/sync/handlers/station_config_kv.js), so
      // this is belt-and-suspenders — but it also spares the IPC round trip on the hot path.
      // docs/sync-systems-map.md §3.
      try {
        const rows = (await ether.stationConfigKv.list(st.id))?.rows || [];
        const current = rows.find((r: any) => r.key === "license_key" && !r.deleted_at);
        if (current && String(current.value) === String(key)) continue;   // already correct — say nothing
        await ether.stationConfigKv.upsertByKey(st.id, "license_key", key);
      } catch { /* legacy slot */ }
    }
  } catch (e) { console.warn("[reconcile] station stamp failed:", (e as any)?.message ?? e); }
}

// Try every DISTINCT license value stored on this machine against the backend. Returns the first one
// the backend accepts (and stamps it everywhere), or null when none work — which is the honest signal
// that the install genuinely needs re-activation rather than a refresh.
async function healStaleLicense(rejected: string, idResp: any): Promise<string | null> {
  const ether = (window as any).ether;
  const candidates: string[] = [];
  const add = (v: any) => {
    const k = String(v || "").trim();
    if (k && k !== rejected && !candidates.includes(k)) candidates.push(k);
  };
  try {
    const local = await ether.stations.list();
    const list = (Array.isArray(local) ? local : (local?.rows || [])) as any[];
    for (const st of list) add(st?.owner_license_key);
    for (const st of list) {
      try {
        const rows = (await ether.stationConfigKv.list(st.id))?.rows || [];
        for (const r of rows) if (r.key === "license_key") add(r.value);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  if (!candidates.length) return null;
  console.log(`[reconcile] license rejected — trying ${candidates.length} other stored key(s)`);

  for (const k of candidates) {
    try {
      const r = await fetch(`${ETHER_BACKEND_URL}/account/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          license_key:  k,
          machine_id:   idResp?.ok ? idResp.machine_id   : "",
          machine_name: idResp?.ok ? idResp.machine_name : "",
        }),
      });
      if (r.ok) { await stampLicenseEverywhere(k); return k; }
    } catch { /* offline or unreachable — try the next, and again next tick */ }
  }
  return null;
}

export async function reconcileAccountStations(licenseKey: string | null | undefined, _healAttempt = 0): Promise<number> {
  if (!licenseKey) return 0;
  const ether = (window as any).ether;
  try {
    const idResp = await ether.identity?.get?.().catch(() => null);
    const res = await fetch(`${ETHER_BACKEND_URL}/account/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key:  licenseKey,
        machine_id:   idResp?.ok ? idResp.machine_id   : "",
        machine_name: idResp?.ok ? idResp.machine_name : "",
      }),
    });
    const data = await res.json().catch(() => ({}));
    // A response ARRIVED — the backend is reachable again. Clears the down state here rather than at
    // the end of the function, because the condition being tracked is reachability: a 401 still
    // proves the host answered, and the stale-key heal below is a different problem with its own path.
    noteReconcileSuccess();

    // Pin the ACCOUNT license at INSTALL scope so the sync transport resolves the push license
    // DETERMINISTICALLY (this anchor is branch 1 of transport._getLicenseKey), not via an arbitrary
    // station_config_kv `… LIMIT 1` row. The backend just validated this key for THIS account (res.ok),
    // so it is authoritative — this is what stops programming being misfiled under a stale/owner license
    // on a multi-license install. On a single-license install it equals the only license (no change).
    if (res.ok && licenseKey) {
      await stampLicenseEverywhere(String(licenseKey).trim());
    }

    // ── SELF-HEAL A STALE KEY ────────────────────────────────────────────────────────────────────
    // The re-stamp above only runs when the key ALREADY works — which is a trap. A machine carrying a
    // stale key from an old version gets 401, so res.ok is false, so the anchor is never refreshed:
    // the only code that can fix a bad key needs a good key to run. Sign-out/sign-in cannot break the
    // loop either, because the anchor outranks the key that re-stamps.
    //
    // The way out: the three slots can hold DIFFERENT values, and the resolver blindly takes the
    // anchor. So when the anchor is rejected, try the others and adopt whichever the backend accepts.
    // No operator steps, no new endpoint — the machine heals itself on the next tick.
    // _healAttempt bounds this to ONE recovery pass. Without it two mutually-rejected keys would
    // recurse forever, hammering the backend from a machine nobody is watching.
    if (!res.ok && _healAttempt === 0 && (res.status === 401 || String(data?.error || "") === "invalid_license_key")) {
      const healed = await healStaleLicense(String(licenseKey), idResp);
      if (healed) {
        console.log("[reconcile] recovered from a stale license key — retrying with the accepted one");
        return await reconcileAccountStations(healed, 1);
      }
      console.warn("[reconcile] license rejected and no stored alternative was accepted — needs re-activation");
    }

    // Keep the local plan tier in step with the account's PLATFORM assignment — read from the SAME
    // /account/connect the platform drives. Without this, plan_tier only updates on a full sign-in, so a
    // running install (or one provisioned via cloud restore) can be stuck on a stale/free tier even though
    // the account is paid. Honors a dev override (never clobber it). Best-effort; failures retry next tick.
    if (data.plan && typeof data.plan === "string") {
      try {
        // TIER IS ACCOUNT-LEVEL: persist the account's plan at INSTALL scope (install_config_kv), NOT on
        // a station — usePlan reads it independent of any station. data.plan from /account/connect is the
        // authoritative source. Owner/dev override (station 1) still wins, so don't clobber it. Always
        // apply to the live UI (the account is the truth), not only on a change.
        const s1 = (await ether.stationConfigKv.list(1))?.rows || [];
        const hasOverride = s1.some((r: any) => r.key === "plan_tier_dev_override" && r.value);
        if (!hasOverride) {
          await ether.installConfigKv.upsertByKey("plan_tier", data.plan);
          const { setPlanGlobally } = await import("../hooks/usePlan");
          setPlanGlobally(data.plan as any);
          console.log("[reconcile] account tier →", data.plan, "(install-level)");
        }
      } catch (e) { console.warn("[reconcile] plan sync failed:", (e as any)?.message ?? e); }
    }

    const cloud: any[] = Array.isArray(data.stations) ? data.stations : [];
    const local = await ether.stations.list();
    const localList = (Array.isArray(local) ? local : (local?.rows || [])) as any[];
    const haveUuids  = new Set(localList.map((s: any) => s.uuid));
    const cloudUuids = new Set(cloud.map((s: any) => s.uuid));

    // Tombstones: stations deliberately DELETED on this machine. The reconcile must NOT re-materialize
    // these from the cloud — a confirmed delete wins over the multi-device sync (the "delete that won't
    // stick" bug). Without this, a deleted station comes straight back on the next sync tick.
    let tombstoned = new Set<string>();
    try {
      const del = await query<{ uuid: string }>("SELECT uuid FROM stations WHERE deleted_at IS NOT NULL AND uuid IS NOT NULL", []);
      tombstoned = new Set((del || []).map(r => r.uuid));
    } catch { /* best-effort — absence just means no tombstone filtering this tick */ }
    const norm = (n: any) => String(n || "").trim().toLowerCase();

    // ── Cloud → local: ATTACHMENT-AWARE materialize (Phase 3). Materialize ONLY the stations THIS
    //    surface is attached to (from /account/connect.attachments) — not every account station — and
    //    never one we tombstoned (a resurrection). FAIL-CLOSED: no attachments → materialize nothing;
    //    the placement question (onboarding) is what writes them. Pure decision in provisioning.js. ──
    const attachments: any[] = Array.isArray(data.attachments) ? data.attachments : [];
    const toMaterialize = selectAttachedStationsToMaterialize({ cloud, attachments, haveUuids, tombstoned });
    let created = 0;
    for (const s of toMaterialize) {
      const r = await ether.stations.create({
        uuid:      s.uuid,
        name:      s.name         || "Station",
        callsign:  s.call_letters || "",
        frequency: s.frequency    || "",
      });
      // NOTE: no stations.switch here — activation is decided once, below, only when nothing is active.
      if (r?.ok) { created++; console.log(`[reconcile] materialized attached station ${s.name} (${s.uuid})`); }
      else console.warn("[reconcile] local station insert failed:", r?.error);
    }

    // ── Local → cloud self-heal — the universal fix for "new station can't publish". Stamp every
    // station of THIS account with the account's REAL license, and register any local station the
    // cloud doesn't know yet, so a station created ANY way at all (not just + Add Station) becomes
    // owned + publishable on its own — no manual backfill. Ownership rule: a uuid present in the
    // account's cloud list is definitively ours (even if its local owner is stale/wrong from an old
    // build — this is what corrects a station mis-tagged to another license); a NULL owner is a
    // fresh local station; a non-null owner that is neither this license nor in the cloud is a
    // member / cross-account station the operator runs — left untouched. register-station is
    // idempotent by uuid and consumes no seat.
    let registered = 0;
    for (const s of localList) {
      if (!s?.uuid) continue;
      const owner = s.owner_license_key;
      const inCloud = cloudUuids.has(s.uuid);
      const isOurs = owner == null || owner === "" || owner === licenseKey || inCloud;
      if (!isOurs) continue;
      if (owner !== licenseKey) {
        try { await ether.stations.setOwnerLicense(s.id, licenseKey); console.log(`[reconcile] owner → account for ${s.name} (${s.uuid})`); }
        catch (e) { /* retry next tick */ }
      }
      if (!inCloud) {
        // Don't re-register a CHURN DUPLICATE: if the account already has a DIFFERENT station with the
        // same name in the cloud, this local row is a stale duplicate (e.g. a stub uuid left by an old
        // build) — registering it would resurrect the dupe across every device. Skip it; the operator
        // deletes the dupe with the real delete button, which tombstones it.
        const dupeInCloud = cloud.some((c: any) => c.uuid !== s.uuid && norm(c.name) === norm(s.name));
        if (dupeInCloud) { console.log(`[reconcile] skip registering duplicate-name station ${s.name} (${s.uuid}) — already in cloud under another uuid`); continue; }
        try {
          const rr = await fetch(`${ETHER_BACKEND_URL}/account/register-station`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ license_key: licenseKey, uuid: s.uuid, name: s.name || "Station", call_letters: s.callsign || null }),
          });
          if (rr.ok) { registered++; console.log(`[reconcile] registered local station ${s.name} (${s.uuid}) with the account`); }
          else console.warn("[reconcile] register-station failed:", rr.status);
        } catch (e) { /* retry next tick */ }
      }
    }

    // v2 FIRST-STATION ADOPTION: if this install has NO active station (fresh install — the default
    // "Station 1" seed was removed in the station-provisioning work), activate the account's station so
    // it shows on screen right after a plain sign-in ("your station, with your name on it, on screen").
    // Safe: acts ONLY when nothing is active, so it never changes an on-air station on a multi-station
    // install (the same reason materialize itself never switches). Prefer an account (cloud) station.
    let adopted = false;
    try {
      const active = await ether.stations.getActive();
      const hasActive = !!(active && active.id);
      if (!hasActive) {
        const fresh = await ether.stations.list();
        const freshList = (Array.isArray(fresh) ? fresh : (fresh?.rows || [])) as any[];
        // Prefer an ATTACHED station; fall back to first local (legacy single-station installs). Pure.
        const adopt = chooseActiveStation({ localStations: freshList, attachments, hasActive: false });
        if (adopt?.id) {
          await ether.stations.switch(adopt.id);
          adopted = true;
          console.log(`[reconcile] adopted active station ${adopt.name} (${adopt.uuid}) — first-station adoption`);
        }
      }
    } catch (e) { /* best-effort — retry next tick */ }

    if (created > 0 || registered > 0 || adopted) window.dispatchEvent(new Event("station-switched")); // nudge switcher/badge
    return created + registered;
  } catch (e) {
    noteReconcileFailure(e);
    return 0;
  }
}

// ── Reconcile health: report the TRANSITION, not every tick ──────────────────────────────────────
//
// This runs on a 20s poll (App.tsx). It used to console.warn on every failure, so an install that
// could not reach the backend wrote a line three times a minute forever: 1,767 in one
// ether-startup.log, ~95% of the file, which actively slowed the 2026-08-03 freeze diagnosis
// (backlog). The noise WAS the defect — the fetch itself is load-bearing.
//
// The backlog entry proposed killing or repointing the timer, on the premise that Railway "is not
// coming back". That premise is false: /health answers 200, this IS the surviving endpoint, and
// /account/connect is the root of the account model — no account, no stations. Removing the timer
// would have broken "author in the dashboard, it just shows up" to silence a log.
//
// So: one health event when reconcile STARTS failing, one when it RECOVERS, and a count of what
// happened in between. An offline station is a normal state for an offline-first product, not an
// error to repeat until someone stops reading.
let _reconcileFailing = false;
let _reconcileFailCount = 0;

function noteReconcileFailure(e: unknown) {
  _reconcileFailCount++;
  if (_reconcileFailing) return;                 // already reported; stay quiet until it clears
  _reconcileFailing = true;
  const message = (e as any)?.message ?? String(e);
  console.warn("[reconcile] account stations reconcile failed:", message, "— further failures are silent until it recovers");
  try {
    (window as any).ether?.invoke?.("health:record", "cloud-reconcile-down", {
      message, endpoint: ETHER_BACKEND_URL,
    });
  } catch { /* the ledger must never break the reconcile */ }
}

function noteReconcileSuccess() {
  if (!_reconcileFailing) return;
  const failures = _reconcileFailCount;
  _reconcileFailing = false;
  _reconcileFailCount = 0;
  console.log(`[reconcile] cloud reconcile recovered after ${failures} failed attempt(s)`);
  try { (window as any).ether?.invoke?.("health:record", "cloud-reconcile-up", { failures }); } catch {}
}

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

  // Resolve THIS install's local station_id from the UUID the dashboard sent — so the dashboard
  // never needs to know or supply the integer (fixes first-row bootstrap on a fresh station).
  // Authoritative when it resolves; for station-scoped tables a non-resolving UUID is a hard bail
  // (the station isn't on this install yet) — never write a guessed/null station_id.
  let localStationId: number | null = data.station_id ?? null;
  if (data.station_uuid) {
    const resolved = await resolveLocalStationId(ether, data.station_uuid);
    if (resolved != null) localStationId = resolved;
    else if (STATION_SCOPED.has(data.table)) {
      console.error(`[db:apply] station ${data.station_uuid} not found on this install — cannot ${data.op} ${data.table}. Sign the station in / let it sync down first.`);
      return;
    }
  }

  try {
    if (data.op === "create") {
      const payload = STATION_SCOPED.has(data.table) ? { ...data.payload, station_id: localStationId } : data.payload;
      await ns.create(payload);
    } else if (data.op === "update") {
      await ns.update(data.uuid, data.payload);
    } else if (data.op === "delete") {
      await ns.delete(data.uuid, STATION_SCOPED.has(data.table) ? (localStationId ?? undefined) : data.station_id);
    } else { console.warn("[db:apply] unsupported op:", data.op); return; }
  } catch (e) {
    console.error("[db:apply] handler failed:", data.table, data.op, e);
    return;
  }

  if (data.station_uuid) {
    if (LIBRARY_TABLES.has(data.table)) {
      await pushLibrary(licenseKey, data.station_uuid, localStationId as number);
    } else {
      await pushCcTable(licenseKey, data.station_uuid, localStationId as number, data.table);
    }
  }
}
