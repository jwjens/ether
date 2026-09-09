'use strict';
// Migration v58 — deck_configs.channel_on: the console channel's ON lamp, given a store.
//
// WHY THIS EXISTS. The ON lamp was `useState<Record<string, boolean>>({})` in App.tsx — renderer
// state with no store at all — and an effect asserted it DOWNWARD into the engine on every change
// (`engine.getDeck(slot).setMuted(!on)`, App.tsx). That effect is correct and must stay: without it
// the lamp was a claim rather than a reading, and a cart re-dialled onto a channel played into a
// slot whose cut had never been sent.
//
// But it makes the fader section a WRITER of the channel cut, not a display of it. Render that
// section in two windows — which is exactly what the Decks pop-out consolidation does — and each
// window carries its own `{}`, each asserts its own `?? true`, and they fight: the window where the
// operator pressed OFF sends setMuted(true), the other window's effect re-fires and sends
// setMuted(false). Two writers on one channel cut with no arbiter. Jeff: "I'm not shipping two
// writers fighting over a channel cut."
//
// There is no read-back either — DeckState carries `volume` but no `muted` — so a second window
// cannot recover the truth from the engine even if it wanted to. The truth has to be in the row.
//
// SAME SHAPE AS `duck` (v43), deliberately: whether a channel is open is a property OF THAT CHANNEL,
// so it lives on the channel's own row rather than in a side table keyed by slot. The jukebox
// channel already proves the pattern from the other direction — its cut is persisted in
// station_config_kv and its own effect owns it.
//
// DEFAULT 1 — OPEN — and this differs from `duck`'s DEFAULT 0 on purpose. Every existing install
// renders this lamp as `srcChannelOn[slot] ?? true`, so every channel an operator has ever seen is
// ON. A column defaulting to 0 would cut every source channel on the very first launch after the
// update, silently, on machines that are on air. The migration must reproduce what the operator is
// looking at, not what a fresh design would have chosen.
//
// THE JUKEBOX IS NOT EXEMPTED HERE. This column is written for every source channel, but the
// jukebox channel's cut is still owned by station_config_kv + its own effect (default OFF, because
// it faces the public). Nothing reads channel_on for a jukebox-patched slot. Recorded so the next
// person does not "unify" the two and re-open a channel the operator deliberately left closed.
//
// Idempotent — the column add is guarded on the live schema, so a second run is a clean no-op.
// Fail-soft is the caller's contract (runMigrationChain logs and continues).
//
// Verify on a COPY first:
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/verify-channel-on-migration.js

const TABLE = 'deck_configs';

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function columns(db, t) {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); }
  catch { return []; }
}
function isAlreadyMigrated(db) {
  return columns(db, TABLE).includes('channel_on');
}

function applyMigration(db) {
  if (!tableExists(db, TABLE)) {
    console.log('[migrate-v58] deck_configs absent — nothing to migrate.');
    try { db.prepare('INSERT INTO schema_version (version) VALUES (58)').run(); } catch { /* recorded */ }
    return;
  }

  const migrate = db.transaction(() => {
    if (!columns(db, TABLE).includes('channel_on')) {
      db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN channel_on INTEGER NOT NULL DEFAULT 1`).run();
      console.log('[migrate-v58] deck_configs.channel_on added (default 1 — every channel stays as the operator sees it today).');
    } else {
      console.log('[migrate-v58] deck_configs.channel_on already present — no-op.');
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (58)').run(); } catch { /* recorded */ }
  });
  migrate();
  console.log('[migrate-v58] Transaction committed.');
}

module.exports = {
  // Pass-through: `channel_on` is a new scalar on an already-synced table, registered in
  // synced-tables.js. A payload written before v58 simply lacks it and a reader without the column
  // ignores it — there is nothing on the wire to rewrite.
  payloadTransformer: function payloadTransformer(payload) { return payload; },
  applyMigration,
  isAlreadyMigrated,
};
