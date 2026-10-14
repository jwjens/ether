// electron/startup-heavy.js — THE HEAVY STARTUP WORK, AFTER THE WINDOW, OFF MAIN (Jeff, 2026-10-13; docs/air-machine-stalls-
// plan-2026-10-13.md §2: "never build the sync index or run heavy migrations on the main process while the window waits.
// Window first, then do it in the background.").
//
// ovowforestmusic froze ~68 s at startup: ensurePushPendingIndex ~18 s and runMigrations ~12 s on main, before the window.
// These steps used to run inside runMigrations(). They are the same SQL, now run by electron/startup-heavy-worker.js on its
// own thread and its own connection, started once the window is on screen. Each is idempotent (IF NOT EXISTS / a WHERE
// that matches nothing once done), so a step cut short by a quit simply runs again next launch.
//
// AN INDEX IS BUILT ONLY IF IT IS MISSING, AND ONLY IN SILENCE. A build holds SQLite's write lock for its whole length.
// Measured on a copy of ovowforestmusic's size with playout writes running: the push index took 11.7 s, and the engine's
// and the app's writes waited their full 5 s and FAILED. So a step whose index already exists does nothing (the normal
// case on every machine that has run a build since 2026-10-12), and a step that must build waits for 15 s with nothing
// on air first — the same gate as the automatic sync cleanup. Every step is timed and reported.
"use strict";

/** The steps, in order. `name` is what the boot report and the health log say. */
function heavySteps() {
  return [
    {
      // The sync push's partial index — only the pending mutations a push can send (sync-engine.js). Until it exists the
      // push uses the plain query when the queue is small, and WAITS when it is huge (sync-engine PUSH_WAIT_OVER).
      name: "sync push index",
      needed: (db) => !hasIndex(db, require("./sync/sync-engine").PUSH_PENDING_INDEX),
      needsSilence: true,
      run: (db) => require("./sync/sync-engine").ensurePushPendingIndex(db),
    },
    {
      // generated_schedule(station_id, scheduled_at) — the runway's index (docs/perf-pass-round2-2026-10-12.md §2).
      name: "generated log index",
      needed: (db) => !hasIndex(db, "idx_gensched_station_at"),
      needsSilence: true,
      run: (db) => db.exec("CREATE INDEX IF NOT EXISTS idx_gensched_station_at ON generated_schedule(station_id, scheduled_at)"),
    },
    {
      // play_log(file_path, station_id, played_at) — the least-recently-played lookups' index
      // (docs/generate-freeze-and-calendar-history-2026-08-06.md §8).
      name: "play log index",
      needed: (db) => !hasIndex(db, "idx_play_log_file_station"),
      needsSilence: true,
      run: (db) => db.exec("CREATE INDEX IF NOT EXISTS idx_play_log_file_station ON play_log(file_path, station_id, played_at)"),
    },
    {
      // Songs eligible in no daytime hour (daypart_mask 127 = the old default, NULL = from a synced/restored library) →
      // all 24 hours, so Generate always has candidates (see _generateDayRows).
      name: "songs: eligible hours",
      // Small (12 ms on 2026-10-13's copy): touches only the rows that need it; no wait for silence.
      needed: () => true,
      needsSilence: false,
      run: (db) => db.prepare("UPDATE songs SET daypart_mask = 16777215 WHERE daypart_mask = 127 OR daypart_mask IS NULL").run(),
    },
  ];
}

function hasIndex(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
}

/** Run every step on `db`, timing each. Never throws: a failed step is reported and the next one runs.
 *  waitSilence() blocks until nothing has been on air for the quiet spell and returns the ms it waited. */
function runHeavySteps(db, { onStep = () => {}, now = () => Date.now(), waitSilence = () => 0 } = {}) {
  const report = [];
  for (const s of heavySteps()) {
    let need = true;
    try { need = s.needed(db); } catch { need = true; }
    if (!need) {
      const r = { name: s.name, ms: 0, skipped: "already there", error: null };
      report.push(r);
      try { onStep(r); } catch { /* reporting */ }
      continue;
    }
    const waitedMs = s.needsSilence ? (waitSilence() || 0) : 0;
    const t0 = now();
    let error = null;
    try { s.run(db); } catch (e) { error = (e && e.message) || String(e); }
    const r = { name: s.name, ms: now() - t0, waitedMs, error };
    report.push(r);
    try { onStep(r); } catch { /* reporting never stops the work */ }
  }
  return report;
}

module.exports = { heavySteps, runHeavySteps, hasIndex };
