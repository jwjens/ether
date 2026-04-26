// Check schema_version state across both tracking mechanisms.
// Save to: C:\openair\scripts\check-schema-version.js
// Run from C:\openair with:  npx electron scripts\check-schema-version.js

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(process.env.APPDATA, 'com.ether.radio', 'openair.db');
const db = new Database(dbPath, { readonly: true });

console.log('=== schema_version table (canonical mechanism) ===');
try {
  const rows = db.prepare('SELECT version FROM schema_version ORDER BY version').all();
  console.log('  rows:', JSON.stringify(rows));
  if (rows.length > 0) {
    const max = Math.max(...rows.map(r => r.version));
    console.log('  max version:', max);
  }
} catch (e) {
  console.log('  ERROR:', e.message);
}

console.log('\n=== schema_version table SCHEMA ===');
try {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='schema_version'`).get();
  console.log(' ', sql ? sql.sql : '(table does not exist)');
} catch (e) {
  console.log('  ERROR:', e.message);
}

console.log('\n=== system_state contents (the wrong place I wrote to) ===');
try {
  const all = db.prepare('SELECT * FROM system_state').all();
  all.forEach(r => console.log(' ', r));
} catch (e) {
  console.log('  ERROR:', e.message);
}

console.log('\n=== station_programming row count (sanity check our migration data) ===');
try {
  const n = db.prepare('SELECT COUNT(*) AS n FROM station_programming').get().n;
  console.log('  rows:', n);
} catch (e) {
  console.log('  ERROR:', e.message);
}

db.close();
