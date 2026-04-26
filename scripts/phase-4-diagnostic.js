// Phase 4 diagnostic script — read-only.
// Save to: C:\openair\scripts\phase-4-diagnostic.js
// Run from C:\openair with:  npx electron scripts\phase-4-diagnostic.js

const Database = require('better-sqlite3');

const dbPath = 'C:\\Users\\jensj\\AppData\\Roaming\\com.ether.radio\\openair.db';
const db = new Database(dbPath, { readonly: true });

console.log('=== songs.mood distribution ===');
try {
  const moods = db.prepare(`SELECT mood, COUNT(*) AS n FROM songs GROUP BY mood ORDER BY n DESC`).all();
  moods.forEach(m => console.log(`  ${m.mood === null ? 'NULL' : `"${m.mood}"`}: ${m.n}`));
} catch (e) {
  console.log(`  error: ${e.message}`);
}

console.log('\n=== system_state contents ===');
try {
  const all = db.prepare(`SELECT * FROM system_state`).all();
  if (all.length === 0) {
    console.log('  (empty)');
  } else {
    all.forEach(r => console.log(' ', r));
  }
} catch (e) {
  console.log(`  error: ${e.message}`);
}

console.log('\n=== system_state schema ===');
try {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='system_state'`).get();
  console.log(' ', sql ? sql.sql : '(table does not exist)');
} catch (e) {
  console.log(`  error: ${e.message}`);
}

console.log('\n=== mutations table presence ===');
try {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM mutations`).get().n;
  console.log(`  mutations row count: ${n}`);
} catch (e) {
  console.log(`  mutations table: ${e.message}`);
}

console.log('\n=== client_identity ===');
try {
  const ci = db.prepare(`SELECT * FROM client_identity`).all();
  if (ci.length === 0) {
    console.log('  (empty)');
  } else {
    ci.forEach(r => console.log(' ', r));
  }
} catch (e) {
  console.log(`  error: ${e.message}`);
}

console.log('\n=== songs.energy distribution ===');
try {
  const populated = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE energy IS NOT NULL`).get().n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM songs`).get().n;
  console.log(`  with energy: ${populated} / ${total}`);
} catch (e) {
  console.log(`  error: ${e.message}`);
}

console.log('\n=== songs.daypart_mask distribution ===');
try {
  const masks = db.prepare(`SELECT daypart_mask, COUNT(*) AS n FROM songs GROUP BY daypart_mask ORDER BY n DESC LIMIT 10`).all();
  masks.forEach(m => console.log(`  ${m.daypart_mask}: ${m.n}`));
} catch (e) {
  console.log(`  error: ${e.message}`);
}

console.log('\n=== songs.last_played_at sample ===');
try {
  const recent = db.prepare(`SELECT id, title, last_played_at FROM songs WHERE last_played_at IS NOT NULL ORDER BY last_played_at DESC LIMIT 3`).all();
  if (recent.length === 0) {
    console.log('  (no songs have last_played_at populated)');
  } else {
    recent.forEach(r => console.log(`  id=${r.id} last_played_at=${r.last_played_at}  "${r.title}"`));
  }
} catch (e) {
  console.log(`  error: ${e.message}`);
}

console.log('\n=== songs.uuid coverage ===');
try {
  const withUuid = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE uuid IS NOT NULL`).get().n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM songs`).get().n;
  console.log(`  with uuid: ${withUuid} / ${total}`);
} catch (e) {
  console.log(`  error: ${e.message}`);
}

db.close();
