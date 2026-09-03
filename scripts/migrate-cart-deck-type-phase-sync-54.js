'use strict';
// Migration v54 — the legacy deck TYPE 'cart' becomes a SOURCE channel dialled to carts.
//
// RESTORED 2026-09-03. This migration ran on a live profile, moved a row, and was then lost when the
// Stage-1 work around it was reverted — leaving a database at schema_version 54 with no script for
// v54, which is a chain gap: `verify-transformer-chain` blocks every commit, and a fresh install
// would skip a version that a synced peer has applied. The data change was correct and survives; only
// its record was lost, so the record comes back.
//
// WHY IT IS STILL RIGHT. A cart wall is not a kind of deck you declare in a config screen — it is one
// INPUT you dial on an ordinary source channel, the same way a jukebox, an announcement or a sweeper
// is. That is the model the whole board now runs on: carts, announcements and sweepers each resolve
// their destination from `deck_configs` at every fire. A row still carrying `type='cart'` describes a
// species that no longer exists.
//
// WHAT IT DOES, per row with type='cart':
//   • on a source-capable slot (D/E/F/S1..S5) → type='source', kind='cart', so the channel is dialled
//     to the rack it used to be and keeps its place on the board;
//   • …unless that station ALREADY has an enabled channel dialled to cart. Two racks on one station
//     is not a migration's decision to make, and the fire path would have to choose between them. The
//     row still becomes a source channel, with NO source dialled — an empty channel the operator can
//     patch, never a second rack invented on their behalf;
//   • on a rotation slot (A/B/C) → LEFT ALONE and reported. Converting it would put a source channel
//     where automation lives. A migration reports what it does not understand; it does not reshape it.
//
// Nothing is deleted and no audio path changes. `cart_slots` — the actual carts — is untouched: it is
// keyed by (station, slot_number) and has never referenced deck_configs.
//
// Idempotent: re-running finds no type='cart' rows and records the version alone.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-cart-deck-type-phase-sync-54.js <copy.db>

const VERSION = 54;
const TABLE = 'deck_configs';

/** Slots a SOURCE channel may occupy — mirrors SOURCE_SLOTS in src/components/DeckConfigurator.tsx. */
const SOURCE_SLOTS = new Set(['D', 'E', 'F', 'S1', 'S2', 'S3', 'S4', 'S5']);

function tableExists(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
}

function legacyRows(db) {
  if (!tableExists(db)) return [];
  try {
    return db.prepare(
      "SELECT station_id, slot, COALESCE(kind,'') AS kind, enabled FROM " + TABLE + " WHERE type = 'cart'"
    ).all();
  } catch { return []; }
}

function applyMigration(db) {
  const already = db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION);

  // A missing table is not a failure — deck_configs arrives earlier in the chain, and if it is absent
  // that is that migration's problem to report. Record the version so the chain stays contiguous
  // rather than re-running this on every boot forever.
  if (!tableExists(db)) {
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
    console.log('[migrate-v54] deck_configs absent — nothing to do');
    return;
  }

  const rows = legacyRows(db);
  if (!rows.length) {
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
    console.log("[migrate-v54] no type='cart' rows — nothing to move");
    return;
  }

  // Which stations already have a channel dialled to carts. Read BEFORE the transaction so one
  // converted row cannot make the next row on the same station look like a duplicate of itself.
  const dialed = new Set(
    db.prepare(
      "SELECT DISTINCT station_id FROM " + TABLE + " WHERE type = 'source' AND kind = 'cart' AND enabled = 1"
    ).all().map(r => r.station_id)
  );

  const toCart = [];      // becomes a cart channel
  const toEmpty = [];     // becomes a source channel with nothing dialled
  const skipped = [];     // not source-capable — reported, untouched

  for (const r of rows) {
    if (!SOURCE_SLOTS.has(String(r.slot).toUpperCase())) { skipped.push(r); continue; }
    if (dialed.has(r.station_id)) { toEmpty.push(r); continue; }
    toCart.push(r);
    if (r.enabled) dialed.add(r.station_id);   // the first converted row claims the station
  }

  const setSource = db.prepare(
    "UPDATE " + TABLE + " SET type = 'source', kind = ? WHERE station_id = ? AND slot = ?"
  );

  const migrate = db.transaction(() => {
    for (const r of toCart)  setSource.run('cart', r.station_id, r.slot);
    for (const r of toEmpty) setSource.run(null,   r.station_id, r.slot);
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  });
  migrate();

  for (const r of toCart)  console.log(`[migrate-v54] station ${r.station_id} slot ${r.slot} → source/cart (enabled=${r.enabled})`);
  for (const r of toEmpty) console.log(`[migrate-v54] station ${r.station_id} slot ${r.slot} → source/(no source): station already has a cart channel`);
  for (const r of skipped) console.log(`[migrate-v54] station ${r.station_id} slot ${r.slot} LEFT AS type='cart': not a source-capable slot — needs a look`);
  console.log(`[migrate-v54] moved ${toCart.length + toEmpty.length} row(s), left ${skipped.length}`);
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // A pre-v54 peer can send a deck_configs row still saying type='cart'. Normalise it the same way
    // the local migration does, so a synced row cannot reintroduce a type the board no longer renders
    // as a species. The peer's `kind` is preserved when it already has one — only an empty kind is
    // filled in, because a row that already names its input knows better than this transformer does.
    try {
      if (payload && typeof payload === 'object' && payload.type === 'cart') {
        payload.type = 'source';
        if (!payload.kind) payload.kind = 'cart';
      }
    } catch { /* a transformer must never throw the chain */ }
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');

  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-cart-deck-type-phase-sync-54.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
