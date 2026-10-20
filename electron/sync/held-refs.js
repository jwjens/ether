// electron/sync/held-refs.js — A REFERENCE THAT ARRIVES AS A BARE NUMBER IS HELD, NEVER FILED UNDER OUR NUMBER.
//
// Jeff, 2026-10-20: "hold any incoming song change that has a category number but no ID until that computer's numbering
// is known; Health Monitor line for held changes." (docs/ovevents-categories-and-users-sync-2026-10-20.md §2)
//
// Before this, a change from another computer that carried a reference as that computer's local number, with no stable
// id and no published numbering to translate it, was written AS OUR NUMBER — the category-one-off defect (halloVeen's
// categories are numbered one apart on OVEVENTS and ovowforestmusic). Now the merge keeps this computer's value and
// records the change here. resolveHeld() files it once the sender's numbering is known — only if no newer change has
// set that same field since (then the newer one already stands) — as a LOCAL write: nothing is journaled or sent.
//
// Stored in system_state (this computer's own bookkeeping; never synced). Every reference column is covered — a song's
// category, artist and album take the same path.
"use strict";
const { uuidThroughNumbering } = require("./id-numbering");
const { REGISTRY } = require("./synced-tables");

const KEY = "sync_held_refs";
const MAX = 5000;   // a ceiling on the bookkeeping only; reaching it is reported, never silent

const physical = (t) => (REGISTRY[t] && REGISTRY[t].tableName) || t;
function _read(db) {
  try { const r = db.prepare("SELECT value FROM system_state WHERE key = ?").get(KEY); return r ? JSON.parse(r.value) || [] : []; }
  catch { return []; }
}
function _write(db, list) {
  db.prepare("INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES (?, ?, ?)").run(KEY, JSON.stringify(list), new Date().toISOString());
}
function list(db) { return _read(db); }

/** Record a held reference. Returns false when the bookkeeping is full (the caller reports it). */
function hold(db, e) {
  const all = _read(db);
  const same = (x) => x.table === e.table && x.row_id === e.row_id && x.column === e.column;
  const kept = all.filter(x => !same(x));   // the newest change to a field replaces an older held one for it
  if (kept.length >= MAX) return false;
  kept.push({ mutation_id: e.mutation_id, client_id: e.client_id, table: e.table, column: e.column, ref_table: e.ref_table,
              row_id: e.row_id, their_id: e.their_id, hlc: e.hlc || null, held_at: e.held_at || new Date().toISOString() });
  _write(db, kept);
  return true;
}

/** The change that last SET `column` on this row, from this computer's log (any machine): its id, or null. */
function _lastSetter(db, table, rowId, column) {
  let best = null;
  for (const m of db.prepare("SELECT id, op, hlc, payload_before, payload_after FROM mutations WHERE table_name = ? AND row_id = ? AND op IN ('insert','update')").iterate(table, rowId)) {
    let a, b; try { a = JSON.parse(m.payload_after || "null"); b = JSON.parse(m.payload_before || "null"); } catch { continue; }
    if (!a || !(column in a)) continue;
    if (m.op === "update" && b && column in b && (a[column] ?? null) === (b[column] ?? null)) continue;   // did not change it
    // compareHLC, required here (not at the top): merge-engine requires this module, so a top-level require would be circular.
    if (!best || require("./merge-engine").compareHLC(m.hlc || "0:0:", best.hlc || "0:0:") > 0) best = m;
  }
  return best ? best.id : null;
}

/**
 * File every held reference whose sender's numbering is now known.
 * @returns {{ filed: object[], superseded: object[], waiting: object[], missing: object[] }}
 */
function resolveHeld(db) {
  const out = { filed: [], superseded: [], waiting: [], missing: [] };
  const all = _read(db);
  if (!all.length) return out;
  const writes = [];
  for (const h of all) {
    const uuid = uuidThroughNumbering(db, h.client_id, h.ref_table, h.their_id);
    if (uuid === undefined) { out.waiting.push(h); continue; }                 // still no numbering from that computer
    const last = _lastSetter(db, h.table, h.row_id, h.column);
    if (last && last !== h.mutation_id) { out.superseded.push(h); continue; }  // a newer change set this field — it stands
    if (uuid == null) { out.missing.push({ ...h, why: "that computer has no such row" }); continue; }
    const target = db.prepare(`SELECT id FROM ${physical(h.ref_table)} WHERE uuid = ?`).get(uuid);
    if (!target) { out.missing.push({ ...h, uuid, why: "not on this computer" }); continue; }
    writes.push({ h, id: target.id, uuid });
  }
  db.transaction(() => {
    for (const w of writes) {
      db.prepare(`UPDATE ${physical(w.h.table)} SET ${w.h.column} = ? WHERE uuid = ?`).run(w.id, w.h.row_id);
      out.filed.push({ ...w.h, local_id: w.id, uuid: w.uuid });
    }
    _write(db, out.waiting);   // only the still-waiting stay held
  })();
  return out;
}

/** For the Health Monitor: how many are held, from which computers, and since when. */
function summary(db) {
  const all = _read(db);
  const by = {};
  for (const h of all) { const k = h.client_id; by[k] = by[k] || { count: 0, oldest: h.held_at }; by[k].count++; if (h.held_at < by[k].oldest) by[k].oldest = h.held_at; }
  return { count: all.length, byComputer: by, max: MAX };
}

module.exports = { KEY, MAX, hold, list, resolveHeld, summary };
