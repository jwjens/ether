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
// THE DUCKER'S VALUES COME ONLY FROM PREFERENCES (Jeff's ruling, 2026-10-13). These are the keys, nothing else: there is
// no default here. A station whose Preferences have no ducker values yet gets the starting values written INTO its
// Preferences once by main (seedDuckPreferences, from audiod/duck-defaults.js — the one place they live), and until
// then the engine is sent nothing and does not duck. docs/duck-from-preferences-2026-10-13.md.
const DUCK_KEYS = { depthDb: "duck_depth_db", thresholdDb: "duck_threshold_db", attackMs: "duck_attack_ms", holdMs: "duck_hold_ms", releaseMs: "duck_release_ms" };
const DUCK_START = require("./duck-defaults");
const MASTER_MONITOR_KEY = "master_monitor_volume";   // machine-local (LOCAL_ONLY_KEYS); moved out of localStorage
// FADERS ARE GENERIC (Jeff, 2026-10-11). Each fader's three routing settings: where it is heard locally (`fader_local`,
// { slot: "aux" | "main" }), whether it ducks the music (deck_configs.duck) and whether the music ducks it
// (deck_configs.duckable). FADER_ROUTING_FLAG marks a station whose stored values have been migrated to today's
// EFFECTIVE behaviour; until then they are read the way the engine has always applied them, so nothing moves on air.
const FADER_LOCAL_KEY = "fader_local";
const FADER_ROUTING_FLAG = "fader_routing_v1";
const SMOOTHING_KEY = "fader_smoothing_ms";
const LOUDNESS_TARGET_KEY = "loudness_target_lufs";
// The CART channel's ON/OFF ("1"/"0"). It lived only in a window's localStorage and was re-sent on every mount
// (2026-10-12: the window never writes a board value); it is saved with the station and restored here.
const CART_ON_KEY = "cart_channel_on";
// The most any fader, MASTER, MONITOR or row can be set to: +10 dB (the engine's own ceiling).
const MAX_GAIN = Math.pow(10, 10 / 20);
// EACH FADER GROUP'S TOP is a visible setting (Jeff, 2026-10-11): "MASTER and MONITOR top out at unity … Channel faders
// and AUX rows keep +10 dB at the top. The maximum for each fader group is a visible setting, not hard-coded."
// dB, 0…+10. A level is never restored or sent above its group's top (src/lib/faderLaw.ts draws the same curve to it).
const FADER_TOP_KEYS = { channel: "fader_top_db_channel", aux: "fader_top_db_aux", master: "fader_top_db_master", monitor: "fader_top_db_monitor" };
const FADER_TOP_DEFAULTS = { channel: 10, aux: 10, master: 0, monitor: 0 };
const dbGain = (db) => Math.pow(10, db / 20);

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
const clampGain = (v) => Math.max(0, Math.min(MAX_GAIN, v));

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
    for (const [k, v] of Object.entries(parsed)) { const n = num(v); if (n != null && SLOTS.includes(k)) out[k] = clampGain(n); }
  } else if (Array.isArray(parsed)) {
    let oldSlots = [];
    try { oldSlots = rawSlots ? (JSON.parse(rawSlots) || []) : []; } catch { oldSlots = []; }
    oldSlots.forEach((deck, i) => { if (deck && SLOTS.includes(deck)) { const n = num(parsed[i]); out[deck] = n == null ? 0.8 : clampGain(n); } });
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
  let local = {};
  try { local = JSON.parse(kv(FADER_LOCAL_KEY) || "{}") || {}; } catch { local = {}; }
  const migrated = kv(FADER_ROUTING_FLAG) === "1";
  const slots = {};
  for (const c of configs) {
    const s = String(c.slot || "");
    if (!SLOTS.includes(s) || c.enabled === 0 || c.enabled === false) continue;
    const e = {};
    const lv = levels && typeof levels === "object" ? num(levels[s]) : null;
    if (lv != null && lv >= 0 && lv <= MAX_GAIN + 1e-6) e.volume = lv;
    if (c.type === "source") {
      // The cut: the board's ON lamp reads channel_on (v58); the jukebox keeps its own (default OFF).
      if (c.kind === "jukebox") e.muted = kv("jukebox_channel_on") !== "1";
      else if (c.channel_on !== null && c.channel_on !== undefined) e.muted = !(Number(c.channel_on) === 1 || c.channel_on === true);
    }
    // THE THREE ROUTING SETTINGS. Once migrated: each fader's own stored values, read the same way for every fader.
    // Before: exactly what the engine has always done (a source-channel row ducks per its toggle, is never ducked and
    // is heard on AUX; any other row never ducks, is ducked per its toggle and is heard on the main output).
    const storedDuck = !!Number(c.duck || 0);
    const storedDucked = c.duckable === null || c.duckable === undefined ? true : !!Number(c.duckable);
    const wasSource = c.type === "source";
    if (migrated) {
      e.duck = storedDuck; e.duckable = storedDucked;
      e.local = local[s] === "aux" ? "aux" : local[s] === "main" ? "main" : (wasSource ? "aux" : "main");
    } else {
      e.duck = wasSource ? storedDuck : false;
      e.duckable = wasSource ? false : storedDucked;
      e.local = wasSource ? "aux" : "main";
    }
    if (room[s] !== undefined) e.aux = room[s];
    else if (e.local === "aux") e.aux = 0;   // an unsaved AUX row is 0 — the engine's own default, and what the panel shows
    slots[s] = e;
  }
  // CART's cut, when saved and not already given by a board row of its own (a CART row's ON lamp is the newer truth).
  const cartOn = kv(CART_ON_KEY);
  if ((cartOn === "0" || cartOn === "1") && !(slots.CART && slots.CART.muted !== undefined)) slots.CART = { ...(slots.CART || {}), muted: cartOn !== "1" };
  let order = [];
  try {
    order = db.prepare("SELECT slot FROM deck_configs WHERE station_id = ? AND deleted_at IS NULL").all(sid)
      .map(r => String(r.slot || "")).filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));   // compareSlots
  } catch { order = []; }
  const out = { stationId: sid, slots, names: boardNames(order) };
  const mv = levels && typeof levels === "object" ? num(levels.master) : null;
  if (mv != null && mv >= 0 && mv <= MAX_GAIN + 1e-6) out.masterVol = mv;
  const mon = num(kv("monitor_volume")); if (mon != null) out.monitorVol = clampGain(mon);
  // MASTER MONITOR is ONE level for every station on this machine: this station's saved value, else any station's.
  // NOT KNOWN = SILENT (Jeff, 2026-10-11): "the local output stays silent until the saved master MONITOR level is known,
  // then applies it. Never play the room at 0 dB as a placeholder." Air is unaffected (MONITOR never touches air).
  let mm = num(kv(MASTER_MONITOR_KEY));
  if (mm == null) {
    try { const r = db.prepare("SELECT value FROM station_config_kv WHERE key = ? AND deleted_at IS NULL AND value IS NOT NULL AND value != '' LIMIT 1").get(MASTER_MONITOR_KEY); mm = r ? num(r.value) : null; } catch { mm = null; }
  }
  out.masterMonitorKnown = mm != null;
  out.masterMonitorVol = mm != null ? clampGain(mm) : 0;
  const sm = num(kv(SMOOTHING_KEY)); out.smoothingMs = sm == null ? 20 : Math.max(0, Math.min(500, sm));
  // The fader groups' tops, and every restored level held at or below its group's top.
  out.faderTopDb = {};
  for (const [g, key] of Object.entries(FADER_TOP_KEYS)) { const v = num(kv(key)); out.faderTopDb[g] = v == null ? FADER_TOP_DEFAULTS[g] : Math.max(0, Math.min(10, v)); }
  const cap = (v, g) => (v === undefined ? v : Math.min(v, dbGain(out.faderTopDb[g])));
  for (const e of Object.values(out.slots)) { e.volume = cap(e.volume, "channel"); e.aux = cap(e.aux, "aux"); if (e.volume === undefined) delete e.volume; if (e.aux === undefined) delete e.aux; }
  if (out.masterVol !== undefined) out.masterVol = cap(out.masterVol, "master");
  if (out.monitorVol !== undefined) out.monitorVol = cap(out.monitorVol, "monitor");
  out.masterMonitorVol = cap(out.masterMonitorVol, "monitor");
  const lt = num(kv(LOUDNESS_TARGET_KEY)); out.loudnessTargetLufs = lt == null ? -16 : lt;
  // The ducker: exactly what Preferences holds, all five values, or nothing (never a number from here).
  const duck = {}, duckMissing = [];
  for (const [k, key] of Object.entries(DUCK_KEYS)) { const n = num(kv(key)); if (n == null) duckMissing.push(key); else duck[k] = n; }
  out.duckParams = duckMissing.length ? null : duck;
  if (duckMissing.length) out.duckMissing = duckMissing;
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
 * No fader TYPE is read, sent or compared (Jeff, 2026-10-11: "faders are generic shells … a stored type on a fader is
 * wrong"). deck_configs.kind is read only to find the jukebox's own cut — it is the source input selected on the fader.
 * Returns { sent, failed: [{ setting, reason }] } — never throws, never swallows: every failure is in the result.
 */
function applyBoard(saved, sink) {
  const sent = [], failed = [];
  const call = (setting, fn) => {
    if (typeof fn !== "function") { failed.push({ setting, reason: "this engine has no setter for it" }); return; }
    try { const r = fn(); if (r === false) failed.push({ setting, reason: "the engine refused it" }); else sent.push(setting); }
    catch (e) { failed.push({ setting, reason: String(e && e.message || e) }); }
  };
  // FIRST: the room's level — silent when it is not known — before anything that could make a sound locally.
  if (saved.masterMonitorVol !== undefined) call("masterMonitorVol", sink.setMasterMonitorVolume && (() => sink.setMasterMonitorVolume(saved.masterMonitorVol)));
  for (const [s, e] of Object.entries(saved.slots || {})) {
    if (e.volume !== undefined) call(`${s}.volume`, sink.setVolume && (() => sink.setVolume(s, e.volume)));
    if (e.muted !== undefined) call(`${s}.muted`, sink.setMuted && (() => sink.setMuted(s, e.muted)));
    if (e.duck !== undefined) call(`${s}.duck`, sink.setDuck && (() => sink.setDuck(s, e.duck)));
    if (e.duckable !== undefined) call(`${s}.duckable`, sink.setDuckable && (() => sink.setDuckable(s, e.duckable)));
    if (e.local !== undefined) call(`${s}.local`, sink.setLocalOutput && (() => sink.setLocalOutput(s, e.local === "aux")));
    if (e.aux !== undefined) call(`${s}.aux`, sink.setAuxMonitor && (() => sink.setAuxMonitor(s, e.aux)));
  }
  if (saved.monitorVol !== undefined) call("monitorVol", sink.setMonitorVolume && (() => sink.setMonitorVolume(saved.monitorVol)));
  if (saved.masterVol !== undefined) call("masterVol", sink.setMasterVolume && (() => sink.setMasterVolume(saved.masterVol)));
  if (saved.duckParams) call("duckParams", sink.setDuckParams && (() => sink.setDuckParams(saved.duckParams)));
  if (saved.auxDevice !== undefined) call("auxDevice", sink.setAuxDevice && (() => sink.setAuxDevice(saved.auxDevice)));
  if (saved.cueDevice !== undefined) call("cueDevice", sink.setCueDevice && (() => sink.setCueDevice(saved.cueDevice)));
  if (saved.pflDimDb !== undefined) call("pflDimDb", sink.setPflDim && (() => sink.setPflDim(saved.pflDimDb)));
  if (saved.smoothingMs !== undefined) call("smoothingMs", sink.setFaderSmoothing && (() => sink.setFaderSmoothing(saved.smoothingMs)));
  // The OUTPUT device only when the engine is not already on it: a switch reopens the stream, and a reopen while a
  // station airs is a gap on air. "Already on it" is the engine's own report, never assumed.
  if (saved.outputDevice) {
    let cur; try { cur = typeof sink.getOutputDevice === "function" ? sink.getOutputDevice() : undefined; } catch { cur = undefined; }
    if (cur !== saved.outputDevice) call("outputDevice", sink.setOutputDevice && (() => sink.setOutputDevice(saved.outputDevice)));
  }
  return { sent, failed };
}

const close = (a, b) => Math.abs(Number(a) - Number(b)) <= 1e-3;

/**
 * Saved vs the engine's live values (`getBoardState` → control and applied). Every difference, named:
 *   [{ setting: "S1.aux", saved: 0.74, live: 0, where: "control" | "applied" }]
 * `applied` absent (no meter frame yet) compares the control copy only.
 */
const WHAT = { volume: "fader", muted: "ON/OFF", duck: "ducks music", duckable: "ducked by others", aux: "local row", local: "local output" };
const GLOBAL = { monitorVol: "station MONITOR strip", masterVol: "MASTER", masterMonitorVol: "MONITOR", auxDevice: "AUX output device", cueDevice: "PFL output device", board: "the board",
  duckDepth: "Ducker depth", duckThreshold: "Ducker threshold", duckAttack: "Ducker attack", duckHold: "Ducker hold", duckRelease: "Ducker release",
  duckPrefs: "Ducker settings in Preferences", duckEngine: "Ducker settings in the engine" };
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
      if (e.local !== undefined && l.local !== undefined && e.local !== l.local) out.push({ setting: `${s}.local`, saved: e.local, live: l.local, where });
    }
    if (saved.monitorVol !== undefined && !close(saved.monitorVol, p.monitor_vol)) out.push({ setting: "monitorVol", saved: saved.monitorVol, live: p.monitor_vol, where });
    if (saved.masterVol !== undefined && !close(saved.masterVol, p.master_vol)) out.push({ setting: "masterVol", saved: saved.masterVol, live: p.master_vol, where });
    if (saved.masterMonitorVol !== undefined && !close(saved.masterMonitorVol, p.master_monitor_vol)) out.push({ setting: "masterMonitorVol", saved: saved.masterMonitorVol, live: p.master_monitor_vol, where });
  }
  // THE DUCKER (Jeff, 2026-10-13: "If Preferences and the engine ever disagree, it shows on the Health page as an
  // error"): Preferences' five values against the engine's own copy (board.rs duck_params — null until it was sent
  // values). The engine clamps at its edges (show.rs set_duck_params), so a Preferences value outside them shows here too.
  const cd = live.control;
  if (cd) {
    const ld = cd.duck_params;
    if (!saved.duckParams) out.push({ setting: "duckPrefs", saved: `missing ${(saved.duckMissing || []).join(", ")}`, live: ld ? "set" : "not set", where: "control" });
    else if (!ld) out.push({ setting: "duckEngine", saved: "set", live: "not set — the engine was never sent the ducker's values", where: "control" });
    else {
      const thrDb = ld.threshold > 0 ? 20 * Math.log10(ld.threshold) : -Infinity;
      for (const [setting, sv, lv, tol] of [["duckDepth", saved.duckParams.depthDb, ld.depth_db, 0.05], ["duckThreshold", saved.duckParams.thresholdDb, thrDb, 0.05],
                                            ["duckAttack", saved.duckParams.attackMs, ld.attack_ms, 0.5], ["duckHold", saved.duckParams.holdMs, ld.hold_ms, 0.5],
                                            ["duckRelease", saved.duckParams.releaseMs, ld.release_ms, 0.5]]) {
        if (!(Math.abs(Number(sv) - Number(lv)) <= tol)) out.push({ setting, saved: sv, live: Number.isFinite(lv) ? Math.round(lv * 100) / 100 : lv, where: "control" });
      }
    }
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
    setLocalOutput: has("audioSetLocalOutput") ? (s, aux) => A.audioSetLocalOutput(sid, s, !!aux) : undefined,
    setFaderSmoothing: has("audioSetFaderSmoothing") ? (ms) => A.audioSetFaderSmoothing(sid, ms) : undefined,
    getOutputDevice: has("audioGetBoardState") ? () => { const b = JSON.parse(A.audioGetBoardState(sid)); return b && b.ok && b.devices ? (b.devices.output ?? null) : undefined; } : undefined,
  };
}

