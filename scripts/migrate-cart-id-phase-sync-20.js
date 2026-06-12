'use strict';
// Migration v20: add cart_id to songs.
//
// - cart_id TEXT — an operator-assigned "cart number" (e.g. 1001, J014, TALK7).
//   A short, human-typed handle for ONE specific library element — song, jingle,
//   sweeper, or talk break — so it can be placed into a clock/schedule by number
//   instead of being picked at random from a category.
//
// WHY: clock slots schedule by CATEGORY ("a Currents song here"); there was no way
// to pin a SPECIFIC element to a spot. Cart numbers are the reference primitive that
// makes "play cart 1001 here" possible. The library is one shared list (songs +
// jingles + talk breaks are all rows), so one cart_id column covers all three.
//
// Synced as a normal patchable field so every client agrees on a song's cart number.
// No DB uniqueness constraint (a synced UNIQUE would be a conflict hazard); the UI
// warns on a duplicate instead. Indexed for fast lookup-by-cart. No backfill — existing
// rows simply have no cart number until one is assigned.

function applyMigration(db) {
  const migrate = db.transaction(() => {
    const existingCols = new Set(
      db.prepare('PRAGMA table_info(songs)').all().map(r => r.name)
    );

    if (!existingCols.has('cart_id')) {
      db.prepare('ALTER TABLE songs ADD COLUMN cart_id TEXT').run();
      console.log('[migrate-v20] ALTER  songs.cart_id TEXT');
    } else {
      console.log('[migrate-v20] SKIP   songs.cart_id — column already exists');
    }

    db.prepare('CREATE INDEX IF NOT EXISTS idx_songs_cart_id ON songs(cart_id)').run();

    db.prepare('INSERT INTO schema_version (version) VALUES (20)').run();
  });
  migrate();
  console.log('[migrate-v20] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — cart_id defaults to null for older payloads (a receiver on an
    // earlier schema simply has no cart number for that row).
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

  console.log('=== migrate-cart-id-phase-sync-20.js ===');
  console.log('DB:', dbPath);

  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  const currentVersion = Math.max(...versions);
  if (currentVersion >= 20) {
    console.log(`Already at schema v${currentVersion} — nothing to do.`);
    process.exit(0);
  }
  applyMigration(db);
  console.log('Done — songs.cart_id added, schema at v20.');
}
