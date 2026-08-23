'use strict';
// Migration v42 — SOURCE channels: deck_configs gains { kind, address }, and jukebox decks become
// source channels.
//
// Jeff's ruling, 2026-08-22: new schema changes go through the NUMBERED transformer system, not
// alterSafe inside runMigrations(). "Every machine reaches the same schema the same way" — and the
// class of divergence that principle prevents is the one behind the re-key disaster.
//
// This RETRO-FITS the slice-2 change, which first shipped as two alterSafe calls plus an inline
// UPDATE. Those reached every machine (alterSafe runs unconditionally on every boot), so there is no
// live divergence to repair — but the schema they produced was invisible to schema_version, so a
// reader could not tell from the version what the schema should contain. Now they can.
//
// WHAT THIS IS FOR
//   A SOURCE channel is a console strip whose input you pick, the way a Wheatstone bus selector
//   does. `type` stays WHAT THE STRIP IS; `kind` is WHAT IS PATCHED IN (jukebox | announcement |
//   jingle | mic | network). `address` is unused by the file kinds and carries a device id for Mic
//   or an endpoint for a network source — both Phase 2. It is added NOW, empty, precisely so Phase 2
//   needs no migration.
//   docs/aux-channel-ducker-announcements-design-2026-08-21.md §A.6
//
// THE JUKEBOX CONVERSION
//   The jukebox is a SOURCE you patch in, not a deck TYPE, so type='jukebox' rows become
//   type='source', kind='jukebox' and the legacy strip is retired. A station that had deck D as a
//   jukebox keeps its deck, its fader and its remembered ON state: jukebox_channel_on lives in
//   station_config_kv keyed per STATION, not per slot, so the key is untouched by this and the
//   Jukebox window keeps reading the same truth.
//
// IDEMPOTENT by construction — the column adds are guarded on the live schema and the UPDATE matches
// nothing on a second run. Fail-soft is the caller's contract (runMigrationChain logs and continues),
// which is why nothing here throws for an expected condition.
//
// Verify on a COPY first:
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-source-channels-phase-sync-42.js <copy.db>

const TABLE = 'deck_configs';

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function columns(db, t) {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); }
  catch { return []; }
}
function isAlreadyMigrated(db) {
  const cols = columns(db, TABLE);
  if (!cols.includes('kind') || !cols.includes('address')) return false;
  const legacy = db.prepare(
    `SELECT COUNT(*) c FROM ${TABLE} WHERE type = 'jukebox' AND deleted_at IS NULL`
  ).get().c;
  return legacy === 0;
}

function applyMigration(db) {
  // A station with no deck_configs table at all is a database this migration has nothing to say
  // about. Skip quietly rather than throw — a migration that cannot apply is a logged skip, never a
  // station that will not start (docs/migration-safety-and-customer-recovery-2026-08-06.md).
  if (!tableExists(db, TABLE)) {
    console.log('[migrate-v42] deck_configs absent — nothing to migrate.');
    try { db.prepare('INSERT INTO schema_version (version) VALUES (42)').run(); } catch { /* recorded */ }
    return;
  }

  const migrate = db.transaction(() => {
    const cols = columns(db, TABLE);
    if (!cols.includes('kind')) {
      db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN kind TEXT DEFAULT ''`).run();
      console.log('[migrate-v42] deck_configs.kind added.');
    }
    if (!cols.includes('address')) {
      db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN address TEXT DEFAULT NULL`).run();
      console.log('[migrate-v42] deck_configs.address added.');
    }

    // DUPLICATE GUARD — never leave a station with TWO enabled jukebox patch points.
    //
    // A station can already have a SOURCE channel patched to jukebox (an operator added one with +)
    // while a legacy type='jukebox' deck still exists. Converting the legacy deck blindly gives that
    // station two jukebox channels, and every consumer resolves the routed deck with
    // "ORDER BY slot LIMIT 1" — so the jukebox silently jumps to whichever slot sorts first, taking
    // audio off the channel the operator was actually using. That reads as "the migration broke the
    // jukebox" days later; it is really an ambiguous double-patch.
    //
    // Where a station already has an enabled source-jukebox, the legacy deck is converted but left
    // UNPATCHED (kind = '') rather than disabled: the deck stays on the board, so nothing the
    // operator set up disappears, and there is exactly one jukebox. It is logged, never silent.
    const dupStations = db.prepare(
      `SELECT DISTINCT legacy.station_id AS sid
         FROM ${TABLE} legacy
         JOIN ${TABLE} src
           ON src.station_id = legacy.station_id
          AND src.type = 'source' AND src.kind = 'jukebox'
          AND src.enabled = 1 AND src.deleted_at IS NULL
        WHERE legacy.type = 'jukebox' AND legacy.deleted_at IS NULL`
    ).all().map(r => r.sid);

    if (dupStations.length) {
      const marks = dupStations.map(() => '?').join(',');
      const dup = db.prepare(
        `UPDATE ${TABLE} SET type = 'source', kind = ''
          WHERE type = 'jukebox' AND deleted_at IS NULL AND station_id IN (${marks})`
      ).run(...dupStations);
      console.log(`[migrate-v42] duplicate jukebox avoided on station(s) ${dupStations.join(', ')}: ` +
                  `${dup.changes} legacy deck(s) converted UNPATCHED — a source channel already carries the jukebox`);
    }

    const jb = db.prepare(
      `UPDATE ${TABLE} SET type = 'source', kind = 'jukebox'
        WHERE type = 'jukebox' AND deleted_at IS NULL`
    ).run();
    if (jb.changes > 0) {
      console.log(`[migrate-v42] jukebox deck → SOURCE channel: ${jb.changes} row(s) converted`);
      for (const r of db.prepare(
        `SELECT station_id, slot, type, kind, enabled FROM ${TABLE}
          WHERE kind = 'jukebox' AND deleted_at IS NULL ORDER BY station_id, slot`
      ).all()) {
        console.log(`[migrate-v42]   station ${r.station_id} slot ${r.slot} → type=${r.type} kind=${r.kind} enabled=${r.enabled}`);
      }
    }

    try { db.prepare('INSERT INTO schema_version (version) VALUES (42)').run(); } catch { /* recorded */ }
  });
  migrate();
  console.log('[migrate-v42] Transaction committed.');
}

module.exports = {
  // Pass-through: `kind` and `address` are new columns on an already-synced table, registered in
  // synced-tables.js as plain scalars. A payload written before v42 simply lacks them, and a reader
  // that lacks the columns ignores them — there is nothing on the wire to rewrite.
  payloadTransformer: function payloadTransformer(payload) { return payload; },
  applyMigration,
  isAlreadyMigrated,
};
