// audiod/playlog.js — daemon-side play logging (Item 10, Phase 2 Step 4).
//
// When the daemon owns playout it must also write the play log, so Play History keeps
// filling even while the UI (and main process) restart during an app update — the renderer's
// logPlay stops in daemon-driven mode (App.tsx gates it). This writes a play_log row AND the
// sync mutation, byte-for-byte like electron/sync/handlers/play_log.js playLogCreate, by
// reusing the app's own mutation-writer (logMutation + serializePayload). Those use only
// prepare().run()/.get()/.all() + crypto, which node:sqlite supports; the only better-sqlite3
// API they'd need is db.transaction(), so we wrap the write in a manual BEGIN/COMMIT instead.
//
// Cross-process safety (daemon node:sqlite + app better-sqlite3 both writing the WAL DB) was
// proven in the Phase-2 Step-4 spike (scripts/spike-write-contention.js).

const path = require("path");
const crypto = require("crypto");
const { logMutation, serializePayload } = require(path.join(__dirname, "..", "electron", "sync", "mutation-writer"));

// Mirrors src/db/client.ts logPlay → play_log:create. db must be a read-WRITE node:sqlite
// DatabaseSync handle. Returns the new row uuid, or null on failure (logging never throws
// into the playout path — a logging error must not interrupt audio).
function logPlay(db, { stationId, title, artist, deck, durationMs, sessionId, filePath }) {
  if (!db || stationId == null || !title) return null;
  const now = new Date().toISOString();
  const uuid = crypto.randomUUID();
  const row = {
    title, artist: artist || "", deck, deck_id: deck,
    duration_ms: durationMs ?? null,
    session_id: sessionId ?? null,
    played_at: Math.floor(Date.now() / 1000),   // explicit — the DEFAULT unixepoch() never fires on the synced insert
    scheduled_log_id: null, show_name: null, category_code: null, programming_row_id: null,
    station_id: stationId, uuid, created_at: now, updated_at: now, deleted_at: null,
    file_path: filePath || null,   // v19: the audio that aired — affidavit join key
  };
  let payloadAfter;
  try { payloadAfter = serializePayload(row, "play_log"); }
  catch (e) { console.error("[audiod/playlog] serialize failed:", e.message); return null; }

  // Manual transaction (node:sqlite has no db.transaction()): row insert + mutation atomically.
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO play_log (title, artist, deck, deck_id, duration_ms, session_id, played_at, scheduled_log_id, show_name, category_code, station_id, uuid, created_at, updated_at, deleted_at, programming_row_id, file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(row.title, row.artist, row.deck, row.deck_id, row.duration_ms, row.session_id, row.played_at, row.scheduled_log_id, row.show_name, row.category_code, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at, row.programming_row_id, row.file_path);
      logMutation(db, { table_name: "play_log", row_id: uuid, op: "insert", payload_before: null, payload_after: payloadAfter, station_id: stationId, actor_id: null });
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  } catch (e) { console.error("[audiod/playlog] write failed:", e.message); return null; }
  return uuid;
}

module.exports = { logPlay };
