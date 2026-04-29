'use strict';
const path = require('path');
const os   = require('os');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath  = path.join(appData, 'com.ether.radio', 'openair.db');
const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath, { readonly: true });

const q1 = db.prepare('SELECT COUNT(*) AS null_uuids FROM station_config_kv WHERE uuid IS NULL').get();
const q2 = db.prepare('SELECT COUNT(*) AS total FROM station_config_kv').get();
const q3 = db.prepare(`
  SELECT
    COUNT(*) AS total,
    COUNT(CASE WHEN typeof(created_at) = 'integer' THEN 1 END) AS int_created,
    COUNT(CASE WHEN typeof(created_at) = 'text'    THEN 1 END) AS text_created,
    COUNT(CASE WHEN typeof(updated_at) = 'integer' THEN 1 END) AS int_updated,
    COUNT(CASE WHEN typeof(updated_at) = 'text'    THEN 1 END) AS text_updated
  FROM station_config_kv
`).get();

console.log('Q1 null_uuids:', q1.null_uuids);
console.log('Q2 total:     ', q2.total);
console.log('Q3', q3);

db.close();
