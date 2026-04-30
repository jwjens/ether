'use strict';
const path = require('path');
const os   = require('os');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath  = path.join(appData, 'com.ether.radio', 'openair.db');
const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath, { readonly: true });

console.log('DB path:', dbPath);
console.log('');

// Q1: rows where station_id is the TEXT value 'system'
console.log('── Q1: station_config_kv WHERE station_id = \'system\' (TEXT) ──────────────────');
const q1 = db.prepare(`
  SELECT station_id, typeof(station_id) AS sid_type, key,
         substr(value, 1, 60) AS value_preview,
         uuid IS NULL AS uuid_null
  FROM station_config_kv
  WHERE station_id = 'system'
`).all();
if (q1.length === 0) {
  console.log('(0 rows)');
} else {
  for (const r of q1) {
    console.log(`  station_id=${JSON.stringify(r.station_id)}  sid_type=${r.sid_type}  key=${r.key}  value_preview=${JSON.stringify(r.value_preview)}  uuid_null=${r.uuid_null}`);
  }
}
console.log('');

// Q2: rows where value = 'system'
console.log('── Q2: station_config_kv WHERE value = \'system\' ───────────────────────────────');
const q2 = db.prepare(`
  SELECT station_id, typeof(station_id) AS sid_type, key,
         substr(value, 1, 60) AS value_preview
  FROM station_config_kv
  WHERE value = 'system'
`).all();
if (q2.length === 0) {
  console.log('(0 rows)');
} else {
  for (const r of q2) {
    console.log(`  station_id=${JSON.stringify(r.station_id)}  sid_type=${r.sid_type}  key=${r.key}  value_preview=${JSON.stringify(r.value_preview)}`);
  }
}
console.log('');

// Q3: full info on theme rows
console.log('── Q3: theme_preset_id / theme_font_id / theme_custom_vars ─────────────────────');
const q3 = db.prepare(`
  SELECT station_id, typeof(station_id) AS sid_type, key,
         substr(value, 1, 80) AS value_preview
  FROM station_config_kv
  WHERE key IN ('theme_preset_id', 'theme_font_id', 'theme_custom_vars')
`).all();
if (q3.length === 0) {
  console.log('(0 rows)');
} else {
  for (const r of q3) {
    console.log(`  station_id=${JSON.stringify(r.station_id)}  sid_type=${r.sid_type}  key=${r.key}  value_preview=${JSON.stringify(r.value_preview)}`);
  }
}
console.log('');

db.close();
