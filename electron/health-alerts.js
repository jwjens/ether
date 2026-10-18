// electron/health-alerts.js — the ONE alert stream (docs/scheduler-rotation-playout-design.md §6.2; Phase 1, 2026-10-18).
//
// The health monitor is Iris's eyes, not a separate brain: every alert is ONE structured event, versioned, on ONE
// stream. The monitor only detects and reports — nothing here decides or fixes anything.
//
//   { v: 1, id, kind, severity, stationUuid, at, observedAt, machineId,
//     row:  { id, uuid, scheduledAt, title } | null,
//     song: { title, artist, file } | null,
//     rule: { key, setting, measured, unit } | null,
//     path, message }
//
//   at          when it happened (ISO), from the detector; observedAt when this machine recorded it.
//   severity    'red' | 'yellow' (the detector's word; a kind's default otherwise).
//   path        which code path saw it (e.g. "go-live:B", "sweeper", "log trigger").
//   message     plain words for a person; everything a program needs is in the other fields.
//
// Where one alert goes, all of them go (publish): the health log (kind 'health-alert'), every Ether window
// ('health:alert'), the :3400 live stream Iris already uses (SSE event 'health:alert'), and GET /api/alerts?since=
// for catch-up after a reconnect. Iris subscribes to the same stream later with no change here (contract:
// docs/iris-ether-contract.md, "Alert stream (read-only)").
"use strict";

const crypto = require("crypto");

const ALERT_SCHEMA_VERSION = 1;
// The kinds Phase 1 raises, with their default severity. Later phases add theirs (design §6.2).
const KINDS = {
  "row-aired-twice":   "red",     // a log row went to air again after it had aired
  "aired-row-changed": "red",     // a row that had aired (or been retired) was rewritten or deleted — any code path
  "not-stamped":       "yellow",  // an element aired and its play / row stamp could not be written, or has no row
  "retired-row-aired": "yellow",  // a row the log had marked missed/skipped aired anyway
};

function _iso(at) {
  if (at == null) return new Date().toISOString();
  if (typeof at === "string") return at;
  const n = Number(at);
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();   // seconds or milliseconds
}

/**
 * deps: ledgerAppend(obj), publish(alert), stationUuidById(id) → uuid|null, machineId() → string|null,
 *       readLedgerTail() → Promise<string> (optional: the current health log's text, for catch-up after a restart)
 */
function createAlerts(deps) {
  const RING = Math.max(100, deps.ringSize || 2000);
  const ring = [];
  let seeded = !deps.readLedgerTail;
  let seeding = null;

  function build(kind, d) {
    const x = d || {};
    const row = (x.rowId != null || x.rowUuid) ? { id: x.rowId ?? null, uuid: x.rowUuid || null, scheduledAt: x.scheduledAt ?? null, title: x.rowTitle ?? x.title ?? null } : null;
    const song = (x.title || x.filePath) ? { title: x.title || null, artist: x.artist || null, file: x.filePath || null } : null;
    return {
      v: ALERT_SCHEMA_VERSION,
      id: crypto.randomUUID(),
      kind: String(kind),
      severity: x.severity === "red" || x.severity === "yellow" ? x.severity : (KINDS[kind] || "yellow"),
      stationUuid: x.stationUuid || (x.stationId != null && deps.stationUuidById ? deps.stationUuidById(x.stationId) : null) || null,
      at: _iso(x.at),
      observedAt: new Date().toISOString(),
      machineId: (deps.machineId && deps.machineId()) || null,
      row, song,
      rule: x.rule && x.rule.key ? { key: x.rule.key, setting: x.rule.setting ?? null, measured: x.rule.measured ?? null, unit: x.rule.unit || null } : null,
      path: x.path || null,
      message: String(x.message || kind),
    };
  }

  function _keep(a) { ring.push(a); if (ring.length > RING) ring.splice(0, ring.length - RING); }

  /** Detect → report. Returns the alert. Never throws: a lost alert line must never break what raised it. */
  function raise(kind, d) {
    const a = build(kind, d);
    _keep(a);
    try { deps.ledgerAppend({ t: a.observedAt, kind: "health-alert", alert: a }); } catch {}
    try { deps.publish(a); } catch {}
    return a;
  }

  // Catch-up across a restart: the current health log is read once, asynchronously, the first time anyone asks.
  function _seed() {
    if (seeded) return Promise.resolve();
    if (!seeding) seeding = Promise.resolve().then(() => deps.readLedgerTail()).then((text) => {
      const old = [];
      for (const ln of String(text || "").split("\n")) {
        if (!ln.includes('"health-alert"')) continue;
        try { const o = JSON.parse(ln); if (o && o.kind === "health-alert" && o.alert && o.alert.v) old.push(o.alert); } catch {}
      }
      const have = new Set(ring.map(a => a.id));
      const merged = [...old.filter(a => !have.has(a.id)), ...ring];
      ring.length = 0; for (const a of merged.slice(-RING)) ring.push(a);
    }).catch(() => {}).then(() => { seeded = true; });
    return seeding;
  }

  /** Alerts observed after `since` (ISO time, or an alert id: everything after that one), oldest first. */
  async function list(opts) {
    await _seed();
    const o = opts || {};
    const limit = Math.max(1, Math.min(RING, Number(o.limit) || 500));
    let out = ring;
    if (o.since) {
      const i = ring.findIndex(a => a.id === o.since);
      if (i >= 0) out = ring.slice(i + 1);
      else { const t = Date.parse(o.since); if (Number.isFinite(t)) out = ring.filter(a => Date.parse(a.observedAt) > t); }
    }
    if (o.stationUuid) out = out.filter(a => a.stationUuid === o.stationUuid);
    return out.slice(-limit);
  }

  return { raise, list, build, KINDS };
}

