// audiod/board-state.js — THE SAVED BOARD, applied to an engine in one step (2026-10-11).
//
// docs/board-state-on-connect-diagnosis-2026-10-11.md. Jeff: "a fader is never asleep. Whatever the board shows must
// be live in the engine from the moment Ether opens, with no touch required."
//
// Before this, a station's board reached the engine only through the windows: each panel sent its values once when it
// mounted, and swallowed a failure. When the app started on its in-process fallback (the daemon slow to come up), those
// sends went to the in-process engine; the handover to the daemon carried only the duck flags; the daemon ran on its
// boot defaults (every AUX row 0) and every Source fader was silent in the room.
//
// ONE module, run wherever the engine runs (Jeff's ruling):
//   · the daemon, for every station when it starts (app open or not) and again whenever main asks (every connect);
//   · main, against the in-process engine, when it falls back.
// It reads the saved values from the database and sends each through the engine's own setters. `readSavedBoard` is also
// what main compares the engine's live values with (compareBoard) to raise board-state-mismatch-error.
//
// Pure apart from the `db` (anything with prepare().get/all: node:sqlite or better-sqlite3) and the `sink` it is given.
"use strict";

const SLOTS = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];
const SOURCE_SLOTS = ["D", "E", "F", "S1", "S2", "S3", "S4", "S5"];
// The ducker's saved parameters and the defaults main has always used for them (main.js armAllStationDuckers).
const DUCK_KEYS = { depthDb: ["duck_depth_db", -22], thresholdDb: ["duck_threshold_db", -45], attackMs: ["duck_attack_ms", 30], holdMs: ["duck_hold_ms", 700], releaseMs: ["duck_release_ms", 500] };
const MASTER_MONITOR_KEY = "master_monitor_volume";   // machine-local (LOCAL_ONLY_KEYS); moved out of localStorage

// ONE NAME PER FADER (Jeff, 2026-09-26; src/lib/boardName.ts — the same rule, ported): engine slot ids S1–S5 are never
// shown to an operator. The board's rows in its own order (every row, enabled or not), completed with every engine
// slot it doesn't list; lettered slots keep their letter; each engine source slot takes the next free letter.
function boardNames(order) {
  const seen = new Set(), list = [];
  for (const x of [...(order || []), ...SLOTS]) { const k = String(x); if (!seen.has(k)) { seen.add(k); list.push(k); } }
  const isLetter = (x) => /^[A-Z]$/.test(x), isEngineSource = (x) => /^S\d+$/.test(x);
  const taken = new Set(list.filter(isLetter)); const out = {};
  let next = 65;
  for (const x of list) {
    if (!isEngineSource(x)) { out[x] = x; continue; }
    while (next <= 90 && taken.has(String.fromCharCode(next))) next++;
    const letter = next <= 90 ? String.fromCharCode(next++) : x;
    taken.add(letter); out[x] = letter;
  }
  return out;
}

const num = (v) => { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n; };
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function kvReader(db, sid) {
  let rows = [];
  try { rows = db.prepare("SELECT key, value FROM station_config_kv WHERE station_id = ? AND deleted_at IS NULL").all(sid); } catch { rows = []; }
  const m = new Map(rows.map(r => [String(r.key), r.value]));
  return (k) => (m.has(k) ? m.get(k) : undefined);
}

/** The room (AUX) row per Source slot — the current map format, or the legacy positional array (AuxMonitorSlots.tsx). */
function parseRoomLevels(rawLvl, rawSlots) {
  const out = {};
  let parsed = null;
  try { parsed = rawLvl ? JSON.parse(rawLvl) : null; } catch { parsed = null; }
  if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
    for (const [k, v] of Object.entries(parsed)) { const n = num(v); if (n != null && SOURCE_SLOTS.includes(k)) out[k] = clamp01(n); }
  } else if (Array.isArray(parsed)) {
    let oldSlots = [];
    try { oldSlots = rawSlots ? (JSON.parse(rawSlots) || []) : []; } catch { oldSlots = []; }
    oldSlots.forEach((deck, i) => { if (deck && SOURCE_SLOTS.includes(deck)) { const n = num(parsed[i]); out[deck] = n == null ? 0.8 : clamp01(n); } });
  }
  return out;
}

/**
 * Everything saved for one station's board. A value that was never saved is ABSENT (the engine's own default stands and
 * is what the board shows); nothing is invented here.
 */
