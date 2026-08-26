'use strict';

// electron/sync/handlers/date_closing_times.js — DATE-SPECIFIC closing times (v46).
//
// docs/station-date-overrides-design-2026-08-26.md.
//
// The seven recurring closing times live in station_config_kv as closing_time_0..6 (slice 5). This
// table is the date-specific exception on top: one row per (station, date). Modelled on the
// station_config_kv upsert, because that is what the weekday closing times already use and this is
// its date-keyed twin.
//
// THE ROW'S EXISTENCE IS THE OVERRIDE:
//   no row                → that date uses its weekday default
//   row, closing_time set → that date closes at that time
//   row, closing_time ''  → that date has NO closing time, so closing-relative announcements have no
//                           time to fire at — the same thing a blank weekday default already does.
//
// So "clear the override" (delete the row → back to the weekday default) and "this date has no
// closing time" (keep the row, blank the time) are DIFFERENT operations, and both are needed. That
// is the only subtlety in this file.
//
// No "closed" flag and no suppression anywhere, per Jeff's ruling of 2026-08-26. This decides what a
// date's closing time IS; it never decides whether anything fires.

const crypto = require('crypto');
const { withMutation, serializePayload } = require('../mutation-writer');
const { REGISTRY } = require('../synced-tables');

const TABLE = 'date_closing_times';

// ── Scope guard ───────────────────────────────────────────────────────────────

function validateScope() {
  const entry = REGISTRY[TABLE];
  if (!entry) throw new Error(`[date_closing_times] unknown table in registry: "${TABLE}"`);
  if (entry.scope !== 'station') {
    throw new Error(`[date_closing_times] expected station-scoped table, registry has "${entry.scope}"`);
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' and a real calendar date — '2026-02-31' is rejected, not silently normalised. */
function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const [y, m, d] = String(s).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** '' stays '' (an explicit "no closing time"). Otherwise normalise to HH:MM:SS, or null if unusable. */
function normalizeClosing(t) {
  if (t == null || t === '') return '';
  const p = String(t).split(':');
  if (p.length < 2 || p.length > 3) return null;
  const h = Number(p[0]), m = Number(p[1]), s = p.length > 2 ? Number(p[2]) : 0;
  if (![h, m, s].every(n => Number.isInteger(n))) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Live overrides for a station, optionally within an inclusive date range ('YYYY-MM-DD' sorts
 *  lexically in chronological order, which is why the range works as plain string comparison). */
function dateClosingList(db, stationId, opts) {
  const o = opts || {};
  let sql = `SELECT * FROM ${TABLE} WHERE deleted_at IS NULL`;
  const params = [];
  if (stationId != null) { sql += ' AND station_id = ?'; params.push(stationId); }
  if (o.from) { sql += ' AND date >= ?'; params.push(String(o.from)); }
  if (o.to)   { sql += ' AND date <= ?'; params.push(String(o.to)); }
  sql += ' ORDER BY date';
  return db.prepare(sql).all(...params);
}

function dateClosingGet(db, stationId, date) {
  return db.prepare(
    `SELECT * FROM ${TABLE} WHERE station_id = ? AND date = ? AND deleted_at IS NULL`
  ).get(stationId, date) ?? null;
}

// ── Writes — always through withMutation, so every change journals for sync ────

function dateClosingUpsert(db, stationId, date, closingTime) {
  validateScope();
  if (stationId == null) throw new Error('[date_closing_times] station_id required');
  if (!isValidDate(date)) throw new Error(`[date_closing_times] expected YYYY-MM-DD, got "${date}"`);
  const value = normalizeClosing(closingTime);
  if (value === null) throw new Error(`[date_closing_times] expected HH:MM or HH:MM:SS, got "${closingTime}"`);

  // A soft-deleted row for this date is REUSED rather than shadowed by a second row — the unique
  // index is partial on deleted_at, so both could otherwise exist and the resolver would have to
  // pick one.
  const existing = db.prepare(
    `SELECT * FROM ${TABLE} WHERE station_id = ? AND date = ? ORDER BY deleted_at IS NULL DESC, rowid DESC LIMIT 1`
  ).get(stationId, date);
  const now = new Date().toISOString();

  if (!existing) {
    const uuid = crypto.randomUUID();
    const row = {
      date, closing_time: value, station_id: stationId, uuid,
      created_at: now, updated_at: now, deleted_at: null,
    };
    withMutation(db, {
      table_name: TABLE, row_id: uuid, op: 'insert',
      payload_before: null, payload_after: serializePayload(row, TABLE),
      station_id: stationId, actor_id: null,
    }, () => {
      db.prepare(
        `INSERT INTO ${TABLE} (date, closing_time, station_id, uuid, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(row.date, row.closing_time, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at);
    });
    return dateClosingGet(db, stationId, date);
  }

  // NO-OP GUARD, the station_config_kv lesson: a write that changes nothing must never journal a
  // mutation, because every mutation is pushed, pulled, applied and retained by every peer forever.
  // Resurrecting a tombstoned row IS a real change, so deleted_at is part of the comparison.
  if (String(existing.closing_time ?? '') === value && existing.deleted_at == null) {
    return existing;
  }

  const before  = serializePayload(existing, TABLE);
  const updated = { ...existing, closing_time: value, deleted_at: null, updated_at: now };
  withMutation(db, {
    table_name: TABLE, row_id: existing.uuid, op: 'update',
    payload_before: before, payload_after: serializePayload(updated, TABLE),
    station_id: stationId, actor_id: null,
  }, () => {
    db.prepare(
      `UPDATE ${TABLE} SET closing_time = ?, deleted_at = NULL, updated_at = ? WHERE uuid = ?`
    ).run(value, now, existing.uuid);
  });
  return dateClosingGet(db, stationId, date);
}

/** Remove the override entirely — this date goes back to its WEEKDAY default. Not the same as
 *  setting a blank closing time, which keeps the row and means "no closing time on this date". */
function dateClosingClear(db, stationId, date) {
  validateScope();
  const existing = dateClosingGet(db, stationId, date);
  if (!existing) return { ok: true, cleared: false };   // already absent — nothing to journal

  withMutation(db, {
    table_name: TABLE, row_id: existing.uuid, op: 'delete',
    payload_before: serializePayload(existing, TABLE), payload_after: null,
    station_id: stationId, actor_id: null,
  }, () => {
    const now = new Date().toISOString();
    db.prepare(`UPDATE ${TABLE} SET deleted_at = ?, updated_at = ? WHERE uuid = ?`).run(now, now, existing.uuid);
  });
  return { ok: true, cleared: true };
}

module.exports = {
  TABLE,
  isValidDate,
  normalizeClosing,
  validateScope,
  dateClosingList,
  dateClosingGet,
  dateClosingUpsert,
  dateClosingClear,
};