// ── aired-row-changed: the database triggers (migration v63) append to log_row_changes; this turns each new row into
// an alert. `lastId` is kept by the caller (install-local), so a change made while Ether was closed is still reported.
const WATCHED_NAMES = { scheduled_at: "time", song_id: "song", title: "title", artist: "artist", file_key: "file", file_path: "file",
  duration_s: "length", category_id: "category", content_class: "class", played_at: "aired time", deleted_at: "deleted", station_id: "station", uuid: "identity", state: "state" };
function describeChange(r) {
  let oldRow = {}, newRow = null;
  try { oldRow = JSON.parse(r.old_row || "{}") || {}; } catch {}
  try { newRow = r.new_row ? JSON.parse(r.new_row) : null; } catch {}
  const title = oldRow.title || "(untitled)";
  const when = oldRow.scheduled_at ? new Date(oldRow.scheduled_at * 1000).toLocaleString() : "?";
  if (r.op === "delete") return { title, when, changed: ["deleted"], message: `"${title}" (log row ${r.row_id}, ${when}, ${r.old_state}) was DELETED from the log — it was the record of what aired` };
  const changed = [...new Set(Object.keys(oldRow).filter(k => newRow && String(oldRow[k]) !== String(newRow[k])).map(k => WATCHED_NAMES[k] || k))];
  const st = r.old_state !== r.new_state ? ` (${r.old_state} → ${r.new_state})` : ` (${r.old_state})`;
  return { title, when, changed, message: `"${title}" (log row ${r.row_id}, ${when})${st} was changed after it aired: ${changed.join(", ") || "?"}` };
}
function scanLogRowChanges(db, lastId, raise, opts) {
  const max = (opts && opts.max) || 200;
  let rows;
  try { rows = db.prepare("SELECT id, at, op, row_id, row_uuid, station_id, old_state, new_state, old_row, new_row FROM log_row_changes WHERE id > ? ORDER BY id LIMIT ?").all(lastId || 0, max); }
  catch { return { lastId: lastId || 0, raised: 0, unavailable: true }; }   // a pre-v63 database has no table
  const PER_SWEEP = 20;
  let raised = 0;
  for (const r of rows.slice(0, PER_SWEEP)) {
    const d = describeChange(r);
    let sched = null; try { sched = JSON.parse(r.old_row || "{}").scheduled_at ?? null; } catch {}
    raise("aired-row-changed", { stationId: r.station_id, at: r.at, rowId: r.row_id, rowUuid: r.row_uuid, scheduledAt: sched, rowTitle: d.title, title: d.title,
      path: "log trigger", message: d.message });
    raised++;
  }
  if (rows.length > PER_SWEEP) {
    const by = new Map(); for (const r of rows.slice(PER_SWEEP)) by.set(r.station_id, (by.get(r.station_id) || 0) + 1);
    for (const [sid, n] of by) raise("aired-row-changed", { stationId: sid, at: rows[rows.length - 1].at, path: "log trigger",
      message: `${n} more aired log rows were changed or deleted in the same sweep (log_row_changes ids ${rows[PER_SWEEP].id}–${rows[rows.length - 1].id})` });
    raised += by.size;
  }
  return { lastId: rows.length ? rows[rows.length - 1].id : (lastId || 0), raised };
}

module.exports = { createAlerts, scanLogRowChanges, describeChange, ALERT_SCHEMA_VERSION, KINDS };
