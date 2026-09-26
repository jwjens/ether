// mic-input.js — THE MIC AS AN ENGINE INPUT: the stored patch, one implementation (docs/dsp-mic-in-engine.md §4).
//
// Used by the daemon (audiod/engine.js — what it hands the engine) and by main (electron/main.js — what the
// Preferences picker reads and writes). Pure: no DB, no native, no Electron.
//
// station_config_kv `mic_input_<slot>` = {"device": "<input device name>", "channel": <1-based>, "gainDb": <−10…+40>}
// MACHINE-LOCAL (LOCAL_ONLY prefix `mic_input_`): a device name belongs to one machine, and another install
// has no "Focusrite USB (2- 2i2)". Written only through set-local.
"use strict";

/** The source channels a mic can be patched onto (never A/B/C — automation's decks — or CART). */
const MIC_SLOTS = ["D", "E", "F", "S1", "S2", "S3", "S4", "S5"];
const MIC_PREFIX = "mic_input_";
const micKey = (slot) => `${MIC_PREFIX}${slot}`;
const MIC_KEYS = MIC_SLOTS.map(micKey);
const GAIN_DB = [-10, 40];

/** The stored patch for a slot, normalised; null = nothing patched (or an unreadable value). */
function parseMicInput(value) {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    if (!v || typeof v.device !== "string" || !v.device) return null;
    const channel = Number.isInteger(v.channel) && v.channel >= 1 ? v.channel : 1;
    const g = Number(v.gainDb);
    const gainDb = Number.isFinite(g) ? Math.max(GAIN_DB[0], Math.min(GAIN_DB[1], g)) : 0;
    return { device: v.device, channel, gainDb };
  } catch { return null; }
}
function serializeMicInput(p) {
  return JSON.stringify({ device: String(p.device || ""), channel: p.channel || 1, gainDb: Number(p.gainDb) || 0 });
}

module.exports = { MIC_SLOTS, MIC_PREFIX, MIC_KEYS, GAIN_DB, micKey, parseMicInput, serializeMicInput };
