// show-presets.js — SLICE 7: show presets, and the BLADE that applies them (docs/dsp-show-presets.md).
//
// A show preset is the whole board: every fader's patch-by-kind, level, duck and duckable, room level and channel
// rack, plus the master rack, master fader, ducker and monitor level. The BLADE is the daemon: it owns the engine,
// so it is the one place that knows which channels are live, holds what is waiting for them, and applies it the
// moment each one goes OFF. The UI reads that state back from here; it never holds it.
//
// Jeff's rulings (2026-09-26):
//   1 · LIVE = ON. Full stop. For A/B/C (rotation decks — their ON button is the start control, and they are never
//       cut on this board) ON means PLAYING. For every other channel it is the channel switch.
//   2 · A Take moves non-live faders; a restart restores the faders (board_levels).
//   3 · A Take NEVER turns a channel ON. (It may cut a non-live channel — but under ruling 1 a non-live channel is
//       already OFF, so there is nothing to cut: the blade never sends a cut at all.)
//   6 · show_current synced; the pending set is machine-local (show_pending, LOCAL_ONLY).
//   7 · one built-in, "Flat".
//   8 · the ducker and the monitor level are in the preset.
//
// NEVER A MACHINE-LOCAL VALUE. A preset is rebuilt field by field from a WHITELIST (sanitizePreset), so a device
// name, a mic patch, processing on/off or the PFL settings cannot ride a preset whatever the stored document says —
// and whatever was dropped is reported, never silently eaten. The engine refuses unknown fields as well
// (native/src/show.rs), so the rule holds at both ends.
"use strict";

const RackSeed = require("./rack-seed");

const SLOTS = RackSeed.CHANNEL_SLOTS;                 // engine slot order
const ROTATION = new Set(["A", "B", "C"]);
const SOURCE_SLOTS = ["D", "E", "F", "S1", "S2", "S3", "S4", "S5"];
/** The keys that belong to THIS machine (electron/sync/handlers/station_config_kv.js LOCAL_ONLY_*). */
const MACHINE_LOCAL_KEYS = ["audio_output_device", "aux_monitor_device", "pfl_cue_device"];
const MACHINE_LOCAL_PREFIXES = ["mic_input_"];
const isMachineLocalKey = (k) => MACHINE_LOCAL_KEYS.includes(k) || MACHINE_LOCAL_PREFIXES.some(p => String(k).startsWith(p));

/** The store keys a preset is read from and written to (all synced, station-scoped). */
const DUCK_KEYS = { depthDb: "duck_depth_db", thresholdDb: "duck_threshold_db", attackMs: "duck_attack_ms", holdMs: "duck_hold_ms", releaseMs: "duck_release_ms" };
/** main's own defaults for an absent key (electron/main.js armAllStationDuckers) — "the ducker at its defaults". */
const DUCK_DEFAULTS = { depthDb: -22, thresholdDb: -45, attackMs: 30, holdMs: 700, releaseMs: 500 };
const FLAT = "Flat";

