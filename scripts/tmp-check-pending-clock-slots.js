'use strict';
const path = require('path');
const os = require('os');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath = path.join(appData, 'com.ether.radio', 'openair.db');
const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(
  "SELECT sync_status, COUNT(*) as c FROM mutations WHERE table_name='clock_slots' GROUP BY sync_status"
).all();
console.log('clock_slots mutations by sync_status:');
for (const r of rows) console.log('  ' + r.sync_status + ': ' + r.c);

const total = db.prepare("SELECT COUNT(*) as c FROM mutations WHERE table_name='clock_slots'").get().c;
console.log('total clock_slots mutations:', total);
db.close();