function readSavedBoard(db, sid) {
  const kv = kvReader(db, sid);
  let configs = [];
  try {
    configs = db.prepare(
      "SELECT slot, type, kind, enabled, channel_on, duck, duckable FROM deck_configs WHERE station_id = ? AND deleted_at IS NULL"
    ).all(sid);
  } catch { configs = []; }
  let levels = null;
  try { levels = JSON.parse(kv("board_levels") || "null"); } catch { levels = null; }
  const room = parseRoomLevels(kv("aux_monitor_levels"), kv("aux_monitor_slots"));
  const slots = {};
  for (const c of configs) {
    const s = String(c.slot || "");
    if (!SLOTS.includes(s) || c.enabled === 0 || c.enabled === false) continue;
    const e = {};
    const lv = levels && typeof levels === "object" ? num(levels[s]) : null;
    if (lv != null && lv >= 0 && lv <= 4) e.volume = lv;
    if (c.type === "source") {
      // The cut: the board's ON lamp reads channel_on (v58); the jukebox keeps its own (default OFF).
      if (c.kind === "jukebox") e.muted = kv("jukebox_channel_on") !== "1";
      else if (c.channel_on !== null && c.channel_on !== undefined) e.muted = !(Number(c.channel_on) === 1 || c.channel_on === true);
      e.duck = !!Number(c.duck || 0);
      e.kind = String(c.kind || "");
    }
    e.duckable = c.duckable === null || c.duckable === undefined ? true : !!Number(c.duckable);
    if (SOURCE_SLOTS.includes(s)) e.aux = room[s] ?? 0;   // an unsaved row is 0 — the engine's own default, and what the panel shows
    slots[s] = e;
  }
  let order = [];
  try {
    order = db.prepare("SELECT slot FROM deck_configs WHERE station_id = ? AND deleted_at IS NULL").all(sid)
      .map(r => String(r.slot || "")).filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));   // compareSlots
  } catch { order = []; }
  const out = { stationId: sid, slots, names: boardNames(order) };
  const mv = levels && typeof levels === "object" ? num(levels.master) : null;
  if (mv != null && mv >= 0 && mv <= 1) out.masterVol = mv;
  const mon = num(kv("monitor_volume")); if (mon != null) out.monitorVol = clamp01(mon);
  const mm = num(kv(MASTER_MONITOR_KEY)); if (mm != null) out.masterMonitorVol = clamp01(mm);
  const duck = {};
  for (const [k, [key, def]] of Object.entries(DUCK_KEYS)) { const n = num(kv(key)); duck[k] = n == null ? def : n; }
  out.duckParams = duck;
  const auxDev = kv("aux_monitor_device"); if (auxDev !== undefined) out.auxDevice = String(auxDev || "");
  const cueDev = kv("pfl_cue_device"); if (cueDev !== undefined) out.cueDevice = String(cueDev || "");
  const dim = num(kv("pfl_dim_db")); if (dim != null) out.pflDimDb = dim;
  const outDev = kv("audio_output_device"); if (outDev) out.outputDevice = String(outDev);
  return out;
}

/**
 * Send the saved board to an engine. `sink` is the engine's setters, each returning true/false or throwing:
 *   setVolume(slot, v) setMuted(slot, m) setDuck(slot, on) setDuckable(slot, on) setAuxMonitor(slot, g)
 *   setMonitorVolume(v) setMasterVolume(v) setMasterMonitorVolume(v) setDuckParams(p) setAuxDevice(name)
 *   setCueDevice(name) setPflDim(db)
 * Slot KIND is deliberately not sent: no shipped path has ever sent it, so applying it would move faders onto another
 * bus on air (a Sweeper stops triggering the duck). It is reported by compareBoard instead, pending Jeff's ruling.
 * Returns { sent, failed: [{ setting, reason }] } — never throws, never swallows: every failure is in the result.
 */
