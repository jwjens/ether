// electron/screen-read-queries.js — the screens' reads that used to be written inline in main.js's IPC handlers, as
// plain functions of (db, …args) so they run on the screen-read worker's own read-only connection
// (electron/screen-read-worker.js) and never on the main thread. Same SQL, same answers; main only resolves the station.
"use strict";

/** schedule:get — one station's log rows in [fromTs, toTs). The station is resolved by main (the active one by default). */
function scheduleGet(db, sid, fromTs, toTs) {
  // generated_schedule is per-station; without a station filter this returned EVERY station's rows
  // in the time range (Magical Forest's calendar showing another station's songs).
  // Durable cross-station guard: a row's station_id says which station OWNS the slot, but the
  // song it points at can later be re-categorised into ANOTHER station's library (the per-station
  // category migration did exactly this — Christmas tracks generated under HalloVeen's category
  // were moved into OV's "Christmas" category, leaving stale rows that made HalloVeen's calendar
  // show Christmas). Never DISPLAY a row whose song now positively belongs to a different station.
  // Conservative by design — only drops rows we can prove are foreign: song-less rows (spots/talk),
  // songs with no category, or categories with no station_id all pass through unchanged.
  return db.prepare(
    // uuid/source/state added for the log editor (Fix 2): uuid is the only stable handle a row can
    // be addressed by for mutation, source says who owns it, state says whether it has already
    // aired (and is therefore a record, not a plan).
    // played_at (v33, engine-stamped) added 2026-09-18 for the Program Log's as-run time cell.
    // log_hour_ts (v66): the hour the row belongs to — every clock row is placed, so a row can start past :00 and
    // is still shown (and windowed) under its own hour and day.
    `SELECT g.id, g.uuid, g.scheduled_at, g.song_id, g.title, g.artist, g.file_key, g.file_path,
            g.duration_s, g.category_id, g.source, g.state, g.content_class, g.channel, g.played_at, g.log_hour_ts
     FROM generated_schedule g
     WHERE g.station_id = ? AND COALESCE(g.log_hour_ts, g.scheduled_at) >= ? AND COALESCE(g.log_hour_ts, g.scheduled_at) < ? AND g.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM songs s JOIN categories c ON c.id = s.category_id
         WHERE s.id = g.song_id AND c.station_id IS NOT NULL AND c.station_id <> g.station_id
       )
     ORDER BY g.scheduled_at`
  ).all(sid, fromTs ?? 0, toTs ?? 9999999999);
}

/** schedule:categoryHealth — how much room each category has before artist separation eliminates every candidate. */
function categoryHealth(db, id) {
  const sep = db.prepare("SELECT value FROM separation_rules WHERE rule_type='artist_separation_min' AND is_active=1 AND station_id=? LIMIT 1").get(id);
  const artistSepMin = sep ? sep.value : 60;
  // In-rotation categories: those an active show's clock actually calls (falls back to any category
  // that has active songs, so a station without clocks still gets a readout).
  let inRotation = [];
  try {
    inRotation = db.prepare(`SELECT DISTINCT cs.category_id FROM clock_slots cs
      WHERE cs.slot_type='music' AND cs.category_id IS NOT NULL AND cs.deleted_at IS NULL AND cs.station_id=?
        AND cs.clock_id IN (SELECT clock_id FROM shows WHERE is_active=1 AND clock_id IS NOT NULL AND deleted_at IS NULL AND station_id=?)`).all(id, id).map(r => r.category_id);
  } catch {}
  const inRot = new Set(inRotation);
  const cats = db.prepare(`
    SELECT c.id, c.code, c.name,
      (SELECT COUNT(*) FROM songs s WHERE s.category_id=c.id AND s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status!='inactive')) AS songs,
      (SELECT COUNT(DISTINCT s.artist_id) FROM songs s WHERE s.category_id=c.id AND s.artist_id IS NOT NULL AND s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status!='inactive')) AS artists
    FROM categories c WHERE (c.station_id=? OR c.station_id IS NULL) ORDER BY c.code`).all(id);
  const rows = cats.filter(c => c.songs > 0).map(c => {
    const status = c.artists >= 10 ? 'healthy' : c.artists >= 6 ? 'tight' : 'at_risk';
    return { id: c.id, code: c.code, name: c.name, songs: c.songs, artists: c.artists, status, inRotation: inRot.has(c.id) };
  });
  return { artistSepMin, rows };
}

module.exports = { scheduleGet, categoryHealth };
