'use strict';
// Migration v35 — deck_configs becomes per-station: PRIMARY KEY (station_id, slot).
//
// Cause (docs/deck-configs-station-identity-trace-2026-07-29.md, receipts in
// docs/deck-configs-migration-prep-2026-07-29.md):
//   deck_configs was created with `slot TEXT PRIMARY KEY` — globally unique across the whole
//   database — and `station_id INTEGER NOT NULL DEFAULT 1` was bolted on afterwards. The table
//   therefore CANNOT hold a second station's decks: an INSERT of slot 'A' for station 4 collides
//   with station 1's primary key. Every seeded row landed on station 1 by column default, so
//   station 1 shows a full deck set and every other station reads zero rows and silently falls
//   back to a default order. A station is a data binding, not a variant — this makes the storage
//   able to express that.
//
// SQLite cannot ALTER a PRIMARY KEY, so this is a table rebuild (create → copy → drop → rename →
// recreate indexes), all inside one transaction.
//
// NON-NEGOTIABLE, and why:
//   • Rows are COPIED VERBATIM, never re-seeded. The live rows have drifted from the seeder
//     defaults (D is mic/"Mic", E is video with a custom colour); re-seeding would destroy the
//     operator's real layout.
//   • uuids are PRESERVED. 204 rows in `mutations` key on them; regenerating would orphan the
//     sync history.
//   • The UNIQUE index on uuid and the index on station_uuid are recreated after the rename
//     (dropping the old table drops its indexes with it).
//   • Nothing here assumes six slots or the letters A–F. The rebuild is slot-agnostic; adding a
//     slot later is a plain INSERT.
//
// Verified on a COPY before any live run. Verify with:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/migrate-deck-configs-per-station-phase-sync-35.js <copy.db>

const TABLE = 'deck_configs';

// Column set, in stored order, with the definitions the rebuilt table must carry.
// Any column missing from an older DB is added before the rebuild so the copy is total.
const COLUMNS = [
  { name: 'slot',         def: 'TEXT NOT NULL' },
  { name: 'type',         def: "TEXT NOT NULL DEFAULT 'music'" },
  { name: 'label',        def: 'TEXT NOT NULL' },
  { name: 'color',        def: "TEXT NOT NULL DEFAULT '#34d399'" },
  { name: 'enabled',      def: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'purpose',      def: "TEXT DEFAULT ''" },
  { name: 'station_id',   def: 'INTEGER NOT NULL DEFAULT 1' },
  { name: 'uuid',         def: 'TEXT' },
  { name: 'created_at',   def: 'TEXT' },
  { name: 'updated_at',   def: 'TEXT' },
  { name: 'deleted_at',   def: 'TEXT' },
  { name: 'station_uuid', def: 'TEXT' },
];

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function cols(db, t) {
  try { return db.prepare(`PRAGMA table_info("${t}")`).all(); } catch { return []; }
}
function pkColumns(db, t) {
  return cols(db, t).filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
}

/** Already migrated when the PK is exactly (station_id, slot). */
function isAlreadyMigrated(db) {
  const pk = pkColumns(db, TABLE);
  return pk.length === 2 && pk.includes('station_id') && pk.includes('slot');
}

