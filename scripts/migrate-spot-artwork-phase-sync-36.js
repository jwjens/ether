'use strict';
// Migration v36 — spots.art_image: a manual artwork override for a spot.
//
// Cause (docs/spot-artwork-override-design-2026-08-04.md):
//   Spots had no artwork field at all, and the automatic sources produce wrong art for a
//   commercial. This column is the operator's own image, chosen per spot.
//
// STORAGE — a base64 data URL in the row, following the pattern the station logo already uses:
//   station_config_kv.station_logo holds `data:image/png;base64,…` (37,766 bytes in the live DB),
//   written by electron/main.js:5586 (picker → fs.readFileSync → data URL) and stored by
//   SettingsPanel.tsx:245. That upload path makes NO network call of any kind. Spot artwork
//   follows it exactly: the bytes land in the local SQLite row and nothing is uploaded.
//
//   Column name is art_image, not art_path, because the value IS the image, not a path to one.
//
// Songs and jingles are deliberately NOT the pattern here: they store no artwork at all
// (the songs table has no artwork column), resolving embedded-cover → iTunes at play time, both
// in-memory only. That is DERIVED artwork. This is OPERATOR-SUPPLIED artwork, which in this
// codebase means the station-logo pattern.
//
// KNOWN PROPERTY, not a defect: `spots` is a synced table (electron/sync/synced-tables.js:48), so
// this column is eligible to replicate like every other spots column when sync is enabled. There
// is no way to put an image in a DB row and have it be categorically un-syncable. Same property
// the station logo already has (station_config_kv is synced too, synced-tables.js:49).
//
// Idempotent: if spots.art_image already exists, just records v36 and returns.
//
// Verified on a COPY before any live run. The live DB is migrated BY THE APP at startup
// (electron/main.js:1120-1130 auto-discovers migrate-*-phase-sync-N.js and calls applyMigration)
// — never by running this script against the live file while Ether is open.

const COLUMN = 'art_image';

function spotsCols(db) {
  try { return db.prepare('PRAGMA table_info(spots)').all().map(c => c.name); } catch { return []; }
}

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}

function isAlreadyMigrated(db) {
  return spotsCols(db).includes(COLUMN);
}

function applyMigration(db) {
  if (!tableExists(db, 'spots')) {
    console.log('[migrate-v36] spots table does not exist — nothing to add.');
    try { db.prepare('INSERT INTO schema_version (version) VALUES (36)').run(); } catch { /* recorded */ }
    return;
  }
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (36)').run(); } catch { /* recorded */ }
    console.log(`[migrate-v36] SKIP — spots.${COLUMN} already exists`);
    return;
  }
  const migrate = db.transaction(() => {
    // Nullable TEXT, no default: NULL means "no override", which is every existing spot. Adding a
    // nullable column to a populated table rewrites no rows and cannot lose data.
    db.prepare(`ALTER TABLE spots ADD COLUMN ${COLUMN} TEXT`).run();
    db.prepare('INSERT INTO schema_version (version) VALUES (36)').run();
  });
  migrate();
  console.log(`[migrate-v36] Transaction committed — spots.${COLUMN} added.`);
}

module.exports = {
  // Every phase-sync migration must export a payloadTransformer — the chain applies each version's
  // transformer in order to bring an older peer's payload up to this schema
  // (electron/sync/transformer-chain.js).
  //
  // v36 ADDS one nullable column and changes nothing else. A spots payload from a v35 peer is
  // already shape-correct; art_image simply arrives absent and reads as NULL (no override), which
  // is the correct meaning for a peer that never had the field.
  payloadTransformer: function payloadTransformer(payload) {
    return payload;
  },
  applyMigration,
  isAlreadyMigrated,
  COLUMN,
};

