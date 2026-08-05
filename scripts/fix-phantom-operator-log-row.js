'use strict';
// Neutralise the phantom operator log row written by a CART fire (2026-08-04).
//
// WHAT HAPPENED (proven, docs/hand-load-log-design-2026-08-04.md):
//   generated_schedule id 190000, station 2, 2026-08-05 00:46:02 carries the CART's exact title
//   ("Adele   Someone Like You 68", triple space) and the CART's file path, stamped
//   source='operator', content_class='MUSIC', state='pending'. Log-reader flip is ON for every
//   station, and a 'pending' row at the playhead is what the reader AIRS. So a cart fire produced an
//   airable music row. Adele is a cart only — there is no library song by that name.
//
// WHAT THIS DOES: soft-deletes that ONE row (deleted_at), which every loggen query already filters on
// (`AND gs.deleted_at IS NULL`). It is a defect artifact, not a programming decision, so it should not
// remain in the airable log NOR be silently rewritten into a fake "played" event.
//
// SAFETY:
//   • Read-only survey by default. Pass --apply to write.
//   • The write is GUARDED: it only touches a row that still matches id + station + source +
//     state='pending' + the exact file path. Anything else and it aborts having changed nothing.
//   • Run on a COPY first and verify (standing rule). Run on the live DB ONLY with Ether fully
//     closed — the app and daemon hold it open, and an external write to a live SQLite file is how
//     you corrupt it.
//
// Usage:
//   ...electron.exe scripts/fix-phantom-operator-log-row.js <db>            # survey only
//   ...electron.exe scripts/fix-phantom-operator-log-row.js <db> --apply    # write

const TARGET_ID = 190000;
const TARGET_STATION = 2;
const TARGET_PATH = 'C:\\Users\\jensj\\Music\\Adele - Someone Like You 68.mp3';

const path = require('path');
const os = require('os');
const APPLY = process.argv.includes('--apply');
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const dbPath = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(dbPath, { readonly: !APPLY });

console.log('=== fix-phantom-operator-log-row.js ===');
console.log('DB:', dbPath);
console.log('MODE:', APPLY ? 'APPLY (writing)' : 'SURVEY ONLY (read-only)');

const row = db.prepare(
  `SELECT id, station_id, datetime(scheduled_at,'unixepoch') AS at_utc, title, source, state,
          content_class, file_path, deleted_at
     FROM generated_schedule WHERE id = ?`).get(TARGET_ID);

console.log('\n── The target row ──');
console.log(row ? JSON.stringify(row, null, 2) : '  NOT FOUND');

// ── Survey: are there OTHER operator rows whose file is a cart or a spot, not a library song? ──
console.log('\n── Every source=operator row whose file is a CART or a SPOT (mis-stamped MUSIC) ──');
const suspects = db.prepare(`
  SELECT gs.id, gs.station_id, datetime(gs.scheduled_at,'unixepoch') AS at_utc, gs.title,
         gs.state, gs.content_class, gs.file_path,
         (SELECT 1 FROM cart_slots cs WHERE cs.file_path = gs.file_path LIMIT 1) AS is_cart,
         (SELECT 1 FROM spots sp WHERE sp.file_path = gs.file_path AND sp.deleted_at IS NULL LIMIT 1) AS is_spot
    FROM generated_schedule gs
   WHERE gs.source = 'operator' AND gs.deleted_at IS NULL
     AND ( (SELECT 1 FROM cart_slots cs WHERE cs.file_path = gs.file_path LIMIT 1) IS NOT NULL
        OR (SELECT 1 FROM spots sp WHERE sp.file_path = gs.file_path AND sp.deleted_at IS NULL LIMIT 1) IS NOT NULL )
   ORDER BY gs.id DESC`).all();
if (!suspects.length) console.log('  none besides the target (if the target is listed above)');
for (const r of suspects) {
  console.log(`  id=${r.id} s${r.station_id} ${r.at_utc} state=${r.state} class=${r.content_class} ` +
              `${r.is_cart ? 'CART' : ''}${r.is_spot ? 'SPOT' : ''} "${r.title}"`);
}
const airable = suspects.filter(r => r.state === 'pending');
console.log(`\n  → of those, AIRABLE (state='pending'): ${airable.length}` +
            (airable.length ? `  [ids: ${airable.map(r => r.id).join(', ')}]` : ''));

if (!APPLY) {
  console.log('\nSurvey complete. No changes made. Re-run with --apply (Ether CLOSED) to neutralise.');
  db.close();
  process.exit(0);
}

// ── Guarded write ──
if (!row) { console.error('\nABORT: target row no longer exists. Nothing changed.'); db.close(); process.exit(1); }
if (row.station_id !== TARGET_STATION) { console.error(`\nABORT: station is ${row.station_id}, expected ${TARGET_STATION}.`); db.close(); process.exit(1); }
if (row.source !== 'operator')         { console.error(`\nABORT: source is '${row.source}', expected 'operator'.`); db.close(); process.exit(1); }
if (row.file_path !== TARGET_PATH)     { console.error(`\nABORT: file_path does not match the cart's file.`); db.close(); process.exit(1); }
if (row.deleted_at)                    { console.log('\nAlready soft-deleted — nothing to do.'); db.close(); process.exit(0); }
if (row.state !== 'pending')           { console.log(`\nRow is state='${row.state}', not airable. Leaving it alone.`); db.close(); process.exit(0); }

const iso = new Date().toISOString();
const info = db.prepare(
  `UPDATE generated_schedule SET deleted_at = ?, updated_at = ?
    WHERE id = ? AND station_id = ? AND source = 'operator' AND state = 'pending'
      AND file_path = ? AND deleted_at IS NULL`
).run(iso, iso, TARGET_ID, TARGET_STATION, TARGET_PATH);

console.log(`\nrows updated: ${info.changes}`);

const after = db.prepare(
  `SELECT id, state, deleted_at FROM generated_schedule WHERE id = ?`).get(TARGET_ID);
console.log('after:', JSON.stringify(after));

let pass = info.changes === 1 && !!after.deleted_at;
const stillAirable = db.prepare(
  `SELECT COUNT(*) c FROM generated_schedule
    WHERE id = ? AND state = 'pending' AND deleted_at IS NULL`).get(TARGET_ID).c;
console.log(`[${stillAirable === 0 ? 'PASS' : 'FAIL'}] the row is no longer airable — pending+undeleted count: ${stillAirable}`);
if (stillAirable !== 0) pass = false;

db.close();
if (!pass) { console.error('\nVerification FAILED.'); process.exit(1); }
console.log('\nDone — the phantom row can no longer air.');