function applyMigration(db) {
  if (!tableExists(db, TABLE)) {
    console.log('[migrate-v35] deck_configs does not exist — nothing to rebuild.');
    try { db.prepare('INSERT INTO schema_version (version) VALUES (35)').run(); } catch { /* recorded */ }
    return;
  }
  if (isAlreadyMigrated(db)) {
    console.log('[migrate-v35] PK is already (station_id, slot) — no-op.');
    try { db.prepare('INSERT INTO schema_version (version) VALUES (35)').run(); } catch { /* recorded */ }
    return;
  }

  const existing = cols(db, TABLE).map(c => c.name);

  const migrate = db.transaction(() => {
    // 1. Any column an older DB is missing, so the copy below is total.
    for (const c of COLUMNS) {
      if (!existing.includes(c.name)) {
        // NOT NULL without a default cannot be added to a populated table; fall back to a
        // nullable add — the rebuild re-imposes the constraint.
        const addDef = /NOT NULL/.test(c.def) && !/DEFAULT/.test(c.def)
          ? c.def.replace(/\s*NOT NULL\s*/, ' ')
          : c.def;
        db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN ${c.name} ${addDef}`).run();
        console.log(`[migrate-v35] added missing column ${c.name}`);
      }
    }

    const before = db.prepare(`SELECT COUNT(*) c FROM ${TABLE}`).get().c;
    const colList = COLUMNS.map(c => `"${c.name}"`).join(', ');

    // 2. New table with the composite PK.
    db.exec(`
      CREATE TABLE "${TABLE}_new" (
        ${COLUMNS.map(c => `"${c.name}" ${c.def}`).join(',\n        ')},
        PRIMARY KEY (station_id, slot)
      )
    `);

    // 3. Copy every row verbatim — no defaults applied, no re-seed, uuids preserved.
    db.exec(`INSERT INTO "${TABLE}_new" (${colList}) SELECT ${colList} FROM "${TABLE}"`);

    const copied = db.prepare(`SELECT COUNT(*) c FROM "${TABLE}_new"`).get().c;
    if (copied !== before) {
      throw new Error(`[migrate-v35] copy lost rows: ${before} → ${copied} (transaction rolled back)`);
    }

    // 4. Swap. Dropping the old table drops its indexes with it.
    db.exec(`DROP TABLE "${TABLE}"`);
    db.exec(`ALTER TABLE "${TABLE}_new" RENAME TO "${TABLE}"`);

    // 5. Recreate the indexes the old table carried.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_deck_configs_uuid" ON "${TABLE}"(uuid)`);
    db.exec(`CREATE INDEX IF NOT EXISTS "idx_deck_configs_station_uuid" ON "${TABLE}"(station_uuid)`);

    try { db.prepare('INSERT INTO schema_version (version) VALUES (35)').run(); } catch { /* recorded */ }
    console.log(`[migrate-v35] rebuilt deck_configs with PK (station_id, slot); ${copied} row(s) copied verbatim.`);
  });

  migrate();
  console.log('[migrate-v35] Transaction committed.');
}

module.exports = { applyMigration, isAlreadyMigrated, pkColumns, COLUMNS };

if (require.main === module) {
  const path = require('path');
  const os = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-deck-configs-per-station-phase-sync-35.js ===');
  console.log('DB:', dbPath, isAlreadyMigrated(db) ? '(already migrated — will no-op)' : '');

  const versions0 = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  console.log('current schema_version:', versions0.length ? Math.max(...versions0) : '(none)');

  // Snapshot BEFORE — every row, so the copy can be proven verbatim.
  const before = tableExists(db, TABLE)
    ? db.prepare(`SELECT * FROM ${TABLE} ORDER BY station_id, slot`).all()
    : [];
  console.log(`deck_configs rows before: ${before.length}`);
  console.log('PK before:', JSON.stringify(pkColumns(db, TABLE)));

  applyMigration(db);

  console.log('\n=== Post-verification ===');
  let allPass = true;
  const check = (label, pass, detail) => {
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
    if (!pass) allPass = false;
  };

  const newVersion = Math.max(...db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version));
  check('schema_version = 35', newVersion === 35, `got ${newVersion}`);

  const pk = pkColumns(db, TABLE);
  check('PK is (station_id, slot)', pk.length === 2 && pk[0] === 'station_id' && pk[1] === 'slot', JSON.stringify(pk));

  const after = db.prepare(`SELECT * FROM ${TABLE} ORDER BY station_id, slot`).all();
  check('row count unchanged', after.length === before.length, `before ${before.length}, after ${after.length}`);

  // Every column of every row identical — this is the "copied verbatim" proof.
  const norm = rows => JSON.stringify(rows.map(r => {
    const o = {}; for (const k of Object.keys(r).sort()) o[k] = r[k]; return o;
  }));
  check('every row byte-identical (verbatim copy, uuids preserved)', norm(before) === norm(after));

  const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=?").all(TABLE);
  const uuidIdx = idx.find(i => i.name === 'idx_deck_configs_uuid');
  check('UNIQUE index on uuid recreated', !!uuidIdx && /UNIQUE/i.test(uuidIdx.sql || ''), uuidIdx ? uuidIdx.sql : 'missing');
  check('station_uuid index recreated', idx.some(i => i.name === 'idx_deck_configs_station_uuid'));

  // The point of the whole migration: a second station can now hold the same slot.
  try {
    db.exec('BEGIN');
    const probeStation = 999999;
    db.prepare(`INSERT INTO ${TABLE} (slot, type, label, color, enabled, station_id, uuid)
                VALUES ('A', 'music', 'probe', '#000000', 0, ?, ?)`)
      .run(probeStation, 'probe-' + Date.now());
    const probed = db.prepare(`SELECT COUNT(*) c FROM ${TABLE} WHERE station_id = ?`).get(probeStation).c;
    check('a second station can now hold slot A', probed === 1);
    db.exec('ROLLBACK');
  } catch (e) {
    check('a second station can now hold slot A', false, e.message);
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
  }

  const leftover = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(`${TABLE}_new`);
  check('no leftover scratch table', !leftover);

  db.close();
  if (!allPass) { console.error('\nOne or more post-verification checks FAILED.'); process.exit(1); }
  console.log('\nAll checks PASSED — migration v35 complete.');
}
