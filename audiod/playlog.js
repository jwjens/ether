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

// THIS machine's id: client_identity.client_id, which main forces to the stable machine-id on every boot (the same
// lookup ether-audiod.js linkThisMachine uses). Read once per handle; null if the table is absent (an old fixture).
const _machineIds = new WeakMap();
function machineIdOf(db) {
  if (_machineIds.has(db)) return _machineIds.get(db);
  let id = null;
  try { const r = db.prepare("SELECT client_id FROM client_identity LIMIT 1").get(); id = r && r.client_id ? String(r.client_id).toLowerCase() : null; } catch {}
  _machineIds.set(db, id);
  return id;
}

// content_class (jingles design 1b): stamp every play so reporting/affidavit can exclude non-MUSIC.
// Prefer the caller's hint; else derive from the library (the song's class), else spot, else MUSIC.
function _classify(db, filePath, stationId, contentClass) {
  let content_class = contentClass || null;
  if (!content_class && filePath) {
    try {
      // NO station_id ON songs, and that predicate is what broke this whole classifier (2026-08-26).
      // songs went INSTALL-scoped in the Phase-4 library architecture (Direction C), so this query
      // threw `no such column: station_id` on every call, the catch below swallowed it, THE SPOTS
      // BRANCH WAS NEVER REACHED, and everything fell through to MUSIC.
      //
      // Measured on the live install before the fix: play_log held MUSIC 35,826 / JIN 14,073 / ANN 7
      // and ZERO SPOT rows — every commercial ever aired was logged as music. JIN and ANN were
      // unaffected only because their callers pass contentClass explicitly and never reach here; the
      // rotation-deck path (engine._fireStart), which is the path spots actually air on, is the one
      // that depends on this.
      //
      // A song's class is a property of the FILE, not of a station, so there was never anything for
      // station_id to scope here.
      const s = db.prepare("SELECT content_class FROM songs WHERE file_path = ? AND deleted_at IS NULL LIMIT 1").get(filePath);
      if (s && s.content_class) content_class = s.content_class;
      else if (db.prepare("SELECT 1 FROM spots WHERE file_path = ? AND station_id = ? AND deleted_at IS NULL LIMIT 1").get(filePath, stationId)) content_class = "SPOT";
    } catch { /* logging must never throw into playout */ }
  }
  return content_class || "MUSIC";
}

function _playRow(db, { stationId, title, artist, deck, durationMs, sessionId, filePath, contentClass, source, rowUuid, categoryCode, playedAt }) {
  const now = new Date().toISOString();
  return {
    title, artist: artist || "", deck, deck_id: deck,
    duration_ms: durationMs ?? null,
    session_id: sessionId ?? null,
    played_at: playedAt ?? Math.floor(Date.now() / 1000),   // explicit — the DEFAULT unixepoch() never fires on the synced insert
    scheduled_log_id: null, show_name: null, category_code: categoryCode ?? null, programming_row_id: null,
    station_id: stationId, uuid: crypto.randomUUID(), created_at: now, updated_at: now, deleted_at: null,
    file_path: filePath || null,   // v19: the audio that aired — affidavit join key
    content_class: _classify(db, filePath, stationId, contentClass),   // jingles design 1b — MUSIC/JIN/SPOT
    source: source || null,        // v39: 'jukebox' | 'announcement' | null — honest history, never a playout input
    row_uuid: rowUuid || null,     // v63: the schedule row this play fulfils
    machine_id: machineIdOf(db),   // v63: the machine that aired it
  };
}

// v63 columns are written only where the table has them (a pre-v63 fixture or a half-migrated copy keeps working).
const _hasV63 = new WeakMap();
function hasRecordColumns(db) {
  if (_hasV63.has(db)) return _hasV63.get(db);
  let ok = false;
  try { const c = new Set(db.prepare("PRAGMA table_info(play_log)").all().map(r => r.name)); ok = c.has("row_uuid") && c.has("machine_id"); } catch {}
  _hasV63.set(db, ok);
  return ok;
}

// The insert + its sync mutation + spot accounting. Runs INSIDE the caller's transaction.
function _insertPlay(db, row) {
  const payloadAfter = serializePayload(row, "play_log");
  const v63 = hasRecordColumns(db);
  db.prepare(
    `INSERT INTO play_log (title, artist, deck, deck_id, duration_ms, session_id, played_at, scheduled_log_id, show_name, category_code, station_id, uuid, created_at, updated_at, deleted_at, programming_row_id, file_path, content_class, source${v63 ? ", row_uuid, machine_id" : ""})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${v63 ? ", ?, ?" : ""})`
  ).run(row.title, row.artist, row.deck, row.deck_id, row.duration_ms, row.session_id, row.played_at, row.scheduled_log_id, row.show_name, row.category_code, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at, row.programming_row_id, row.file_path, row.content_class, row.source, ...(v63 ? [row.row_uuid, row.machine_id] : []));
  // Spot accounting: count the spin if the aired file is a spot (no-op for songs).
  if (row.file_path) {
    db.prepare(`UPDATE spots SET play_count = play_count + 1, last_played_at = unixepoch(), updated_at = ? WHERE file_path = ? AND station_id = ? AND deleted_at IS NULL`).run(row.updated_at, row.file_path, row.station_id);
  }
  logMutation(db, { table_name: "play_log", row_id: row.uuid, op: "insert", payload_before: null, payload_after: payloadAfter, station_id: row.station_id, actor_id: null });
}

