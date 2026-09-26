// rack-seed.js — SLICE 4: the master rack document, seeded and written back (docs/dsp-rack-framework.md §1.2).
//
// ONE implementation, used by the daemon (audiod/engine.js — what it hands the engine) and by main
// (electron/main.js — what the rack UI reads and writes). Pure: no DB, no native, no Electron.
//
// SEED, NOT MIGRATION (Jeff's slice 4 ruling 1). When a station has no `rack_master` document, its rack is
// BUILT from the keys every earlier build wrote: proc_target_lufs / proc_ride_rate / proc_ride_clamp /
// proc_ceiling_dbtp / proc_release_ms, the proc_stream_* set, proc_split, and eq_master — with the shipped
// constants for anything unset. So a station that never opens the rack runs exactly what it ran before.
//
// WRITE-BACK (ruling 3). Every rack write ALSO writes those legacy keys, because a running daemon does not
// reload on auto-update and older installs on the same account still read them. Keep writing them until the
// release after this one is on both machines with restarted daemons; their removal is its own later slice.
"use strict";

const SHIPPED = { target: -14, rate: 1.5, clamp: 12, ceiling: -1.0, release: 120 };

/** Every key the rack reads (the document, and the legacy keys it is seeded from). */
const RACK_KEYS = [
  "rack_master", "eq_master", "proc_split",
  "proc_target_lufs", "proc_ceiling_dbtp", "proc_release_ms", "proc_ride_rate", "proc_ride_clamp",
  "proc_stream_target_lufs", "proc_stream_ceiling_dbtp", "proc_stream_release_ms", "proc_stream_ride_rate", "proc_stream_ride_clamp",
];

// The same edge clamps the engine applies (native/src/rack.rs clamp_ride / clamp_limiter).
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : null; };

function branchSlots(p) {
  return [
    { id: "s-ride", module: { type: "ride", target: p.target, rate: p.rate, clamp: p.clamp }, in: true },
    { id: "s-lim", module: { type: "limiter", ceiling: p.ceiling, release: p.release }, in: true },
  ];
}

function parseBands(s) {
  try {
    const b = JSON.parse(s);
    if (Array.isArray(b) && b.length === 10 && b.every(x => typeof x === "number" && Number.isFinite(x))) return b;
  } catch { /* fall through to flat */ }
  return null;
}

/**
 * The station's master rack document.
 * @param {(key: string) => string | undefined} get  the station's station_config_kv value for a key
 * @returns {{ doc: object, source: "rack_master" | "seed" }}
 */
function seedMasterRack(get) {
  const stored = get("rack_master");
  if (stored) {
    try {
      const d = JSON.parse(stored);
      if (d && d.v === 1 && d.sections && Array.isArray(d.sections.pgm) && Array.isArray(d.sections.local)) {
        return { doc: d, source: "rack_master" };
      }
    } catch { /* a malformed document must not cost the station its chain — fall back to the seed */ }
  }
  const local = {
    target:  clamp(num(get("proc_target_lufs"))  ?? SHIPPED.target, -30, -6),
    rate:    clamp(num(get("proc_ride_rate"))    ?? SHIPPED.rate, 0.1, 12),
    clamp:   clamp(num(get("proc_ride_clamp"))   ?? SHIPPED.clamp, 0, 24),
    ceiling: clamp(num(get("proc_ceiling_dbtp")) ?? SHIPPED.ceiling, -12, -0.1),
    release: clamp(num(get("proc_release_ms"))   ?? SHIPPED.release, 5, 2000),
  };
  const split = get("proc_split") === "1" || get("proc_split") === "true";
  // Split: each stream key falls back to the local value when unset — exactly the daemon's rule before the rack.
  const stream = split ? {
    target:  clamp(num(get("proc_stream_target_lufs"))  ?? local.target, -30, -6),
    rate:    clamp(num(get("proc_stream_ride_rate"))    ?? local.rate, 0.1, 12),
    clamp:   clamp(num(get("proc_stream_ride_clamp"))   ?? local.clamp, 0, 24),
    ceiling: clamp(num(get("proc_stream_ceiling_dbtp")) ?? local.ceiling, -12, -0.1),
    release: clamp(num(get("proc_stream_release_ms"))   ?? local.release, 5, 2000),
  } : local;
  const bands = parseBands(get("eq_master")) || new Array(10).fill(0);
  return {
    doc: {
      v: 1, link: !split,
      sections: {
        pgm: [{ id: "s-geq", module: { type: "geq", bands }, in: true }],
        local: branchSlots(local),
        stream: branchSlots(stream),
      },
    },
    source: "seed",
  };
}

