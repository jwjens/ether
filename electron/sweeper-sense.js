// sweeper-sense — is imaging actually reaching air? (audit 15, Jeff's GO 2026-09-27)
//
// One row per station in the Health Monitor: sweepers PLACED today (in the log), FIRED today (play_log, stamped only
// when the daemon observed samples flowing), SKIPPED at placement today with the reason, plus a level:
//
//   RED    sweepers are assigned for the hours that just aired, at least an hour has aired, and NONE fired in the last
//          hour of AIR. Air, not wall time: the last 3,600 s of the station's own audio in play_log, however long ago
//          that stretch began — a station switched off overnight is not "an hour without sweepers".
//   GREEN  one or more fired in that hour.
//   GREY   nothing assigned, less than an hour aired, or no assignment covers the hours that aired. Never an alarm.
//
// The overlay sweepers are excluded from air time: they play on top of music, so counting them would count the same
// seconds twice. Plays with no recorded length add nothing (they cannot be measured).
"use strict";

const AIR_WINDOW_SEC = 3600;
const ALWAYS = 16777215;
const OVERLAY = new Set(["SWP", "JIN"]);
const KEEP_DAYS = 7;
const PLACEMENT_KEY = "sweeper_placement_log";

const localHour = (t) => new Date(t * 1000).getHours();
const localDate = (t) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** plays newest-first → { start, airSec, hours } covering the last hour of air, or null if less than an hour aired. */
function airWindow(plays, airSec = AIR_WINDOW_SEC) {
  let cum = 0; const hours = new Set();
  for (const p of plays || []) {
    if (OVERLAY.has(String(p.content_class || ""))) continue;
    const d = Math.max(0, Number(p.duration_ms) || 0) / 1000;
    if (d <= 0) continue;
    cum += d; hours.add(localHour(p.played_at));
    if (cum >= airSec) return { start: p.played_at, airSec: cum, hours: [...hours] };
  }
  return null;
}

function senseLevel({ assignedMask, window, firedInWindow }) {
  if (!assignedMask) return { level: "grey", reason: "no sweepers are assigned to this station" };
  if (!window) return { level: "grey", reason: "less than an hour on air yet — nothing to judge" };
  if (!window.hours.some(h => (assignedMask >> h) & 1)) return { level: "grey", reason: "no sweeper assignment covers the hours that just aired" };
  if (firedInWindow > 0) return { level: "green", reason: `${firedInWindow} fired in the last hour of air` };
  return { level: "red", reason: "sweepers are assigned, but none fired in the last hour of air" };
}

/** Merge one placement run's per-date tallies into the stored log; keep the newest KEEP_DAYS dates. */
function mergePlacementLog(log, add) {
  const out = { ...(log || {}) };
  for (const [date, t] of Object.entries(add || {})) {
    const cur = out[date] || { placed: 0, off_hours: 0, no_fit: 0, no_file: 0 };
    out[date] = { placed: cur.placed + (t.placed || 0), off_hours: cur.off_hours + (t.off_hours || 0),
                  no_fit: cur.no_fit + (t.no_fit || 0), no_file: cur.no_file + (t.no_file || 0) };
  }
  const keep = Object.keys(out).sort().slice(-KEEP_DAYS);
  return Object.fromEntries(keep.map(k => [k, out[k]]));
}

/** Called by _placeJingles with this run's tallies. Synced with the station (upsertByKey) so every machine sees it. */
function recordPlacement(db, stationId, tallies) {
  try {
    if (!tallies || !Object.keys(tallies).length) return;
    const kv = require("./sync/handlers/station_config_kv");
    const r = db.prepare("SELECT value FROM station_config_kv WHERE station_id = ? AND key = ? AND deleted_at IS NULL").get(stationId, PLACEMENT_KEY);
    let log = {}; try { log = JSON.parse((r && r.value) || "{}") || {}; } catch { log = {}; }
    kv.stationConfigKvUpsertByKey(db, stationId, PLACEMENT_KEY, JSON.stringify(mergePlacementLog(log, tallies)));
  } catch (e) { console.error("[sweeper-sense] recordPlacement:", e.message); }
}

/** The whole sense for one station, read from the DB. */
function senseStation(db, stationId, now) {
  const dayStart = Math.floor(new Date(new Date(now * 1000).setHours(0, 0, 0, 0)).getTime() / 1000);
  let mask = 0;
  try {
    for (const c of db.prepare("SELECT overlay_active_hours FROM categories WHERE station_id = ? AND deleted_at IS NULL AND overlay_kind IS NOT NULL AND overlay_kind != ''").all(stationId)) {
      mask |= (c.overlay_active_hours != null ? c.overlay_active_hours : ALWAYS);
    }
    const fb = db.prepare("SELECT value FROM station_config_kv WHERE station_id = ? AND key = 'overlay_fallback_category_id' AND deleted_at IS NULL").get(stationId);
    if (fb && fb.value) mask = ALWAYS;     // the fallback pool has no hours gate
  } catch { /* pre-overlay schema → nothing assigned */ }
  mask = mask >>> 0;
  const one = (sql, ...a) => { try { const r = db.prepare(sql).get(...a); return r ? Number(r.n) || 0 : 0; } catch { return 0; } };
  const placed = one("SELECT COUNT(*) n FROM generated_schedule WHERE station_id = ? AND content_class = 'SWP' AND deleted_at IS NULL AND scheduled_at >= ? AND scheduled_at < ?", stationId, dayStart, dayStart + 86400);
  const fired = one("SELECT COUNT(*) n FROM play_log WHERE station_id = ? AND content_class IN ('SWP','JIN') AND deleted_at IS NULL AND played_at >= ? AND played_at <= ?", stationId, dayStart, now);
  let plays = [];
  try { plays = db.prepare("SELECT played_at, duration_ms, content_class FROM play_log WHERE station_id = ? AND deleted_at IS NULL AND played_at <= ? AND played_at >= ? ORDER BY played_at DESC LIMIT 2000").all(stationId, now, now - 7 * 86400); } catch { plays = []; }
  const window = airWindow(plays);
  const firedInWindow = window ? one("SELECT COUNT(*) n FROM play_log WHERE station_id = ? AND content_class IN ('SWP','JIN') AND deleted_at IS NULL AND played_at >= ? AND played_at <= ?", stationId, window.start, now) : 0;
  let skipped = { off_hours: 0, no_fit: 0, no_file: 0 };
  try {
    const r = db.prepare("SELECT value FROM station_config_kv WHERE station_id = ? AND key = ? AND deleted_at IS NULL").get(stationId, PLACEMENT_KEY);
    const t = (JSON.parse((r && r.value) || "{}") || {})[localDate(now)];
    if (t) skipped = { off_hours: t.off_hours || 0, no_fit: t.no_fit || 0, no_file: t.no_file || 0 };
  } catch { /* nothing recorded */ }
  let stationUuid = null; try { const s = db.prepare("SELECT uuid FROM stations WHERE id = ?").get(stationId); stationUuid = s ? s.uuid : null; } catch {}
  const lv = senseLevel({ assignedMask: mask, window, firedInWindow });
  return { stationUuid, assigned: mask !== 0, placed, fired, skipped, windowStart: window ? window.start : null, firedInWindow, ...lv };
}

module.exports = { airWindow, senseLevel, mergePlacementLog, recordPlacement, senseStation, localDate, AIR_WINDOW_SEC, PLACEMENT_KEY };
