'use strict';
// Migration v34 — `source` provenance on generated_schedule (Log-Reader Flip, Phase 3 activation).
// Design: docs/log-reader-single-source-playout-design-2026-07-20.md (§2.5 operator writes; §7 Phase 4).
//
// ADDITIVE + INERT until the flip reads it. Adds:
//   • source TEXT   — row provenance: NULL/'machine' = Generate-placed, 'operator' = a jock deck-load
//                     wrote this row at the playhead (§2.5), 'autofit' = the future auto-fitter. Lets the
//                     calendar/UI mark operator inserts and lets the flip stamp what it places.
//
// SYNC (§5, load-bearing): `source` is LOCAL-AUTHORITATIVE playout state — same treatment as the v33
// lifecycle columns (state/played_at/seq). Registered 'local-only' in synced-tables.js so
// serializePayload never puts it in an outbound payload; the payloadTransformer below strips it INBOUND
// so a remote/legacy peer can never write this machine's provenance. Plan columns stay synced.
//
// Idempotent: adds only the missing column. Verify on a COPY first:
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-generated-schedule-source-phase-sync-34.js <copy.db>

function hasCol(db, t, col) {
  try { return db.prepare(`PRAGMA table_info("${t}")`).all().some(c => c.name === col); } catch { return false; }
}
function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function isAlreadyMigrated(db) { return hasCol(db, 'generated_schedule', 'source'); }

function applyMigration(db) {
  const migrate = db.transaction(() => {
    let added = 0;
    if (tableExists(db, 'generated_schedule')) {
      if (!hasCol(db, 'generated_schedule', 'source')) {
        db.prepare("ALTER TABLE generated_schedule ADD COLUMN source TEXT").run();   // NULL = machine-generated
        added++;
      }
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (34)').run(); } catch { /* already recorded */ }
    console.log(`[migrate-v34] generated_schedule.source provenance: +${added} column(s).`);
  });
  migrate();
  console.log('[migrate-v34] Transaction committed.');
}

module.exports = {
  // `source` is LOCAL-ONLY (§5): serializePayload already excludes it outbound (registry entry). This
  // enforces the same INBOUND — strip `source` from any incoming sync payload so a remote write can never
  // clobber this machine's provenance. Chains after the v33 transformer (which strips state/played_at/seq).
  payloadTransformer: function payloadTransformer(payload) {
    if (payload && typeof payload === 'object') {
      delete payload.source;
    }
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-generated-schedule-source-phase-sync-34.js ===');
  console.log('DB:', dbPath, isAlreadyMigrated(db) ? '(already migrated — will no-op the ALTER)' : '');
  const versions0 = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  console.log('current schema_version:', versions0.length ? Math.max(...versions0) : '(none)');
  const before = db.prepare("SELECT COUNT(*) c FROM generated_schedule").get().c;
  console.log('generated_schedule rows:', before);

  applyMigration(db);

  console.log('\n=== Post-verification ===');
  let allPass = true;
  const check = (label, pass, detail) => { console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); if (!pass) allPass = false; };
  const newVersion = Math.max(...db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version));
  check('schema_version = 34', newVersion === 34, `got ${newVersion}`);
  check('generated_schedule.source exists', hasCol(db, 'generated_schedule', 'source'));
  const total = db.prepare("SELECT COUNT(*) c FROM generated_schedule").get().c;
  check('row count unchanged (additive only)', total === before, `before ${before}, after ${total}`);
  // transformer strips source inbound
  const t = module.exports.payloadTransformer({ id: 1, source: 'operator', title: 'x' });
  check('payloadTransformer strips source inbound', !('source' in t), JSON.stringify(t));

  db.close();
  if (!allPass) { console.error('\nOne or more post-verification checks FAILED.'); process.exit(1); }
  console.log('\nAll checks PASSED — migration v34 complete.');
}
