'use strict';
// Migration v22: add spot_type to clock_slots (wire spot_break slots to the spots library).
//
// - spot_type TEXT — when a slot's slot_type is 'spot_break', this names which kind of
//   spot the generator pulls from the spots table (e.g. 'commercial', 'promo', 'psa').
//   NULL = any active spot. Other slot types ignore it.
//
// WHY: spot_break clock slots were inert — the generator only filled music slots, so a
// spot break advanced the clock and inserted nothing (dead air). The generator now reads
// spot_type and places the least-recently-aired eligible spot. Synced as a normal
// patchable field.

function applyMigration(db) {
  const migrate = db.transaction(() => {
    const existingCols = new Set(
      db.prepare('PRAGMA table_info(clock_slots)').all().map(r => r.name)
    );

    if (!existingCols.has('spot_type')) {
      db.prepare('ALTER TABLE clock_slots ADD COLUMN spot_type TEXT').run();
      console.log('[migrate-v22] ALTER  clock_slots.spot_type TEXT');
    } else {
      console.log('[migrate-v22] SKIP   clock_slots.spot_type — column already exists');
    }

    db.prepare('INSERT INTO schema_version (version) VALUES (22)').run();
  });
  migrate();
  console.log('[migrate-v22] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — spot_type defaults to null (any active spot) for older payloads.
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dbPath = path.join(appData, 'com.ether.radio', 'openair.db');

  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-clock-slot-spot-type-phase-sync-22.js ===');
  console.log('DB:', dbPath);

  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  const currentVersion = Math.max(...versions);
  if (currentVersion >= 22) {
    console.log(`Already at schema v${currentVersion} — nothing to do.`);
    process.exit(0);
  }
  applyMigration(db);
  console.log('Done — clock_slots.spot_type added, schema at v22.');
}