/** Read + apply for one station against the native addon. Returns the apply report plus what was read. */
function applySavedBoardState(db, A, sid) {
  const saved = readSavedBoard(db, sid);
  const report = applyBoard(saved, addonSink(A, sid));
  return { stationId: sid, saved, ...report };
}

/**
 * THE ONE-TIME ROUTING MIGRATION (Jeff, 2026-10-11: "Migration writes in today's behaviour so nothing changes on air or
 * in the room at update"). Returns the writes that make a station's stored routing say exactly what the engine already
 * does — after them, every fader's three settings are read the same way. Nothing for an already-migrated station.
 *   [{ table: "deck_configs", slot, patch }, { table: "kv", key, value }]
 */
function routingMigration(db, sid) {
  const kv = kvReader(db, sid);
  if (kv(FADER_ROUTING_FLAG) === "1") return [];
  let rows = [];
  try { rows = db.prepare("SELECT slot, type, duck, duckable FROM deck_configs WHERE station_id = ? AND deleted_at IS NULL").all(sid); } catch { rows = []; }
  const writes = [], local = {};
  for (const r of rows) {
    const s = String(r.slot || ""); if (!SLOTS.includes(s)) continue;
    const wasSource = r.type === "source";
    local[s] = wasSource ? "aux" : "main";
    const storedDucked = r.duckable === null || r.duckable === undefined ? true : !!Number(r.duckable);
    const duck = wasSource ? !!Number(r.duck || 0) : false;
    const ducked = wasSource ? false : storedDucked;
    const patch = {};
    if (!!Number(r.duck || 0) !== duck) patch.duck = duck ? 1 : 0;
    if (storedDucked !== ducked) patch.duckable = ducked ? 1 : 0;
    if (Object.keys(patch).length) writes.push({ table: "deck_configs", slot: s, patch });
  }
  writes.push({ table: "kv", key: FADER_LOCAL_KEY, value: JSON.stringify(local) });
  writes.push({ table: "kv", key: FADER_ROUTING_FLAG, value: "1" });
  return writes;
}

