'use strict';
// Check which mutations have id: null in payload_after (the id-null bug)
const path    = require('path');
const os      = require('os');
const ROOT    = path.join(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_DB = path.join(appData, 'com.ether.radio', 'openair.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const r = new Database(REAL_DB, { readonly: true });

const TABLES = ['artists', 'albums', 'categories', 'operators', 'separation_rules',
                'metadata_definitions', 'metadata_vocabulary', 'clocks', 'songs',
                'stations', 'shows', 'format_clocks', 'clock_slots', 'spots',
                'announcements', 'voice_tracks'];

for (const t of TABLES) {
  let nullCount = 0;
  let totalInserts = 0;
  try {
    const inserts = r.prepare(`SELECT payload_after FROM mutations WHERE table_name=? AND op='insert'`).all(t);
    totalInserts = inserts.length;
    for (const m of inserts) {
      if (!m.payload_after) continue;
      const pa = JSON.parse(m.payload_after);
      if (pa.id === null || pa.id === undefined) nullCount++;
    }
    if (nullCount > 0) {
      console.log(`${t}: ${nullCount}/${totalInserts} INSERT mutations have id=null`);
    }
  } catch(e) {
    // table might not have mutations
  }
}
console.log('\nDone. Tables not listed have 0 id-null mutations.');
r.close();
