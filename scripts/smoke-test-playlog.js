#!/usr/bin/env node
// scripts/smoke-test-playlog.js — manual smoke test for play_log coverage
// Usage: node scripts/smoke-test-playlog.js
// Note: better-sqlite3 must match the running Node version. Falls back to Python.
const { execSync } = require('child_process');
const path = require('path');

const DB_PATH = path.join(
  process.env.APPDATA || '',
  'com.ether.radio', 'openair.db'
);

const PYTHON_SCRIPT = `
import sqlite3, os, sys
db = r'${DB_PATH.replace(/\\/g, '\\\\')}'
con = sqlite3.connect(db)
cur = con.cursor()
count = cur.execute('SELECT COUNT(*) FROM play_log WHERE station_id=1').fetchone()[0]
rows = cur.execute('SELECT deck, title, artist, created_at FROM play_log WHERE station_id=1 ORDER BY id DESC LIMIT 5').fetchall()
print(f'play_log row count (station 1): {count}')
print('5 most recent rows:')
if not rows:
    print('  (none)')
for i,r in enumerate(rows):
    print(f'  [{i+1}] deck={r[0] or "?"}  title="{r[1]}"  artist="{r[2] or ""}"  at={r[3] or "-"}')
con.close()
`.trim();

try {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true });
  const count = db.prepare('SELECT COUNT(*) AS n FROM play_log WHERE station_id=1').get().n;
  const rows = db.prepare('SELECT deck, title, artist, created_at FROM play_log WHERE station_id=1 ORDER BY id DESC LIMIT 5').all();
  db.close();
  console.log(`\nplay_log row count (station 1): ${count}`);
  console.log('\n5 most recent rows:');
  if (!rows.length) console.log('  (none)');
  rows.forEach((r, i) => console.log(`  [${i+1}] deck=${r.deck||'?'}  title="${r.title}"  artist="${r.artist||''}"  at=${r.created_at||'—'}`));
  console.log('');
} catch {
  // Fall back to Python
  try {
    const out = execSync(`python3 -c "${PYTHON_SCRIPT.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { encoding: 'utf8' });
    console.log('\n' + out);
  } catch (e2) {
    const out = execSync(`python -c "${PYTHON_SCRIPT.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { encoding: 'utf8' });
    console.log('\n' + out);
  }
}