/** The gain cap of one fader group for a station (main clamps every live setter with it). */
function groupTopGain(db, sid, group) {
  const key = FADER_TOP_KEYS[group]; if (!key) return MAX_GAIN;
  let v = null;
  try { const r = db.prepare("SELECT value FROM station_config_kv WHERE station_id = ? AND key = ? AND deleted_at IS NULL").get(sid, key); v = r ? num(r.value) : null; } catch { v = null; }
  return dbGain(v == null ? FADER_TOP_DEFAULTS[group] : Math.max(0, Math.min(10, v)));
}

/** Every station_config_kv key readSavedBoard reads — a write to any other key cannot change the saved board. */
const BOARD_KV_KEYS = new Set(["board_levels", "aux_monitor_levels", "aux_monitor_slots", FADER_LOCAL_KEY, FADER_ROUTING_FLAG,
  "monitor_volume", MASTER_MONITOR_KEY, SMOOTHING_KEY, LOUDNESS_TARGET_KEY, "aux_monitor_device", "pfl_cue_device", "pfl_dim_db",
  "audio_output_device", "jukebox_channel_on", CART_ON_KEY, ...Object.values(FADER_TOP_KEYS), ...Object.values(DUCK_KEYS)]);
/** null/undefined = unknown key (a write by uuid): treat as a board key. */
function isBoardKey(key) { return key == null || BOARD_KV_KEYS.has(String(key)); }

