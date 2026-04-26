// Phase 4 preflight report. Read-only. No DB writes.
// Save to: C:\openair\scripts\phase-4-preflight.js
// Run from C:\openair with:  npx electron scripts\phase-4-preflight.js

const Database = require('better-sqlite3');

const dbPath = 'C:\\Users\\jensj\\AppData\\Roaming\\com.ether.radio\\openair.db';
const db = new Database(dbPath, { readonly: true });

function section(label, fn) {
  console.log(`\n=== ${label} ===`);
  try { fn(); } catch (e) { console.log(`  ERROR: ${e.message}`); }
}

section('current schema_version', () => {
  const v = db.prepare(`SELECT value FROM system_state WHERE key='schema_version'`).get();
  console.log(`  ${v ? v.value : '(not set — Phase 4 migration will write this row for the first time)'}`);
});

section('stations', () => {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM stations`).get().n;
  const active = db.prepare(`SELECT COUNT(*) AS n FROM stations WHERE deleted_at IS NULL`).get().n;
  console.log(`  total=${total}  active=${active}  (migration requires exactly 1)`);
  if (active !== 1) console.log(`  WILL ABORT: migration expects 1 active station`);
});

section('songs.category_id orphans', () => {
  const orphans = db.prepare(`
    SELECT s.id, s.title, s.category_id
    FROM songs s
    LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.category_id IS NOT NULL
      AND s.deleted_at IS NULL
      AND c.id IS NULL
  `).all();

  if (orphans.length === 0) {
    console.log(`  OK: all category_id values resolve to a categories row`);
  } else {
    console.log(`  PROBLEM: ${orphans.length} songs reference invalid category_id values:`);
    orphans.slice(0, 10).forEach(o =>
      console.log(`     song ${o.id} "${o.title}" -> category_id=${o.category_id}`)
    );
    if (orphans.length > 10) console.log(`     ... and ${orphans.length - 10} more`);
    console.log(`  These will FAIL the FK constraint. Fix before migrating.`);
  }
});

section('rotation_status values', () => {
  const stats = db.prepare(`
    SELECT rotation_status, COUNT(*) AS n
    FROM songs
    WHERE category_id IS NOT NULL AND deleted_at IS NULL
    GROUP BY rotation_status
    ORDER BY n DESC
  `).all();

  const allowed = new Set(['active', 'inactive', 'hold']);
  let anyUnknown = false;
  stats.forEach(s => {
    const ok = allowed.has(s.rotation_status);
    const marker = ok ? 'OK' : 'WARN';
    console.log(`  [${marker}] ${s.rotation_status === null ? 'NULL' : s.rotation_status}: ${s.n}`);
    if (!ok && s.rotation_status !== null) anyUnknown = true;
  });
  if (anyUnknown) {
    console.log(`  Unknown values will be coerced to 'active' with a warning. Review if material.`);
  }
});

section('songs.category_id distribution', () => {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE deleted_at IS NULL`).get().n;
  const withCat = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE category_id IS NOT NULL AND deleted_at IS NULL`).get().n;
  const withoutCat = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE category_id IS NULL AND deleted_at IS NULL`).get().n;
  console.log(`  total active: ${total}`);
  console.log(`  -> station_programming rows to create: ${withCat}`);
  console.log(`  -> not migrated (category_id IS NULL): ${withoutCat}`);
  if (withoutCat > 0) {
    const samples = db.prepare(`SELECT id, title FROM songs WHERE category_id IS NULL AND deleted_at IS NULL LIMIT 5`).all();
    samples.forEach(s => console.log(`     song ${s.id} "${s.title}"`));
    console.log(`  Confirm these are intentionally uncategorized.`);
  }
});

section('pinned_songs status', () => {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM pinned_songs`).get().n;
  console.log(`  rows: ${n}`);
  console.log(`  Migration adds station_id, uuid, updated_at, deleted_at columns.`);
  if (n > 0) {
    console.log(`  WARN: ${n} existing rows will need uuid backfill.`);
    console.log(`  Migration as written assumes 0 rows — update with backfill loop before running.`);
  }
});

section('play_log status', () => {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM play_log`).get().n;
  console.log(`  rows: ${n}  (all will get programming_row_id=NULL on column add)`);
});

section('mutations table', () => {
  try {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM mutations`).get().n;
    console.log(`  rows: ${n}  (Phase 4 migration does NOT write to this table)`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
});

section('SUMMARY', () => {
  const willMigrate = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE category_id IS NOT NULL AND deleted_at IS NULL`).get().n;
  console.log(`  will create ${willMigrate} station_programming rows`);
  console.log(`  will create empty mood_tags table`);
  console.log(`  will create empty station_programming_moods table`);
  console.log(`  will add programming_row_id column to play_log`);
  console.log(`  will add station_id/uuid/updated_at/deleted_at columns to pinned_songs`);
  console.log(`  will write schema_version=4 to system_state (first time)`);
});

db.close();
console.log('\nIf no PROBLEM/WILL ABORT markers above, the migration is safe to run.');