function applyBoard(saved, sink) {
  const sent = [], failed = [];
  const call = (setting, fn) => {
    if (typeof fn !== "function") { failed.push({ setting, reason: "this engine has no setter for it" }); return; }
    try { const r = fn(); if (r === false) failed.push({ setting, reason: "the engine refused it" }); else sent.push(setting); }
    catch (e) { failed.push({ setting, reason: String(e && e.message || e) }); }
  };
  for (const [s, e] of Object.entries(saved.slots || {})) {
    if (e.volume !== undefined) call(`${s}.volume`, sink.setVolume && (() => sink.setVolume(s, e.volume)));
    if (e.muted !== undefined) call(`${s}.muted`, sink.setMuted && (() => sink.setMuted(s, e.muted)));
    if (e.duck !== undefined) call(`${s}.duck`, sink.setDuck && (() => sink.setDuck(s, e.duck)));
    if (e.duckable !== undefined) call(`${s}.duckable`, sink.setDuckable && (() => sink.setDuckable(s, e.duckable)));
    if (e.aux !== undefined) call(`${s}.aux`, sink.setAuxMonitor && (() => sink.setAuxMonitor(s, e.aux)));
  }
  if (saved.monitorVol !== undefined) call("monitorVol", sink.setMonitorVolume && (() => sink.setMonitorVolume(saved.monitorVol)));
  if (saved.masterVol !== undefined) call("masterVol", sink.setMasterVolume && (() => sink.setMasterVolume(saved.masterVol)));
  if (saved.masterMonitorVol !== undefined) call("masterMonitorVol", sink.setMasterMonitorVolume && (() => sink.setMasterMonitorVolume(saved.masterMonitorVol)));
  if (saved.duckParams) call("duckParams", sink.setDuckParams && (() => sink.setDuckParams(saved.duckParams)));
  if (saved.auxDevice !== undefined) call("auxDevice", sink.setAuxDevice && (() => sink.setAuxDevice(saved.auxDevice)));
  if (saved.cueDevice !== undefined) call("cueDevice", sink.setCueDevice && (() => sink.setCueDevice(saved.cueDevice)));
  if (saved.pflDimDb !== undefined) call("pflDimDb", sink.setPflDim && (() => sink.setPflDim(saved.pflDimDb)));
  // The OUTPUT device only when the engine is not already on it: a switch reopens the stream, and a reopen while a
  // station airs is a gap on air. "Already on it" is the engine's own report, never assumed.
  if (saved.outputDevice) {
    let cur; try { cur = typeof sink.getOutputDevice === "function" ? sink.getOutputDevice() : undefined; } catch { cur = undefined; }
    if (cur !== saved.outputDevice) call("outputDevice", sink.setOutputDevice && (() => sink.setOutputDevice(saved.outputDevice)));
  }
  return { sent, failed };
}

const close = (a, b) => Math.abs(Number(a) - Number(b)) <= 1e-3;
// The engine's bus for a saved kind (native show::set_slot_kind).
const busOf = (kind) => (kind === "sweeper" || kind === "jingle" ? "sweeper" : "source");

/**
 * Saved vs the engine's live values (`getBoardState` → control and applied). Every difference, named:
 *   [{ setting: "S1.aux", saved: 0.74, live: 0, where: "control" | "applied" }]
 * `applied` absent (no meter frame yet) compares the control copy only.
 */
const WHAT = { volume: "fader", muted: "ON/OFF", duck: "duck", duckable: "ducks under others", aux: "AUX monitor row", kind: "channel type" };
const GLOBAL = { monitorVol: "station MONITOR strip", masterVol: "MASTER", masterMonitorVol: "MONITOR", auxDevice: "AUX output device", cueDevice: "PFL output device", board: "the board" };
/** What an operator calls a setting: the fader's board name and the control — never an engine slot id. */
function labelOf(setting, names) {
  const [slot, what] = String(setting).split(".");
  if (what === undefined) return GLOBAL[slot] || slot;
  return `${(names && names[slot]) || slot} ${WHAT[what] || what}`;
}
function compareBoard(saved, live) {
  const raw = compareBoardRaw(saved, live);
  return raw.map(d => ({ ...d, label: labelOf(d.setting, saved && saved.names) }));
}
function compareBoardRaw(saved, live) {
  const out = [];
  if (!live || !live.ok) return [{ setting: "board", saved: "readable", live: (live && live.reason) || "no answer", where: "engine" }];
  for (const where of ["control", "applied"]) {
    const p = live[where];
    if (!p) continue;
    const ps = p.slots || {};
    for (const [s, e] of Object.entries(saved.slots || {})) {
      const l = ps[s]; if (!l) continue;
      if (e.volume !== undefined && !close(e.volume, l.volume)) out.push({ setting: `${s}.volume`, saved: e.volume, live: l.volume, where });
      if (e.muted !== undefined && !!e.muted !== !!l.muted) out.push({ setting: `${s}.muted`, saved: e.muted, live: l.muted, where });
      if (e.duck !== undefined && !!e.duck !== !!l.duck) out.push({ setting: `${s}.duck`, saved: e.duck, live: l.duck, where });
      if (e.duckable !== undefined && !!e.duckable !== !!l.duckable) out.push({ setting: `${s}.duckable`, saved: e.duckable, live: l.duckable, where });
      if (e.aux !== undefined && !close(e.aux, l.aux_monitor_gain)) out.push({ setting: `${s}.aux`, saved: e.aux, live: l.aux_monitor_gain, where });
      if (e.kind !== undefined && SOURCE_SLOTS.includes(s) && busOf(e.kind) !== l.kind) out.push({ setting: `${s}.kind`, saved: `${e.kind || "(none)"} → ${busOf(e.kind)}`, live: l.kind, where });
    }
    if (saved.monitorVol !== undefined && !close(saved.monitorVol, p.monitor_vol)) out.push({ setting: "monitorVol", saved: saved.monitorVol, live: p.monitor_vol, where });
    if (saved.masterVol !== undefined && !close(saved.masterVol, p.master_vol)) out.push({ setting: "masterVol", saved: saved.masterVol, live: p.master_vol, where });
    if (saved.masterMonitorVol !== undefined && !close(saved.masterMonitorVol, p.master_monitor_vol)) out.push({ setting: "masterMonitorVol", saved: saved.masterMonitorVol, live: p.master_monitor_vol, where });
  }
  if (live.devices && saved.auxDevice !== undefined && String(live.devices.aux || "") !== saved.auxDevice) out.push({ setting: "auxDevice", saved: saved.auxDevice, live: live.devices.aux, where: "control" });
  if (live.devices && saved.cueDevice !== undefined && String(live.devices.cue || "") !== saved.cueDevice) out.push({ setting: "cueDevice", saved: saved.cueDevice, live: live.devices.cue, where: "control" });
  return out;
}

