// audiod/queue-log-order.js — Up Next's Play Next / Move Up / Move Down / Move to Bottom and drag-reorder WRITE THE LOG.
//
// Dead-controls item 26: they reordered only the daemon's in-memory queue, and on the log reader that queue is rebuilt
// from generated_schedule every 2 s (engine._refillFromLog), so a move snapped back. The log is the order, so a move is
// now made IN the log, the way the Program Log moves a row (electron/main.js schedule:moveRow): the rows trade their
// places — scheduled_at and log_hour_ts move together — in ONE transaction, and every row whose place changed is stamped
// source='operator', which is what makes Generate leave it alone. Only a plan is editable: if any row involved is not
// pending (it aired, was skipped, is gone), nothing is written and the move is refused.
//
// The rows' set of places is unchanged; only who holds which place changes. With n rows that is the same result as the
// Program Log's swaps applied one after another, done at once.
"use strict";

/** The log's order key (loggen.logKeySql): the log hour, else the row's own time; then scheduled_at; then id. */
function logKey(r) { return [r.log_hour_ts ?? r.scheduled_at, r.scheduled_at, r.id]; }
function cmp(a, b) {
  const x = logKey(a), y = logKey(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The writes that put the log rows `rows` into the order `newOrderIds`.
 * @param newOrderIds  row ids, in Up Next's new order (only log rows, each once)
 * @param rows         those rows as stored: { id, scheduled_at, log_hour_ts, state }
 * @returns { ok, updates: [{ id, scheduled_at, log_hour_ts }], error? }
 */
function planLogReorder(newOrderIds, rows) {
  const byId = new Map(rows.map(r => [r.id, r]));
  if (newOrderIds.length !== rows.length || newOrderIds.some(id => !byId.has(id))) {
    return { ok: false, updates: [], error: "a row in Up Next is no longer in the log — it may have been regenerated" };
  }
  const notPlan = rows.find(r => !(r.state == null || r.state === "" || r.state === "pending"));
  if (notPlan) return { ok: false, updates: [], error: `row ${notPlan.id} is marked ${notPlan.state} — only a plan can be moved` };
  const places = [...rows].sort(cmp).map(r => ({ scheduled_at: r.scheduled_at, log_hour_ts: r.log_hour_ts ?? null }));
  const updates = [];
  newOrderIds.forEach((id, k) => {
    const r = byId.get(id), p = places[k];
    if (r.scheduled_at !== p.scheduled_at || (r.log_hour_ts ?? null) !== p.log_hour_ts) updates.push({ id, ...p });
  });
  return { ok: true, updates };
}

/**
 * Read the rows, plan, and write — one transaction. → { ok, moved, error? }
 * Works on better-sqlite3 (the daemon) and node:sqlite (tests): plain prepare/run plus BEGIN/COMMIT.
 */
function applyLogReorder(db, stationId, newOrderIds) {
  const ids = [...new Set((newOrderIds || []).filter(x => x != null))];
  if (ids.length < 2) return { ok: true, moved: 0 };
  const rows = db.prepare(`SELECT id, scheduled_at, log_hour_ts, state FROM generated_schedule
                           WHERE station_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`).all(stationId, ...ids);
  const plan = planLogReorder(ids, rows.map(r => ({ ...r })));
  if (!plan.ok) return { ok: false, moved: 0, error: plan.error };
  if (!plan.updates.length) return { ok: true, moved: 0 };
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE generated_schedule SET scheduled_at = ?, log_hour_ts = ?, source = 'operator', updated_at = ?
                           WHERE id = ? AND station_id = ? AND deleted_at IS NULL AND (state IS NULL OR state = '' OR state = 'pending')`);
  db.exec("BEGIN");
  try {
    for (const u of plan.updates) {
      const r = stmt.run(u.scheduled_at, u.log_hour_ts, now, u.id, stationId);
      if (!r || !r.changes) throw new Error(`row ${u.id} changed while it was being moved`);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    return { ok: false, moved: 0, error: e.message };
  }
  return { ok: true, moved: plan.updates.length };
}

module.exports = { planLogReorder, applyLogReorder };
