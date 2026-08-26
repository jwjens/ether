'use strict';
// Migration v48 — announcement schedule entries become DATE-KEYED, and the weekday concept is gone.
//
// Jeff's ruling, 2026-08-26: "No weekday/recurring concept at all — delete it. Everything is
// DATE-BASED on the calendar." An entry is now one (announcement, time) on ONE specific calendar
// date. Selecting several dates and adding a line writes one row per date.
//
// WHAT THIS DOES TO EXISTING ROWS. v47 backfilled every announcement into a scope='weekday' entry
// carrying a day-set. Those rows can never fire once the scheduler stops reading weekday scope, so
// leaving them would silently strand a working schedule — the exact failure this arc has been
// avoiding. Each one is converted to a scope='date' row on THE NEXT OCCURRENCE of its first
// weekday, counting from the day the migration runs.
//
// WHY THE NEXT OCCURRENCE AND NOT A SEASON OF THEM. "Every Wednesday" has no end, so expanding it
// into dates means inventing a horizon — how many Wednesdays? — and inventing schedule data is
// worse than moving it. One concrete date keeps the announcement, the time and the operator's
// intent visible and editable; multi-selecting more dates in the panel takes seconds. Nothing is
// invented and nothing is lost.
//
// A row that already has scope='date' is left exactly as it is.
//
// The `days` column stays on the table. It is unused from here, and it is cheaper to leave a dead
// column than to rewrite a synced table's shape for tidiness.
//
// Idempotent: it only converts rows still holding scope='weekday'.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-announcement-dates-phase-sync-48.js <copy.db>

const TABLE = 'announcement_schedule';

/** 'YYYY-MM-DD' of the next date on or after `from` whose weekday is `dow`. LOCAL dates throughout —
 *  a calendar date is not an instant, and UTC would name the wrong day for an evening announcement. */
function nextOccurrence(from, dow) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const delta = (dow - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + delta);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function tableExists(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
}

function isAlreadyMigrated(db) {
  if (!tableExists(db)) return true;   // nothing to convert
  const n = db.prepare(`SELECT COUNT(*) n FROM ${TABLE} WHERE scope = 'weekday' AND deleted_at IS NULL`).get().n;
  return n === 0;
}

function applyMigration(db) {
  if (!tableExists(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (48)').run(); } catch (e) { /* recorded */ }
    console.log('[migrate-v48] announcement_schedule absent — nothing to convert.');
    return;
  }
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (48)').run(); } catch (e) { /* recorded */ }
    console.log('[migrate-v48] SKIP — no weekday-scoped entries remain');
    return;
  }

  const migrate = db.transaction(() => {
    const rows = db.prepare(
      `SELECT uuid, days, trigger_time FROM ${TABLE} WHERE scope = 'weekday' AND deleted_at IS NULL`
    ).all();
    const now  = new Date();
    const iso  = now.toISOString();
    const upd  = db.prepare(`UPDATE ${TABLE} SET scope = 'date', date = ?, updated_at = ? WHERE uuid = ?`);

    let moved = 0;
    for (const r of rows) {
      // The FIRST day in the set. A '56' (Fri+Sat) entry becomes one date, the next Friday — the
      // operator adds the Saturday back by selecting it, which is one click and is honest about
      // what was known.
      const first = String(r.days || '').split('').map(Number).filter(n => n >= 0 && n <= 6).sort()[0];
      const dow   = Number.isInteger(first) ? first : now.getDay();
      const date  = nextOccurrence(now, dow);
      upd.run(date, iso, r.uuid);
      console.log(`[migrate-v48]   "${r.trigger_time || '(no time)'}" days=${r.days} → ${date}`);
      moved++;
    }
    console.log(`[migrate-v48] converted ${moved} weekday entr${moved === 1 ? 'y' : 'ies'} to specific dates`);
    db.prepare('INSERT INTO schema_version (version) VALUES (48)').run();
  });
  migrate();
  console.log('[migrate-v48] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // A v47 payload carrying scope='weekday' would be applied by a v48 peer that no longer reads it.
    // Carried forward the same way the migration does, so an in-flight mutation does not land as a
    // row that can never fire.
    try {
      if (payload && payload.scope === 'weekday') {
        const first = String(payload.days || '').split('').map(Number).filter(n => n >= 0 && n <= 6).sort()[0];
        const now   = new Date();
        payload.scope = 'date';
        payload.date  = nextOccurrence(now, Number.isInteger(first) ? first : now.getDay());
      }
    } catch { /* a transformer must never throw the chain */ }
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

  console.log('=== migrate-announcement-dates-phase-sync-48.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
