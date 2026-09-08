'use strict';
// Migration v55 — a cut belongs to more than one pool, and pools belong to stations.
//
// THE DEFECT. `songs.jingle_category_id` is a single INTEGER on a SHARED song row, and
// `jingle_categories` rows carry a station_id. So one cut pointed at one pool owned by one station:
// putting a sweeper into halloVeen's Halloween pool silently took it out of Christmas in Jully's
// Summer Christmas pool. Measured on the live profile before this ran, the 64 shared cuts were
// PARTITIONED across three stations (33 / 19 / 12, with Magical Forest holding none) rather than
// shared by them. Jeff's ruling: "one library, many uses — the same as a song being in halloVeen's HV
// category and Christmas in July's."
//
// THE SHAPE. One join table, keyed on `asset_uuid` — NOT on `songs.id`. A local integer id does not
// mean the same row on another machine, and this table syncs; the uuid is the identity v50
// deliberately preserved when it reused each song's uuid as its asset uuid. `station_id` is carried
// alongside `pool_id` — see the column comment for why the scope is stated rather than implied.
//
// WHAT IT DOES TO WHAT YOU HEAR: nothing, on the day it runs. The backfill reproduces today's
// membership row for row, so every pool returns the same candidates in the same order. Verified, not
// asserted — scripts/verify-pool-membership.js replays a real generated day through the real
// candidate query in both shapes and diffs the picks.
//
// `songs.jingle_category_id` IS LEFT IN PLACE AND UNREAD. Dropping the column a previous build reads
// would make a rollback lose every pool. It is removed in its own step, later, once this table has
// been in service. Nothing writes it after this migration; nothing reads it while the join table
// exists (electron/sweeper-pool.js picks the shape the database actually has).
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-sweeper-pool-member-phase-sync-55.js <copy.db>

const VERSION = 55;
const TABLE = 'sweeper_pool_member';

function tableExists(db, t) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function hasCol(db, t, c) {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c); }
  catch { return false; }
}

function applyMigration(db) {
  const already = !!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION);

  if (tableExists(db, TABLE)) {
    if (!already) { try { db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION); } catch { /* recorded */ } }
    console.log('[migrate-v55] SKIP — sweeper_pool_member already exists');
    return;
  }

  // A database without the source column cannot be backfilled from. Create the table anyway so the
  // shape is present and future writes have somewhere to go; report the absence rather than guessing.
  const canBackfill = tableExists(db, 'songs') && hasCol(db, 'songs', 'jingle_category_id')
                      && tableExists(db, 'jingle_categories');

  const rows = canBackfill ? db.prepare(`
    SELECT s.uuid AS asset_uuid, s.jingle_category_id AS pool_id, jc.station_id
      FROM songs s
      JOIN jingle_categories jc ON jc.id = s.jingle_category_id AND jc.deleted_at IS NULL
     WHERE s.jingle_category_id IS NOT NULL AND s.uuid IS NOT NULL`).all() : [];

  // A row with no uuid cannot be referenced by a peer and could never be synced — counted and
  // reported, never invented. Same treatment v50 gave uuid-less songs.
  const noUuid = canBackfill ? db.prepare(`
    SELECT COUNT(*) n FROM songs s
      JOIN jingle_categories jc ON jc.id = s.jingle_category_id AND jc.deleted_at IS NULL
     WHERE s.jingle_category_id IS NOT NULL AND s.uuid IS NULL`).get().n : 0;

  const now = new Date().toISOString();
  const migrate = db.transaction(() => {
    db.prepare(`
      CREATE TABLE ${TABLE} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_id     INTEGER NOT NULL,   -- jingle_categories.id
        asset_uuid  TEXT    NOT NULL,   -- library_asset.uuid / songs.uuid — the SHARED cut
        -- DENORMALISED from the pool, and deliberately so. The station is already implied by pool_id,
        -- but every other station-scoped synced table carries station_id and the sync layer routes on
        -- it; a table that implied its scope instead of stating it would be the one row shape in the
        -- registry that behaves differently. A pool does not change stations, so this cannot drift.
        station_id  INTEGER NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        uuid        TEXT,
        created_at  TEXT, updated_at TEXT, deleted_at TEXT
      )`).run();
    // One membership per (pool, cut), reusable after a soft-delete — mirrors the index discipline on
    // jingle_categories and spot_categories.
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sweeper_pool_member_key
                  ON ${TABLE}(pool_id, asset_uuid) WHERE deleted_at IS NULL`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sweeper_pool_member_pool
                  ON ${TABLE}(pool_id) WHERE deleted_at IS NULL`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sweeper_pool_member_station
                  ON ${TABLE}(station_id) WHERE deleted_at IS NULL`).run();

    const ins = db.prepare(
      `INSERT INTO ${TABLE} (pool_id, asset_uuid, station_id, sort_order, uuid, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`);
    let i = 0;
    for (const r of rows) {
      // A deterministic uuid would be nicer for cross-peer identity, but this table is keyed by
      // (pool_id, asset_uuid) and the sync layer merges on that key, so a local uuid is sufficient
      // and matches how every other backfill in this chain mints one.
      ins.run(r.pool_id, r.asset_uuid, r.station_id, `spm-${r.pool_id}-${r.asset_uuid}`, now, now);
      i++;
    }
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  });
  migrate();

  const byPool = new Map();
  for (const r of rows) byPool.set(r.pool_id, (byPool.get(r.pool_id) || 0) + 1);
  for (const [pool, n] of [...byPool].sort((a, b) => b[1] - a[1])) {
    let name = String(pool);
    try { const p = db.prepare('SELECT name, station_id FROM jingle_categories WHERE id = ?').get(pool);
          if (p) name = `${p.name} (station ${p.station_id})`; } catch {}
    console.log(`[migrate-v55] pool ${name}: ${n} membership(s) carried forward`);
  }
  if (!canBackfill) console.log('[migrate-v55] no songs.jingle_category_id to backfill from — table created empty');
  if (noUuid) console.log(`[migrate-v55] ${noUuid} membership(s) SKIPPED: the song has no uuid and cannot be referenced`);
  console.log(`[migrate-v55] created ${TABLE}, carried ${rows.length} membership(s) forward`);
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // A pre-v55 peer sends `songs` rows still carrying jingle_category_id. Left ALONE: the column
    // still exists locally and is still what a pre-v55 build reads, so rewriting it here would break
    // the rollback this migration deliberately preserves. Membership from an older peer simply does
    // not arrive as sweeper_pool_member rows — the two builds disagree about pool membership until
    // both are updated, which is a stated cost of this slice, not a defect to paper over.
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

  console.log('=== migrate-sweeper-pool-member-phase-sync-55.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
