const Database = require(require('path').join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const path = require('path');
const os = require('os');

const dbPath = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'com.ether.radio',
  'openair.db'
);
const db = new Database(dbPath);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const synced = [];
const nonSynced = [];

for (const t of tables) {
  const cols = db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${t.name}')`).all();
  const hasUuid = cols.some(c => c.name === 'uuid');
  (hasUuid ? synced : nonSynced).push({ name: t.name, cols });
}

console.log('=== SYNCED TABLES (' + synced.length + ') ===');
for (const t of synced) {
  console.log('\n--- ' + t.name + ' (' + t.cols.length + ' columns) ---');
  for (const c of t.cols) {
    console.log('  ' + c.name.padEnd(30) + ' ' + c.type.padEnd(12) + (c.pk ? ' PK' : '') + (c.notnull ? ' NOT NULL' : ''));
  }
}

console.log('\n=== NON-SYNCED TABLES (' + nonSynced.length + ') ===');
for (const t of nonSynced) {
  console.log('  ' + t.name + ' (' + t.cols.length + ' columns)');
}

console.log('\n=== SUMMARY ===');
console.log('Total: ' + tables.length + ' | Synced: ' + synced.length + ' | Non-synced: ' + nonSynced.length);

db.close();