/**
 * Write the STARTING ducker values into a station's Preferences — only the keys it does not have yet (one-time per
 * station; a value the operator set is never touched). `upsert(sid, key, value)` is main's Preferences writer (the same
 * path the Ducker panel saves through). Returns the keys written.
 */
function seedDuckPreferences(db, sid, upsert) {
  const have = new Set();
  try { for (const r of db.prepare("SELECT key FROM station_config_kv WHERE station_id = ? AND deleted_at IS NULL").all(sid)) have.add(r.key); } catch { return []; }
  const wrote = [];
  for (const [k, key] of Object.entries(DUCK_KEYS)) if (!have.has(key)) { upsert(sid, key, String(DUCK_START[k])); wrote.push(key); }
  return wrote;
}

module.exports = { DUCK_START, seedDuckPreferences, isBoardKey, BOARD_KV_KEYS, CART_ON_KEY, FADER_TOP_KEYS, FADER_TOP_DEFAULTS, groupTopGain, routingMigration, FADER_LOCAL_KEY, FADER_ROUTING_FLAG, SMOOTHING_KEY, LOUDNESS_TARGET_KEY, MAX_GAIN, boardNames, labelOf, SLOTS, SOURCE_SLOTS, MASTER_MONITOR_KEY, DUCK_KEYS, readSavedBoard, applyBoard, compareBoard, listStations, addonSink, applySavedBoardState, parseRoomLevels };