const num = (v) => { const n = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isRackDoc = (d) => !!(d && d.v === 1 && d.sections && Array.isArray(d.sections.ch));
const isMasterDoc = (d) => !!(d && d.v === 1 && d.sections && Array.isArray(d.sections.pgm) && Array.isArray(d.sections.local));

// ── The document ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild a preset from the whitelist. Returns { preset, stripped } — `stripped` lists every path that was dropped
 * (a machine-local key, an unknown field, a malformed value), so a caller can log it.
 */
function sanitizePreset(p) {
  const stripped = [];
  const note = (path, why) => stripped.push(why ? `${path} (${why})` : path);
  if (!p || typeof p !== "object") return { preset: null, stripped: ["(not a document)"] };
  for (const k of Object.keys(p)) if (!["v", "name", "stationUuid", "savedAt", "board", "builtIn"].includes(k)) note(k, isMachineLocalKey(k) ? "machine-local" : "unknown");
  const board = p.board && typeof p.board === "object" ? p.board : {};
  for (const k of Object.keys(board)) if (!["channels", "master"].includes(k)) note(`board.${k}`, isMachineLocalKey(k) ? "machine-local" : "unknown");
  const channels = {};
  const inCh = board.channels && typeof board.channels === "object" ? board.channels : {};
  for (const slot of Object.keys(inCh)) {
    if (!SLOTS.includes(slot)) { note(`board.channels.${slot}`, "not a fader"); continue; }
    const c = inCh[slot] || {};
    const out = {};
    for (const k of Object.keys(c)) {
      const path = `board.channels.${slot}.${k}`;
      switch (k) {
        case "enabled": case "on": case "duck": case "duckable": out[k] = !!c[k]; break;
        case "type": case "kind": if (typeof c[k] === "string") out[k] = c[k]; else note(path, "not text"); break;
        case "fader": { const v = num(c[k]); if (v != null && v >= 0 && v <= 4) out.fader = v; else note(path, "not a level"); break; }
        case "roomLevel": { const v = num(c[k]); if (v != null && v >= 0 && v <= 4) out.roomLevel = v; else note(path, "not a level"); break; }
        case "rack": if (isRackDoc(c[k])) out.rack = c[k]; else note(path, "not a channel rack"); break;
        default: note(path, isMachineLocalKey(k) || /device|mic_?input|pfl|proc/i.test(k) ? "machine-local" : "unknown");
      }
    }
    channels[slot] = out;
  }
  const m = board.master && typeof board.master === "object" ? board.master : {};
  const master = {};
  for (const k of Object.keys(m)) {
    const path = `board.master.${k}`;
    switch (k) {
      case "rack": if (isMasterDoc(m[k])) master.rack = m[k]; else note(path, "not a master rack"); break;
      case "fader": { const v = num(m[k]); if (v != null && v >= 0 && v <= 1) master.fader = v; else note(path, "not a level"); break; }
      case "monitorLevel": { const v = num(m[k]); if (v != null && v >= 0 && v <= 4) master.monitorLevel = v; else note(path, "not a level"); break; }
      case "duck": {
        const d = m[k] || {};
        const ok = Object.keys(DUCK_KEYS).every(f => num(d[f]) != null);
        if (ok) master.duck = Object.fromEntries(Object.keys(DUCK_KEYS).map(f => [f, num(d[f])]));
        else note(path, "incomplete ducker");
        break;
      }
      default: note(path, isMachineLocalKey(k) || /device|mic_?input|pfl|proc|masterMonitor/i.test(k) ? "machine-local" : "unknown");
    }
  }
  return {
    preset: { v: 1, name: String(p.name || ""), stationUuid: String(p.stationUuid || ""), savedAt: p.savedAt || null,
              ...(p.builtIn ? { builtIn: true } : {}), board: { channels, master } },
    stripped,
  };
}

/**
 * The live board as a preset (Save / Save As). Every input is what the stores and the blade hold:
 *   deckConfigs — the station's deck_configs rows ({slot,type,kind,enabled,channel_on,duck,duckable})
 *   get(key)    — the station's station_config_kv value
 *   levels      — the blade's fader levels { A: 0.8, …, master: 1 }
 */
function snapshotBoard({ name, stationUuid, deckConfigs, get, levels }) {
  const channels = {};
  const room = parseRoomLevels(get("aux_monitor_levels"));
  for (const r of deckConfigs || []) {
    const slot = String(r.slot);
    if (!SLOTS.includes(slot)) continue;
    const enabled = r.enabled === 1 || r.enabled === true;
    if (!enabled && !ROTATION.has(slot)) { channels[slot] = { enabled: false }; continue; }
    const c = {
      enabled, type: String(r.type || ""), kind: String(r.kind || ""),
      fader: num(levels && levels[slot]) ?? 1,
      on: ROTATION.has(slot) ? true : !(r.channel_on === 0 || r.channel_on === false),
      duck: r.duck === 1 || r.duck === true,
      duckable: !(r.duckable === 0 || r.duckable === false),
      rack: RackSeed.channelRack(get, slot).doc,
    };
    if (room[slot] != null) c.roomLevel = room[slot];
    channels[slot] = c;
  }
  const duck = {};
  for (const [f, key] of Object.entries(DUCK_KEYS)) duck[f] = num(get(key)) ?? DUCK_DEFAULTS[f];
  const mon = num(get("monitor_volume"));
  const master = {
    rack: RackSeed.seedMasterRack(get).doc,
    fader: num(levels && levels.master) ?? 1,
    duck,
    ...(mon != null ? { monitorLevel: clamp(mon, 0, 4) } : {}),
  };
  return sanitizePreset({ v: 1, name, stationUuid, savedAt: new Date().toISOString(), board: { channels, master } }).preset;
}

/** aux_monitor_levels is a map { slot: level } (AuxMonitorSlots.tsx). Anything else reads as none. */
function parseRoomLevels(s) {
  try { const m = JSON.parse(s || "{}"); if (m && typeof m === "object" && !Array.isArray(m)) return Object.fromEntries(Object.entries(m).filter(([, v]) => num(v) != null).map(([k, v]) => [k, num(v)])); }
  catch { /* fall through */ }
  return {};
}

/**
 * "Flat" (ruling 7): every channel rack empty, every fader at unity, the ducker at its defaults, and the master at
 * the shipped chain (flat GEQ, the shipped ride and limiter — NOT an empty master, which would drop the limiter
 * whenever processing is on). It names no channel layout, no duck toggles and no levels it cannot know.
 */
function flatPreset(stationUuid) {
  const channels = {};
  for (const s of SLOTS) channels[s] = { fader: 1, rack: RackSeed.emptyChannelRack() };
  const shipped = RackSeed.seedMasterRack(() => undefined).doc;
  return { v: 1, name: FLAT, stationUuid, savedAt: null, builtIn: true,
           board: { channels, master: { rack: shipped, fader: 1, duck: { ...DUCK_DEFAULTS } } } };
}

// ── The live rule and what goes to the engine ────────────────────────────────────────────────────────────

/**
 * RULING 1. `obs` = what the engine says about the slot: { status } for A/B/C (from audio_get_state), { cut } for the
 * others (the engine's cut; undefined = never cut since the engine started — it starts OPEN, so that is ON).
 */
function isLive(slot, obs) {
  if (ROTATION.has(slot)) return !!(obs && obs.status === "playing");
  return !(obs && obs.cut === true);
}

/** The engine document (audio_apply_show) for these slots (+ the master when `withMaster`). Never a cut. */
function engineDoc(preset, slots, withMaster) {
  const out = { slots: {} };
  const chans = (preset.board && preset.board.channels) || {};
  for (const s of slots) {
    const c = chans[s];
    if (!c || c.enabled === false) continue;
    const e = {};
    if (c.fader != null) e.fader = c.fader;
    if (c.duck != null && !ROTATION.has(s)) e.duck = c.duck;
    if (c.duckable != null) e.duckable = c.duckable;
    if (c.roomLevel != null && ["D", "E", "F"].includes(s)) e.room = c.roomLevel;
    if (c.rack) e.rack = c.rack;
    if (Object.keys(e).length) out.slots[s] = e;
  }
  if (withMaster) {
    const m = (preset.board && preset.board.master) || {};
    const em = {};
    if (m.fader != null) em.fader = m.fader;
    if (m.rack) em.rack = m.rack;
    if (m.duck) em.duck = m.duck;
    if (m.monitorLevel != null) em.monitor = m.monitorLevel;
    if (Object.keys(em).length) out.master = em;
  }
  return out;
}

/** What main writes for the applied part (the stores). Same whitelist; never ON (ruling 3). */
function storeWrites(preset, slots, withMaster) {
  const chans = (preset.board && preset.board.channels) || {};
  const channels = {};
  for (const s of slots) {
    const c = chans[s];
    if (!c) continue;
    const w = {};
    for (const k of ["enabled", "type", "kind", "fader", "duck", "duckable", "roomLevel", "rack"]) if (c[k] !== undefined) w[k] = c[k];
    if (ROTATION.has(s)) { delete w.enabled; delete w.type; delete w.kind; }   // A/B/C are never re-patched
    channels[s] = w;
  }
  const out = { channels };
  if (withMaster) out.master = { ...((preset.board && preset.board.master) || {}) };
  return out;
}

/**
 * The exact writes main makes for an applied part (`storeWrites` output) — ONE planner, executed by main and asserted
 * by the smoke, so "a preset never touches a machine-local key" is checked over the real list, not a copy.
 *   get(key) — the station's current kv (for the aux_monitor_levels merge)
 * Returns { kv: [[key, value]], deck: [[slot, patch]] }. deck patches carry only enabled/type/kind/duck/duckable —
 * never channel_on (ruling 3).
 */
function planStoreWrites(stores, get) {
  const kv = [], deck = [];
  const room = parseRoomLevels(get("aux_monitor_levels"));
  let roomChanged = false;
  for (const [slot, w] of Object.entries((stores && stores.channels) || {})) {
    if (!SLOTS.includes(slot)) continue;
    const patch = {};
    if (w.enabled !== undefined) patch.enabled = w.enabled ? 1 : 0;
    if (typeof w.type === "string" && w.type) patch.type = w.type;
    if (typeof w.kind === "string") patch.kind = w.kind;
    if (w.duck !== undefined) patch.duck = w.duck ? 1 : 0;
    if (w.duckable !== undefined) patch.duckable = w.duckable ? 1 : 0;
    if (Object.keys(patch).length) deck.push([slot, patch]);
    if (w.rack) kv.push([RackSeed.channelKey(slot), JSON.stringify(w.rack)]);
    if (w.roomLevel != null) { room[slot] = w.roomLevel; roomChanged = true; }
  }
  if (roomChanged) kv.push(["aux_monitor_levels", JSON.stringify(room)]);
  const m = stores && stores.master;
  if (m) {
    if (m.rack) { kv.push(["rack_master", JSON.stringify(m.rack)]); for (const [k, v] of RackSeed.legacyWrites(m.rack)) kv.push([k, v]); }
    if (m.duck) for (const [f, key] of Object.entries(DUCK_KEYS)) if (m.duck[f] != null) kv.push([key, String(m.duck[f])]);
    if (m.monitorLevel != null) kv.push(["monitor_volume", String(m.monitorLevel)]);
  }
  return { kv: kv.filter(([k]) => !isMachineLocalKey(k)), deck };
}

// ── THE BLADE ────────────────────────────────────────────────────────────────────────────────────────────────

class ShowBlade {
  /**
   * @param {object} o
   * @param {number} o.stationId
   * @param {object} o.addon        the native addon (audioApplyShow, audioGetState)
   * @param {(key: string) => string|undefined} [o.readKv]  this station's station_config_kv (read-only)
   * @param {(event: string, payload: object) => void} o.emit
   * @param {(...a: any[]) => void} [o.log]
   */
  constructor({ stationId, addon, readKv, emit, log }) {
    this.stationId = stationId;
    this.A = addon;
    this.readKv = readKv || (() => undefined);
    this.emit = emit || (() => {});
    this.log = log || (() => {});
    this.cut = {};          // slot → the engine's cut, as passed through setMuted (S1–S5 are not in audio_get_state)
    this.levels = {};       // slot → fader, master → master fader: what the engine was last told
    this.pending = {};      // slot → { show, values: channel doc } — waiting for the slot to go OFF
    this.armed = null;      // the preset armed (name), or null
    this.current = null;    // the show last Taken
    this.booted = false;
  }

  /** At engine start: the saved faders (ruling 2) and the saved pending set (ruling 6). Once per engine. */
  boot() {
    if (this.booted) return;
    this.booted = true;
    let lv = null;
    try { lv = JSON.parse(this.readKv("board_levels") || "null"); } catch { lv = null; }
    if (lv && typeof lv === "object") {
      const slots = {};
      for (const s of SLOTS) { const v = num(lv[s]); if (v != null && v >= 0 && v <= 4) slots[s] = { fader: v }; }
      const mv = num(lv.master);
      const doc = { slots, ...(mv != null && mv >= 0 && mv <= 1 ? { master: { fader: mv } } : {}) };
      if (Object.keys(slots).length || doc.master) {
        const r = this._apply(doc);
        if (r.ok) {
          for (const s of Object.keys(slots)) this.levels[s] = slots[s].fader;
          if (doc.master) this.levels.master = doc.master.fader;
          this.log(`[show s${this.stationId}] faders restored (${Object.keys(slots).length} + ${doc.master ? "master" : "no master"})`);
        } else this.log(`[show s${this.stationId}] faders NOT restored ✗ ${r.reason}`);
      }
    }
    try { this.current = this.readKv("show_current") || null; } catch { this.current = null; }
    let pend = null;
    try { pend = JSON.parse(this.readKv("show_pending") || "null"); } catch { pend = null; }
    if (pend && typeof pend === "object" && pend.slots && typeof pend.slots === "object") {
      for (const [s, p] of Object.entries(pend.slots)) {
        if (!SLOTS.includes(s) || !p || typeof p !== "object") continue;
        const { preset } = sanitizePreset({ v: 1, board: { channels: { [s]: p.values || {} } } });
        this.pending[s] = { show: String(p.show || ""), values: preset.board.channels[s] || {} };
      }
      if (Object.keys(this.pending).length) this.log(`[show s${this.stationId}] pending re-armed: ${Object.keys(this.pending).join(", ")}`);
    }
    this._settle("boot");
  }

  // ── what passes through the blade ──
  noteMuted(slot, muted) {
    if (!SLOTS.includes(slot)) return;
    this.cut[slot] = !!muted;
    if (muted) this._settle(`${slot} OFF`);
  }
  // A drag is not a show change: it goes out as `boardlevels` (main persists board_levels, debounced) and never
  // re-broadcasts the show state at drag rate.
  noteVolume(slot, v) { if (SLOTS.includes(slot) && num(v) != null) { this.levels[slot] = num(v); this._levelsChanged(); } }
  noteMaster(v) { if (num(v) != null) { this.levels.master = num(v); this._levelsChanged(); } }
  /** A deck stopped by command (the channel went OFF for a rotation deck; a source stopped). */
  noteStopped(slot) { if (SLOTS.includes(slot)) this._settle(`${slot} stopped`); }
  /** The station loop's beat: a deck that ended or stopped inside the engine goes OFF here. */
  tick() { if (Object.keys(this.pending).length) this._settle("tick"); }

  _observe() {
    let st = null;
    try { st = JSON.parse(this.A.audioGetState(this.stationId)); } catch { st = null; }
    const key = (s) => (s === "CART" ? "deckCart" : `deck${s}`);
    const obs = {};
    for (const s of SLOTS) {
      const d = st && st[key(s)];
      obs[s] = ROTATION.has(s) ? { status: d ? d.status : undefined }
                               : { cut: this.cut[s] !== undefined ? this.cut[s] : (d ? !!d.muted : undefined) };
    }
    return obs;
  }

  /** Apply every pending slot that is no longer live — ONE engine call for all of them. */
  _settle(why) {
    const waiting = Object.keys(this.pending);
    if (!waiting.length) return;
    const obs = this._observe();
    const now = waiting.filter(s => !isLive(s, obs[s]));
    if (!now.length) return;
    this._applyPending(now, why);
  }

  _applyPending(slots, why) {
    const channels = {};
    for (const s of slots) channels[s] = this.pending[s].values;
    const shows = Object.fromEntries(slots.map(s => [s, this.pending[s].show]));
    const preset = { board: { channels } };
    const r = this._apply(engineDoc(preset, slots, false));
    if (!r.ok) { this.log(`[show s${this.stationId}] pending for ${slots.join(",")} NOT applied ✗ ${r.reason}`); return false; }
    for (const s of slots) { if (channels[s].fader != null) this.levels[s] = channels[s].fader; delete this.pending[s]; }
    this.log(`[show s${this.stationId}] pending applied (${why}): ${slots.map(s => `${s} ← ${shows[s]}`).join(", ")}`);
    this.emit("showapplied", { stationId: this.stationId, reason: why, shows, stores: storeWrites(preset, slots, false) });
    this._changed();
    return true;
  }

  _apply(doc) {
    if (typeof this.A.audioApplyShow !== "function") return { ok: false, reason: "this engine has no show apply (an older build)" };
    try { const r = JSON.parse(this.A.audioApplyShow(this.stationId, JSON.stringify(doc))); return r && r.ok ? r : { ok: false, reason: (r && r.reason) || "no answer from the engine" }; }
    catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
  }

  // ── the operator's verbs ──
  arm(name) { this.armed = name ? String(name) : null; this._changed(); return this.state(); }
  disarm() { this.armed = null; this._changed(); return this.state(); }

  /**
   * TAKE. `stationUuid` is this station's (main's authoritative mapping). The preset is refused whole if it names
   * another station. Live channels keep what they have and wait; everything else lands in ONE engine block.
   * `onBoard` = the slots on the station's board right now (deck_configs enabled; A/B/C always): a slot that is not
   * on the board has no ON button, so it is never live. What the PRESET says about a slot never decides liveness —
   * a preset that removes a channel still waits for that channel to go OFF.
   */
  take(rawPreset, stationUuid, onBoard) {
    const { preset, stripped } = sanitizePreset(rawPreset);
    if (!preset) return { ok: false, reason: "not a show preset" };
    if (!stationUuid || preset.stationUuid !== stationUuid) {
      this.log(`[show s${this.stationId}] Take REFUSED ✗ "${preset.name}" is for station ${preset.stationUuid || "(none)"}, this is ${stationUuid}`);
      return { ok: false, reason: `"${preset.name}" belongs to another station — it was not taken` };
    }
    if (stripped.length) this.log(`[show s${this.stationId}] "${preset.name}": stripped ${stripped.join("; ")}`);
    const obs = this._observe();
    const named = Object.keys(preset.board.channels);
    const board = new Set([...(Array.isArray(onBoard) ? onBoard : SLOTS), ...ROTATION]);
    const live = named.filter(s => board.has(s) && isLive(s, obs[s]));
    const now = named.filter(s => !live.includes(s));
    const r = this._apply(engineDoc(preset, now, true));
    if (!r.ok) { this.log(`[show s${this.stationId}] Take "${preset.name}" ✗ ${r.reason}`); return { ok: false, reason: r.reason }; }
    for (const s of now) { delete this.pending[s]; const f = preset.board.channels[s].fader; if (f != null) this.levels[s] = f; }
    if (preset.board.master.fader != null) this.levels.master = preset.board.master.fader;
    for (const s of live) this.pending[s] = { show: preset.name, values: preset.board.channels[s] };
    this.current = preset.name;
    this.armed = null;
    this.log(`[show s${this.stationId}] TAKE "${preset.name}": applied ${now.join(",") || "(no channels)"} + master · waiting (live) ${live.join(",") || "none"}`);
    this.emit("showapplied", { stationId: this.stationId, reason: "take", show: preset.name, stores: storeWrites(preset, now, true) });
    this._changed();
    return { ok: true, show: preset.name, applied: now, pending: live, stripped };
  }

  /** TAKE NOW — the operator forces a waiting channel. Still never turns anything ON. */
  force(slot) {
    if (!this.pending[slot]) return { ok: false, reason: `${slot} has nothing waiting` };
    return this._applyPending([slot], `${slot} TAKE NOW`) ? { ok: true } : { ok: false, reason: "the engine refused it" };
  }

  state() {
    return {
      current: this.current, armed: this.armed,
      pending: Object.entries(this.pending).map(([slot, p]) => ({ slot, show: p.show })),
      levels: { ...this.levels },
    };
  }
  /** The persisted pending set (show_pending, machine-local) — values included, so a restart re-arms without the preset. */
  pendingDoc() { return { v: 1, slots: Object.fromEntries(Object.entries(this.pending).map(([s, p]) => [s, { show: p.show, values: p.values }])) }; }
  _changed() { this.emit("showstate", { stationId: this.stationId, ...this.state(), pendingDoc: this.pendingDoc() }); this._levelsChanged(); }
  _levelsChanged() { this.emit("boardlevels", { stationId: this.stationId, levels: { ...this.levels } }); }
}

module.exports = { SLOTS, SOURCE_SLOTS, ROTATION, MACHINE_LOCAL_KEYS, MACHINE_LOCAL_PREFIXES, isMachineLocalKey, DUCK_KEYS, DUCK_DEFAULTS, FLAT,
  sanitizePreset, snapshotBoard, parseRoomLevels, flatPreset, isLive, engineDoc, storeWrites, planStoreWrites, ShowBlade };
