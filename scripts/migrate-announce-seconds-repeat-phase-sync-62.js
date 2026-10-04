'use strict';
// Migration v62 — announcement_schedule.close_offset_sec and announcement_schedule.play_count.
//
// Jeff, 2026-10-04: the top-of-hour announcement and the legal ID played over each other, and a "before
// closing" line could only move in whole minutes — "all i can choose is minutes". close_offset_sec adds the
// seconds (electron/announce-time.js offsetDueTime: they take the minutes' sign).
//
// Same day: "an option on each announcement row next to the minute to select how many times to play in a
// row" — play_count, 1 = play once, which is what every existing row has always done.
//
// SHAPE: two INTEGER columns with DEFAULTs that reproduce today's behaviour exactly (0 seconds, 1 play), so
// every existing row fires as it always has. Both SYNC (synced-tables.js): they are part of what the
// operator programmed, like close_offset_min beside them. A pre-v62 peer reads only the columns its own
// registry lists (mutation-writer deserializePayload), so it ignores these. A pre-v62 payload arriving here is
// passed through UNCHANGED (see the transformer): inserts take the column defaults, updates keep local values.
// AND NOTE: any mutation stamped v62 is QUARANTINED by a v61 peer (merge-engine.js:127) until it upgrades —
// every table, not just this one. Ship v62 to the whole fleet together.
//
// Additive and idempotent — ALTER TABLE guarded by column checks, no table rewrite, no data touched.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-announce-seconds-repeat-phase-sync-62.js <copy.db>

const TABLE = 'announcement_schedule';
const VERSION = 62;
const COLUMNS = [
  { name: 'close_offset_sec', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'play_count',       ddl: 'INTEGER NOT NULL DEFAULT 1' },
];

function tableExists(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
}

function missingColumns(db) {
  if (!tableExists(db)) return [];
  let have;
  try { have = new Set(db.prepare(`PRAGMA table_info(${TABLE})`).all().map(c => c.name)); }
  catch { return []; }
  return COLUMNS.filter(c => !have.has(c.name));
}

function applyMigration(db) {
  const already = db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION);
  // A missing table is v47's failure to report, not this one's; keep the chain contiguous.
  const missing = missingColumns(db);
  if (missing.length === 0) {
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
    console.log('[migrate-v62] close_offset_sec / play_count already present (or table absent) — nothing to do');
    return;
  }
  if (already) console.log('[migrate-v62] version recorded but columns missing — repairing');

  const migrate = db.transaction(() => {
    for (const c of missing) db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN ${c.name} ${c.ddl}`).run();
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  });
  migrate();
  console.log('[migrate-v62] added announcement_schedule.' + missing.map(c => c.name).join(', '));
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // ADDS NOTHING, deliberately (fixed 2026-10-04 after a proof on a DB copy). A pre-v62 peer's payload has
    // neither field, and ABSENT is the right thing to deliver: the apply path writes only the keys present, so
    //   • an INSERT gets the column DEFAULTs (0 seconds, play once) from the table itself, and
    //   • an UPDATE leaves this machine's seconds / play count exactly as they were.
    // An earlier draft filled the defaults in here — and then an old peer's edit to a line's MINUTES silently
    // reset its seconds and ×N to 0 / ×1 (measured: 35 s ×3 → 0 s ×1). A transformer must still exist: the
    // chain dead-letters a version with no script.
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');

  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-announce-seconds-repeat-phase-sync-62.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
