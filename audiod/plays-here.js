// audiod/plays-here.js — ROTATION COUNTS THE PLAYS THAT AIRED ON THIS COMPUTER (Jeff, 2026-10-20: "Each computer's
// rotation rules count the plays that aired on that computer." — docs/scheduler-rotation-playout-design.md §3.9).
//
// play_log syncs between computers (every play records which computer aired it, play_log.machine_id, v63), so a
// station's play_log holds other computers' plays too. Every rotation reader — separation, least-recently-played, the
// sweeper pool order, the jukebox repeat window — adds this ONE condition, so they can never disagree.
//
// Plays recorded before the computer was stored (machine_id NULL, before v63 / 2026-10-18) count on every computer
// (Jeff, 2026-10-20: "Count the old plays with no computer recorded on every computer.").
//
// The machine id is this computer's own client_identity.client_id (the value audiod/playlog.js writes), validated as a
// uuid and inlined as a literal, so no caller's parameter list changes. No id yet → every play counts (today's
// behaviour), never none.
"use strict";

const _ids = new WeakMap();
function machineIdOf(db) {
  if (!db || typeof db !== "object") return null;
  if (_ids.has(db)) return _ids.get(db);
  let id = null;
  try { const r = db.prepare("SELECT client_id FROM client_identity LIMIT 1").get(); id = r && r.client_id ? String(r.client_id).toLowerCase() : null; } catch {}
  if (id && !/^[0-9a-f-]{8,64}$/.test(id)) id = null;
  _ids.set(db, id);
  return id;
}

/** SQL condition: a play_log row that counts for rotation on this computer. `alias` = the play_log alias, or "". */
function playsHere(db, alias) {
  const col = alias ? `${alias}.machine_id` : "machine_id";
  const id = machineIdOf(db);
  return id ? `(${col} = '${id}' OR ${col} IS NULL)` : "1=1";
}

function _resetForTest() { /* WeakMap entries die with their db */ }
module.exports = { playsHere, machineIdOf, _resetForTest };