const findModule = (slots, type) => (slots || []).find(s => s && s.module && s.module.type === type) || null;

/** The ride/limiter numbers of a branch section (the shipped values where a module is somehow absent). */
function branchParams(doc, name) {
  const secs = doc.sections || {};
  const slots = name === "stream" && doc.link ? secs.local : secs[name];
  const r = findModule(slots, "ride"), l = findModule(slots, "limiter");
  return {
    target: r ? r.module.target : SHIPPED.target, rate: r ? r.module.rate : SHIPPED.rate, clamp: r ? r.module.clamp : SHIPPED.clamp,
    ceiling: l ? l.module.ceiling : SHIPPED.ceiling, release: l ? l.module.release : SHIPPED.release,
  };
}

/** The GEQ's bands and whether it runs (present AND in). */
function geqOf(doc) {
  const g = findModule((doc.sections || {}).pgm, "geq");
  return g ? { bands: g.module.bands, on: g.in !== false } : { bands: null, on: false };
}

/**
 * The legacy keys a rack write also writes (ruling 3), as [key, value] pairs. The GEQ's bands are written
 * as stored even when its slot is OUT — the legacy key cannot express IN, and discarding the operator's EQ
 * for an older build would lose it; the rack's IN lives in `rack_master`.
 */
function legacyWrites(doc) {
  const L = branchParams(doc, "local"), S = branchParams(doc, "stream");
  const out = [
    ["proc_target_lufs", L.target], ["proc_ride_rate", L.rate], ["proc_ride_clamp", L.clamp],
    ["proc_ceiling_dbtp", L.ceiling], ["proc_release_ms", L.release],
    ["proc_split", doc.link ? "0" : "1"],
    ["proc_stream_target_lufs", S.target], ["proc_stream_ride_rate", S.rate], ["proc_stream_ride_clamp", S.clamp],
    ["proc_stream_ceiling_dbtp", S.ceiling], ["proc_stream_release_ms", S.release],
  ];
  const g = geqOf(doc);
  if (g.bands) out.push(["eq_master", JSON.stringify(g.bands)]);
  return out.map(([k, v]) => [k, String(v)]);
}

// ── SLICE 5 — the channel racks (docs/dsp-channel-rack-eq.md §3) ─────────────────────────────────────────
// One per fader: station_config_kv `rack_ch_<slot>`. NO seed and NO write-back — no earlier build stored a
// channel EQ that anything reads (the deck EQ drawer's `eq_deck_*` keys never reached audio and are discarded,
// Jeff's ruling 4). A fader with no document has an EMPTY rack: nothing runs, today's exact arithmetic.

/** The engine's faders, in engine slot order (native/src/audio.rs deck_index). */
const CHANNEL_SLOTS = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];
const channelKey = (slot) => `rack_ch_${slot}`;
const CHANNEL_KEYS = CHANNEL_SLOTS.map(channelKey);
const emptyChannelRack = () => ({ v: 1, sections: { ch: [] } });

/**
 * A fader's channel rack document.
 * @param {(key: string) => string | undefined} get
 * @returns {{ doc: object, source: "stored" | "empty" }}
 */
function channelRack(get, slot) {
  const stored = get(channelKey(slot));
  if (stored) {
    try {
      const d = JSON.parse(stored);
      if (d && d.v === 1 && d.sections && Array.isArray(d.sections.ch)) return { doc: d, source: "stored" };
    } catch { /* malformed → empty: a bad document must never put processing on a fader */ }
  }
  return { doc: emptyChannelRack(), source: "empty" };
}

/** Does anything in this channel rack run? (a module present AND in) */
function channelRackActive(doc) {
  return !!(doc && doc.sections && Array.isArray(doc.sections.ch) && doc.sections.ch.some(s => s && s.module && s.in !== false));
}

module.exports = { SHIPPED, RACK_KEYS, seedMasterRack, branchParams, geqOf, legacyWrites,
  CHANNEL_SLOTS, CHANNEL_KEYS, channelKey, channelRack, channelRackActive, emptyChannelRack };
