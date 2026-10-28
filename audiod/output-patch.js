"use strict";
// audiod/output-patch.js — THE PATCH BAY, OUTPUTS: what is saved, and how it reaches the engine (step 1 of
// docs/ether-audio-patch-bay-plan.md; Jeff's Outputs answers in docs/outputs-section-plan-2026-10-27.md).
//
// Saved per computer, per station, in station_config_kv `patch_outputs` (machine-local: the `patch_` prefix is in
// LOCAL_ONLY_PREFIXES, so it never syncs — a device name belongs to one machine):
//   { "master": [{ "device": "Speakers (Realtek)", "pair": 0 }, …],   // up to 4 each; pair 0 = ch 1-2, 2 = 3-4 …
//     "aux":    [ … ],
//     "cue":    [ … ],                                                 // [] = PFL over Master, as before
//     "stall_switch": null | true | false }                            // answer 2; null = not set by the user yet
//
// A station that never opened the Patch Bay has no `patch_outputs`: the patch is READ from the three keys the old pickers
// wrote (audio_output_device, aux_monitor_device, pfl_cue_device), so nothing anyone set up changes on update. Saving
// from the Patch Bay writes `patch_outputs` and mirrors each row's FIRST device back into those three keys, so every
// other reader of them (the board watch, health, show presets' exclusions) stays truthful.

const KEY = "patch_outputs";
const LEGACY = { master: "audio_output_device", aux: "aux_monitor_device", cue: "pfl_cue_device" };
const ROWS = ["master", "aux", "cue"];
const MAX_DESTS = 4;   // native/src/patch.rs MAX_DESTS

function cleanRow(list) {
  const out = [];
  for (const d of Array.isArray(list) ? list : []) {
    const device = String((d && d.device) || "").trim();
    if (!device) continue;
    let pair = Math.floor(Number(d && d.pair) || 0);
    if (!(pair >= 0)) pair = 0;
    pair = Math.min(62, pair - (pair % 2));
    if (out.some(x => x.device === device && x.pair === pair)) continue;
    if (out.length === MAX_DESTS) break;
    out.push({ device, pair });
  }
  return out;
}

/** Validate and normalise a patch from the UI. → { ok, patch } | { ok:false, reason } */
function normalise(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, reason: "the patch must be an object" };
  const patch = {};
  for (const r of ROWS) patch[r] = cleanRow(p[r]);
  const s = p.stall_switch;
  patch.stall_switch = s === true ? true : s === false ? false : null;
  return { ok: true, patch };
}

/** The station's patch from its saved keys. `kv(key)` → the stored string, or undefined. */
function readPatch(kv) {
  const raw = kv(KEY);
  if (raw !== undefined && raw !== null && raw !== "") {
    try { const n = normalise(JSON.parse(raw)); if (n.ok) return { ...n.patch, source: "patch" }; } catch { /* fall through */ }
  }
  const patch = { stall_switch: null, source: "legacy" };
  for (const r of ROWS) {
    const v = kv(LEGACY[r]);
    patch[r] = v ? [{ device: String(v), pair: 0 }] : [];
  }
  return patch;
}

/** The writes a save makes: the patch itself, and each row's first device into the old key ("" when the row is empty). */
function writesFor(patch) {
  const w = [{ key: KEY, value: JSON.stringify({ master: patch.master, aux: patch.aux, cue: patch.cue, stall_switch: patch.stall_switch }) }];
  for (const r of ROWS) w.push({ key: LEGACY[r], value: patch[r].length ? patch[r][0].device : "" });
  return w;
}

/** The JSON the engine takes (native/src/patch.rs parse_patch). */
function engineJson(patch) {
  return JSON.stringify({ master: patch.master, aux: patch.aux, cue: patch.cue, stall_switch: patch.stall_switch });
}

module.exports = { KEY, LEGACY, ROWS, MAX_DESTS, normalise, readPatch, writesFor, engineJson };
