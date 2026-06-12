'use strict';
// Migration v21: add song_id to clock_slots (pin a specific element to a clock slot).
//
// - song_id INTEGER REFERENCES songs(id) — when set, this clock slot plays THIS
//   exact element (a specific song/jingle/talk break, addressed by its cart number
//   in the UI) instead of a random pick from category_id. NULL = the existing
//   category behaviour, unchanged.
//
// WHY: clock slots only scheduled by category ("a Currents song here") — there was
// no way to fix a SPECIFIC element to a spot (e.g. a legal ID, a named jingle, a
// scripted talk break). This is the rotation half of cart numbers: the generator
// reads song_id and places that exact element. Synced as a normal patchable field.

function applyMigration(db) {
  const migrate = db.transaction(() => {
    const existingCols = new Set(
      db.prepare('PRAGMA table_info(clock_slots)').all().map(r => r.name)
    );

    if (!existingCols.has('song_id')) {
      db.prepare('ALTER TABLE clock_slots ADD COLUMN song_id INTEGER').run();
      console.log('[migrate-v21] ALTER  clock_slots.song_id INTEGER');
    } else {
      console.log('[migrate-v21] SKIP   clock_slots.song_id — column already exists');
    }

    db.prepare('INSERT INTO schema_version (version) VALUES (21)').run();
  });
  migrate();
  console.log('[migrate-v21] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — song_id defaults to null (category-based) for older payloads.
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

  console.log('=== migrate-clock-slot-song-phase-sync-21.js ===');
  console.log('DB:', dbPath);

  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  const currentVersion = Math.max(...versions);
  if (currentVersion >= 21) {
    console.log(`Already at schema v${currentVersion} — nothing to do.`);
    process.exit(0);
  }
  applyMigration(db);
  console.log('Done — clock_slots.song_id added, schema at v21.');
}
