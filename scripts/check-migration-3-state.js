'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const dbPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'com.ether.radio', 'openair.db');

console.log('[check-state] DB path:', dbPath);
console.log('[check-state] DB exists:', fs.existsSync(dbPath));

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath, { readonly: true });

const sv = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
console.log('[check-state] schema_version:', JSON.stringify(sv));

const hasMutations = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mutations'").get();
const hasClientIdentity = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='client_identity'").get();
const hasSystemState = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='system_state'").get();

console.log('[check-state] mutations table exists:', hasMutations);
console.log('[check-state] client_identity table exists:', hasClientIdentity);
console.log('[check-state] system_state table exists:', hasSystemState);

if (hasClientIdentity) {
  const rows = db.prepare('SELECT * FROM client_identity').all();
  console.log('[check-state] client_identity rows:', JSON.stringify(rows, null, 2));
}

if (hasSystemState) {
  const rows = db.prepare('SELECT * FROM system_state').all();
  console.log('[check-state] system_state rows:', JSON.stringify(rows, null, 2));
}

const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_mutations_%' ORDER BY name").all().map(r => r.name);
console.log('[check-state] mutations indexes:', JSON.stringify(indexes));

if (hasMutations) {
  const rowCount = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
  console.log('[check-state] mutations row count:', rowCount);
}

db.close();
process.exit(0);