function _tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

// Mirrors src/db/client.ts logPlay → play_log:create. db must be a read-WRITE node:sqlite
// DatabaseSync handle. Returns the new row uuid, or null on failure (logging never throws
// into the playout path — a logging error must not interrupt audio).
// `source` (v39) marks WHICH SOURCE aired the row: null/undefined = ordinary playout, 'jukebox' = the
// jukebox deck source. History only — nothing reads it to make a playout decision.
// A play with no schedule row (jukebox, an operator's own load) goes through here; a play that fulfils a row
// goes through recordGoLive below, so its row is stamped in the same transaction.
function logPlay(db, args) {
  if (!db || !args || args.stationId == null || !args.title) return null;
  let row;
  try { row = _playRow(db, args); }
  catch (e) { console.error("[audiod/playlog] serialize failed:", e.message); return null; }
  // Manual transaction (node:sqlite has no db.transaction()): row insert + mutation atomically.
  try { _tx(db, () => _insertPlay(db, row)); }
  catch (e) { console.error("[audiod/playlog] write failed:", e.message); return null; }
  return row.uuid;
}

// ── WHAT AIRED IS THE RECORD (design §3.9, Phase 1) ───────────────────────────────────────────────────────────────
// A deck goes live with a schedule row: in ONE transaction,
//   - the play is written with that row's uuid, its category, its content class, this machine and the session;
//   - the row is stamped 'playing' with the second it went live, and the station's previous 'playing' row 'played'.
// Either both land or neither does. The row is read inside the transaction, so the answer about it is the truth at
// that second:
//   repeat: true  — the row had ALREADY aired (state not 'pending'). The play is still written (it did air: the record
//                   must say so) but the row is not re-stamped; the caller raises `row-aired-twice`.
//   retired       — the row had been stamped 'missed' (or 'skipped') and then aired anyway. The play is written and
//                   linked; the retired row is not rewritten (the trigger would rightly call that a change to the
//                   record); the caller reports it.
//   missingRow    — the row id is not in this station's log (deleted, or never there). The play is written with no
//                   link; the caller reports it.
// rowId null = a deck went live with something that is not a log row: written as an unlinked play, and the
// station's playing row is retired to 'played' (the playhead has moved on).
// Returns { ok, playUuid, rowUuid, repeat, missingRow, error } and never throws.
function recordGoLive(db, args) {
  const out = { ok: false, playUuid: null, rowUuid: null, repeat: false, retired: null, missingRow: false, error: null };
  if (!db || !args || args.stationId == null || !args.title) { out.error = "nothing to record"; return out; }
  const at = args.playedAt ?? Math.floor(Date.now() / 1000);
  try {
    _tx(db, () => {
      let rowUuid = null, categoryCode = args.categoryCode ?? null, contentClass = args.contentClass || null;
      if (args.rowId != null) {
        const r = db.prepare(
          `SELECT gs.uuid, gs.state, gs.content_class, c.code AS category_code
             FROM generated_schedule gs LEFT JOIN categories c ON c.id = gs.category_id
            WHERE gs.id = ? AND gs.station_id = ?`).get(args.rowId, args.stationId);
        if (!r) out.missingRow = true;
        else {
          rowUuid = r.uuid || null;
          if (categoryCode == null) categoryCode = r.category_code ?? null;
          if (!contentClass && r.content_class) contentClass = r.content_class;
          if (r.state === "played" || r.state === "playing") out.repeat = true;          // it had already aired
          else if (r.state && r.state !== "pending") out.retired = r.state;               // missed / skipped, and it aired
        }
      }
      const row = _playRow(db, { ...args, playedAt: at, rowUuid, categoryCode, contentClass });
      _insertPlay(db, row);
      out.playUuid = row.uuid; out.rowUuid = rowUuid;
      if (args.overlay) {
        // A sweeper/jingle over a seam: its own row is stamped 'played' at the second it fired. It is never the
        // playhead (the music row on air stays 'playing').
        if (args.rowId != null && !out.repeat && !out.retired && !out.missingRow) {
          db.prepare("UPDATE generated_schedule SET state='played', played_at=? WHERE id=? AND station_id=? AND state='pending'").run(at, args.rowId, args.stationId);
        }
        return;
      }
      if (args.rowId != null && !out.repeat && !out.retired && !out.missingRow) {
        db.prepare("UPDATE generated_schedule SET state='played' WHERE station_id=? AND state='playing' AND id!=?").run(args.stationId, args.rowId);
        db.prepare("UPDATE generated_schedule SET state='playing', played_at=? WHERE id=? AND station_id=? AND state='pending'").run(at, args.rowId, args.stationId);
      } else {
        // Off-log, a repeat, or a row that is gone: the playhead moved on, so the previous playing row is done.
        db.prepare("UPDATE generated_schedule SET state='played' WHERE station_id=? AND state='playing'" + (out.repeat && args.rowId != null ? " AND id!=?" : "")).run(...(out.repeat && args.rowId != null ? [args.stationId, args.rowId] : [args.stationId]));
      }
    });
    out.ok = true;
  } catch (e) { out.error = String((e && e.message) || e); }
  return out;
}

module.exports = { logPlay, recordGoLive, machineIdOf, hasRecordColumns };