/** Stations that exist (not deleted), for the daemon's start-up pass. */
function listStations(db) {
  try { return db.prepare("SELECT id FROM stations WHERE deleted_at IS NULL ORDER BY id").all().map(r => Number(r.id)).filter(Number.isFinite); }
  catch { return []; }
}

/** The engine's setters as the native addon names them, for one station (daemon and main's in-process fallback). */
function addonSink(A, sid) {
  const has = (f) => typeof A[f] === "function";
  return {
    setVolume: has("audioSetVolume") ? (s, v) => A.audioSetVolume(s, v, sid) : undefined,
    setMuted: has("audioSetMuted") ? (s, m) => A.audioSetMuted(s, !!m, sid) : undefined,
    setDuck: has("audioSetDuck") ? (s, on) => A.audioSetDuck(sid, s, !!on) : undefined,
    setDuckable: has("audioSetDuckable") ? (s, on) => A.audioSetDuckable(sid, s, !!on) : undefined,
    setAuxMonitor: has("audioSetAuxMonitor") ? (s, g) => A.audioSetAuxMonitor(sid, s, g) : undefined,
    setMonitorVolume: has("audioSetMonitorVolume") ? (v) => A.audioSetMonitorVolume(sid, v) : undefined,
    setMasterVolume: has("audioSetMasterVolume") ? (v) => A.audioSetMasterVolume(sid, v) : undefined,
    setMasterMonitorVolume: has("audioSetMasterMonitorVolume") ? (v) => A.audioSetMasterMonitorVolume(sid, v) : undefined,
    setDuckParams: has("audioSetDuckParams") ? (p) => A.audioSetDuckParams(sid, p.depthDb, p.thresholdDb, p.attackMs, p.holdMs, p.releaseMs) : undefined,
    setAuxDevice: has("audioSetAuxDevice") ? (d) => A.audioSetAuxDevice(sid, d || "") : undefined,
    setCueDevice: has("audioSetCueDevice") ? (d) => A.audioSetCueDevice(sid, d || "") : undefined,
    setPflDim: has("audioSetPflDim") ? (db) => A.audioSetPflDim(sid, db) : undefined,
    setOutputDevice: has("audioSetOutputDevice") ? (d) => A.audioSetOutputDevice(sid, d) : undefined,
    getOutputDevice: has("audioGetBoardState") ? () => { const b = JSON.parse(A.audioGetBoardState(sid)); return b && b.ok && b.devices ? (b.devices.output ?? null) : undefined; } : undefined,
  };
}

/** Read + apply for one station against the native addon. Returns the apply report plus what was read. */
function applySavedBoardState(db, A, sid) {
  const saved = readSavedBoard(db, sid);
  const report = applyBoard(saved, addonSink(A, sid));
  return { stationId: sid, saved, ...report };
}

module.exports = { boardNames, labelOf, SLOTS, SOURCE_SLOTS, MASTER_MONITOR_KEY, DUCK_KEYS, readSavedBoard, applyBoard, compareBoard, listStations, addonSink, applySavedBoardState, parseRoomLevels };
