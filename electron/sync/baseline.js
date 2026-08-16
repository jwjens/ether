"use strict";
/**
 * BASELINE WATERMARK — "history before this moment is the baseline; never re-journal it."
 *
 * THE ONE GATE. Every path that re-journals an existing row must call `shouldSkipAsBaseline()`
 * before writing. Today there is exactly one such path (scripts/backfill-sync-mutations.js); if a
 * startup reseed is ever added it calls this same function, so the rule lives in one place rather
 * than being re-implemented per door.
 *
 * WHAT IT DOES AND DOES NOT SILENCE
 *   - Silences HISTORY: rows that existed before the baseline and have no journal entry stay
 *     unjournaled. That is the point — they are declared already-known, not lost.
 *   - Does NOT silence SELF-HEALING: a row created AFTER the baseline that loses its journal entry
 *     is still re-journaled normally.
 *   - No baseline set -> `shouldSkipAsBaseline()` is always false, i.e. behaviour identical to
 *     today. Installs that never set one (OV pre-update, every customer) are untouched by this
 *     file's existence.
 *
 * STORAGE — `system_state`, key `baseline_hlc`.
 *   The design named a `sync_state` table; there isn't one. `system_state` IS the engine's
 *   persistent sync store — it already holds `hlc_last`, `sync_cursor`, `sync_server_seq` and the
 *   `rebaseline_*` markers — so it is the same property the design was asking for, under the name
 *   the schema actually uses. No new table, nothing to migrate.
 *
 * FORMAT — an HLC string, `<unixMillis>:<counter>:<clientId>`, matching `hlc_last` exactly.
 *
 * THE COMPARISON, STATED HONESTLY. The design specified comparing `hlc_ts`. There is no such
 * column: `mutations` carries `hlc`, and the SOURCE rows this gate actually filters (songs, clocks,
 * generated_schedule …) carry `created_at`, an ISO-8601 wall-clock string. A source row has no HLC
 * — it never had one, because an HLC is minted when a MUTATION is written, not when a row is. So
 * the gate compares the row's `created_at` against the baseline's millisecond component.
 *
 * That is a wall-clock comparison, and the design chose HLC specifically to avoid wall-clock skew.
 * The honest limit: if this machine's clock jumped backwards between a row being written and the
 * baseline being set, a row newer than the baseline could read as older and be skipped. The
 * exposure is small and bounded — it is a one-shot operator action on one machine, not a
 * distributed decision — but it is real, and it is a property of the data, not of this code.
 */

const BASELINE_KEY = "baseline_hlc";

/** Parse the millisecond component out of an HLC string. Returns null for anything unusable. */
function hlcMillis(hlc) {
  if (!hlc || typeof hlc !== "string") return null;
  const ms = parseInt(String(hlc).split(":")[0], 10);
  return Number.isFinite(ms) ? ms : null;
}

/** The stored baseline HLC, or null if none is set. Never throws. */
function getBaseline(db) {
  try {
    return db.prepare("SELECT value FROM system_state WHERE key = ?").get(BASELINE_KEY)?.value ?? null;
  } catch { return null; }
}

/**
 * Declare "everything up to now is the baseline". Uses the engine's own clock (`hlc_last`) when it
 * has one, so the watermark sits on the same timeline as the mutations it silences; falls back to
 * a wall-clock HLC only on a machine that has never written a mutation.
 * @returns {{ok:boolean, baseline?:string, source?:string, error?:string}}
 */
function setBaseline(db, { at = null } = {}) {
  try {
    let baseline = at;
    let source = "explicit";
    if (!baseline) {
      const last = db.prepare("SELECT value FROM system_state WHERE key = 'hlc_last'").get()?.value ?? null;
      if (last) { baseline = last; source = "hlc_last"; }
      else { baseline = `${Date.now()}:0:baseline`; source = "wall-clock (no hlc_last on this install)"; }
    }
    db.prepare(
      `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(BASELINE_KEY, String(baseline), new Date().toISOString());
    const readBack = getBaseline(db);
    if (readBack !== String(baseline)) {
      return { ok: false, error: `baseline did not persist (wrote ${baseline}, read ${readBack})` };
    }
    return { ok: true, baseline: readBack, source };
  } catch (e) { return { ok: false, error: e.message }; }
}

function clearBaseline(db) {
  try { db.prepare("DELETE FROM system_state WHERE key = ?").run(BASELINE_KEY); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/**
 * Build the gate once per run, then ask it per row. Returns a predicate plus the reason string the
 * caller should LOG — a skip that says nothing is indistinguishable from a bug, which is the whole
 * failure this watermark exists to end.
 *
 * @returns {{active:boolean, baseline:string|null, baselineMs:number|null,
 *            shouldSkip:(row:object)=>boolean, describe:()=>string}}
 */
function makeBaselineGate(db) {
  const baseline = getBaseline(db);
  const baselineMs = hlcMillis(baseline);
  const active = baselineMs != null;
  return {
    active,
    baseline,
    baselineMs,
    /** True when this row predates the baseline and must NOT be re-journaled. */
    shouldSkip(row) {
      if (!active) return false;                       // no watermark -> today's behaviour exactly
      const created = row && row.created_at;
      if (created == null) return false;               // no timestamp -> cannot claim it is history
      const ms = typeof created === "number"
        ? (created < 1e12 ? created * 1000 : created)  // epoch seconds vs milliseconds
        : Date.parse(created);
      if (!Number.isFinite(ms)) return false;          // unparseable -> treat as new, never silently drop
      return ms <= baselineMs;
    },
    describe() {
      return active
        ? `baseline ${baseline} (${new Date(baselineMs).toISOString()}) — rows at or before it are declared history`
        : "no baseline set — re-journaling everything, as before";
    },
  };
}

module.exports = { BASELINE_KEY, getBaseline, setBaseline, clearBaseline, makeBaselineGate, hlcMillis };
