// Phase 4 schema dump — save to C:\Users\jensj\Downloads
// Run from that folder: node phase-4-schema-dump.js
//
// Reads schema for tables relevant to Phase 4 migration. Read-only. No DB writes.
// Paste full output back to chat.

const Database = require('better-sqlite3');

const dbPath = 'C:\\Users\\jensj\\AppData\\Roaming\\com.ether.radio\\openair.db';

console.log(`DB: ${dbPath}\n`);

const db = new Database(dbPath, { readonly: true });

const tables = ['songs', 'categories', 'stations', 'play_log', 'pinned_songs', 'shows'];

for (const table of tables) {
  console.log(`\n========== ${table} ==========`);

  const schema = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`
  ).get(table);

  if (!schema) {
    console.log(`(table does not exist)`);
    continue;
  }

  console.log(schema.sql);

  const indexes = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL`
  ).all(table);

  if (indexes.length > 0) {
    console.log(`\n-- indexes on ${table} --`);
    indexes.forEach(idx => console.log(idx.sql));
  }

  try {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    console.log(`-- row count: ${count.n} --`);
  } catch (e) {
    console.log(`-- row count: error (${e.message}) --`);
  }
}

console.log(`\n========== songs.category_id distribution ==========`);
try {
  const withCat = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE category_id IS NOT NULL`).get().n;
  const withoutCat = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE category_id IS NULL`).get().n;
  console.log(`with category_id: ${withCat}`);
  console.log(`without category_id: ${withoutCat}`);
} catch (e) {
  console.log(`error: ${e.message}`);
}

console.log(`\n========== schema_version ==========`);
try {
  const v = db.prepare(`SELECT value FROM system_state WHERE key='schema_version'`).get();
  console.log(`schema_version: ${v ? v.value : '(not set)'}`);
} catch (e) {
  console.log(`error reading system_state: ${e.message}`);
}

console.log(`\n========== sample songs row ==========`);
try {
  const sample = db.prepare(`SELECT * FROM songs LIMIT 1`).get();
  if (sample) {
    console.log('Columns and example values:');
    for (const [key, value] of Object.entries(sample)) {
      const display = value === null ? 'NULL'
                    : typeof value === 'string' && value.length > 60 ? value.slice(0, 60) + '...'
                    : value;
      console.log(`  ${key.padEnd(28)} = ${display}`);
    }
  } else {
    console.log('(songs table is empty)');
  }
} catch (e) {
  console.log(`error: ${e.message}`);
}

db.close();