if (require.main === module) {
  const path = require('path');
  const os = require('os');
  // LocalAppData, matching the app (CLAUDE.md: Roaming is redirected to a network share on managed
  // boxes like OV, where SQLite WAL fails). Pass a path argument to run against a COPY.
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-spot-artwork-phase-sync-36.js ===');
  console.log('DB:', dbPath, isAlreadyMigrated(db) ? '(already migrated — will no-op)' : '');

  const versions0 = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  console.log('current schema_version:', versions0.length ? Math.max(...versions0) : '(none)');

  // Snapshot BEFORE — row count and every existing column, so "nothing else changed" is provable.
  const rowsBefore = tableExists(db, 'spots') ? db.prepare('SELECT COUNT(*) c FROM spots').get().c : 0;
  const colsBefore = spotsCols(db);
  console.log(`spots rows before: ${rowsBefore}`);
  console.log('spots columns before:', colsBefore.join(', '));

  const snapBefore = tableExists(db, 'spots')
    ? db.prepare(`SELECT ${colsBefore.map(c => `"${c}"`).join(', ')} FROM spots ORDER BY id`).all()
    : [];

  applyMigration(db);

  console.log('\n=== Post-verification ===');
  let allPass = true;
  const check = (label, pass, detail) => {
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
    if (!pass) allPass = false;
  };

  const newVersion = Math.max(...db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version));
  check('schema_version = 36', newVersion === 36, `got ${newVersion}`);

  const colsAfter = spotsCols(db);
  check(`spots.${COLUMN} column exists`, colsAfter.includes(COLUMN));

  const info = db.prepare('PRAGMA table_info(spots)').all().find(c => c.name === COLUMN);
  check('art_image is TEXT', !!info && String(info.type).toUpperCase() === 'TEXT', info ? info.type : 'missing');
  check('art_image is nullable (notnull = 0)', !!info && info.notnull === 0, info ? `notnull=${info.notnull}` : 'missing');
  check('art_image has no default', !!info && (info.dflt_value === null || info.dflt_value === undefined), info ? String(info.dflt_value) : 'missing');

  const rowsAfter = db.prepare('SELECT COUNT(*) c FROM spots').get().c;
  check('row count unchanged', rowsAfter === rowsBefore, `before ${rowsBefore}, after ${rowsAfter}`);

  const lost = colsBefore.filter(c => !colsAfter.includes(c));
  check('no pre-existing column lost', lost.length === 0, lost.length ? `lost: ${lost.join(', ')}` : 'all present');

  // Every pre-existing value is byte-identical — the "nothing else changed" proof.
  const snapAfter = tableExists(db, 'spots')
    ? db.prepare(`SELECT ${colsBefore.map(c => `"${c}"`).join(', ')} FROM spots ORDER BY id`).all()
    : [];
  const norm = rows => JSON.stringify(rows.map(r => {
    const o = {}; for (const k of Object.keys(r).sort()) o[k] = r[k]; return o;
  }));
  check('every pre-existing row byte-identical', norm(snapBefore) === norm(snapAfter));

  // Every existing spot reads as "no override".
  const nonNull = rowsAfter > 0 ? db.prepare(`SELECT COUNT(*) c FROM spots WHERE ${COLUMN} IS NOT NULL`).get().c : 0;
  check('every existing spot has art_image NULL (no override)', nonNull === 0, `non-null: ${nonNull}`);

  // The point of the migration: a real data URL round-trips intact, unmodified, at realistic size.
  // A 1x1 PNG header plus padding to ~200 KB — larger than the 256 KB fs:readFile cap is not needed
  // here, but the value must survive TEXT storage without truncation or mangling.
  try {
    db.exec('BEGIN');
    const probe = db.prepare('SELECT id FROM spots ORDER BY id LIMIT 1').get();
    if (probe) {
      const payload = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='.repeat(2000);
      const probeUrl = `data:image/png;base64,${payload}`;
      db.prepare(`UPDATE spots SET ${COLUMN} = ? WHERE id = ?`).run(probeUrl, probe.id);
      const readBack = db.prepare(`SELECT ${COLUMN} v FROM spots WHERE id = ?`).get(probe.id).v;
      check(`a data URL round-trips intact (${probeUrl.length} chars, no truncation)`, readBack === probeUrl,
            readBack ? `read back ${readBack.length} chars` : 'null');
      check('the data URL prefix survives', String(readBack).startsWith('data:image/png;base64,'));
    } else {
      check('a data URL round-trips intact', true, 'no spot rows to probe — skipped');
    }
    db.exec('ROLLBACK');
  } catch (e) {
    check('a data URL round-trips intact', false, e.message);
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
  }

  // Idempotency: running again must be a clean no-op, not a second column or a throw.
  try {
    applyMigration(db);
    check('second run is a clean no-op', spotsCols(db).filter(c => c === COLUMN).length === 1);
  } catch (e) {
    check('second run is a clean no-op', false, e.message);
  }

  db.close();
  if (!allPass) { console.error('\nOne or more post-verification checks FAILED.'); process.exit(1); }
  console.log('\nAll checks PASSED — migration v36 complete.');
}
