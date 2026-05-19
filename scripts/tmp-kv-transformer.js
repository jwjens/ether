'use strict';
// Check: what schema_version do the failing canvas_layout mutations have?
// And does the transformer chain strip station_id from their payloads?
const path = require('path');
const os   = require('os');
const ROOT    = path.join(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_DB = path.join(appData, 'com.ether.radio', 'openair.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

const real = new Database(REAL_DB, { readonly: true });

// Schema versions of canvas_layout mutations
const canvasMuts = real.prepare(
  "SELECT schema_version, COUNT(*) as c FROM mutations WHERE table_name='station_config_kv' AND row_id='4736e818-1eb8-4269-9d27-c5c8e2ed87f0' GROUP BY schema_version ORDER BY schema_version"
).all();
console.log('canvas_layout mutations by schema_version:');
for (const r of canvasMuts) console.log('  sv=' + r.schema_version + '  count=' + r.c);

// Get a sample mutation for each schema version
for (const r of canvasMuts) {
  const m = real.prepare(
    "SELECT * FROM mutations WHERE table_name='station_config_kv' AND row_id='4736e818-1eb8-4269-9d27-c5c8e2ed87f0' AND schema_version=? LIMIT 1"
  ).get(r.schema_version);
  if (!m) continue;
  const pa = m.payload_after ? JSON.parse(m.payload_after) : null;
  console.log('  sv=' + r.schema_version + ' sample: pa.station_id=' + (pa ? pa.station_id : 'NO PA') + '  pa has station_id key: ' + (pa ? ('station_id' in pa) : 'N/A'));
}

// Now test: what does the transformer chain do to a canvas_layout mutation payload?
// The local schema version is 16. Mutations with sv < 16 get transformed.
const LOCAL_SV = 16;

// Get a low-sv canvas_layout mutation
const lowSvMut = real.prepare(
  "SELECT * FROM mutations WHERE table_name='station_config_kv' AND row_id='4736e818-1eb8-4269-9d27-c5c8e2ed87f0' ORDER BY schema_version ASC LIMIT 1"
).get();

if (lowSvMut && lowSvMut.schema_version < LOCAL_SV) {
  const pa = lowSvMut.payload_after ? JSON.parse(lowSvMut.payload_after) : null;
  console.log('\nLow-sv canvas_layout mutation:');
  console.log('  schema_version:', lowSvMut.schema_version);
  console.log('  payload_after.station_id (before transform):', pa ? pa.station_id : 'NO PA');
  console.log('  station_id in payload (before transform):', pa ? ('station_id' in pa) : 'N/A');

  // Run transformer chain
  try {
    const { applyTransformerChain } = require(path.join(ROOT, 'electron', 'sync', 'transformer-chain'));
    const transformed = applyTransformerChain(pa, lowSvMut.schema_version, LOCAL_SV, lowSvMut);
    console.log('  payload_after.station_id (AFTER transform):', transformed ? transformed.station_id : 'NO PA');
    console.log('  station_id in payload (AFTER transform):', transformed ? ('station_id' in transformed) : 'N/A');
    console.log('  full transformed keys:', transformed ? Object.keys(transformed) : '[]');
  } catch(e) {
    console.log('  applyTransformerChain not found or error:', e.message);
  }
} else if (lowSvMut) {
  console.log('\nLowest-sv canvas_layout mutation has sv=' + lowSvMut.schema_version + ' (= LOCAL_SV ' + LOCAL_SV + ', no transform needed)');
  const pa = lowSvMut.payload_after ? JSON.parse(lowSvMut.payload_after) : null;
  console.log('  pa.station_id:', pa ? pa.station_id : 'NO PA');
}

// What sv do ALL station_config_kv mutations have?
const allKvSv = real.prepare(
  "SELECT schema_version, COUNT(*) as c FROM mutations WHERE table_name='station_config_kv' GROUP BY schema_version ORDER BY schema_version"
).all();
console.log('\nAll station_config_kv mutations by schema_version:');
for (const r of allKvSv) console.log('  sv=' + r.schema_version + '  count=' + r.c);

real.close();
