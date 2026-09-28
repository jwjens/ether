// link.js — THE REMOTE LINK: the stored settings, one implementation (docs/remote-link-design-2026-09-28.md).
//
// Used by the daemon (audiod/ether-audiod.js — what it hands the engine) and by main (electron/main.js — what
// Preferences and the strip read and write). Pure: no DB, no native, no Electron.
//
// Every key is MACHINE-LOCAL (LOCAL_ONLY prefix `link_`, electron/sync/handlers/station_config_kv.js): which slot
// takes the Link, where this machine sends, and the port it listens on belong to one machine.
//
//   link_input    (the RECEIVING station) {"slot":"S2","jitterMs":120,"port":9760,"autoCut":false,"autoCutSec":5}
//   link_send     (the SENDING station)   {"target":"<station uuid>","host":"…","port":9760,"bitrate":128000,
//                                          "fec":true,"srtFallbackSec":null}
//   link_key      (the RECEIVING station) {"key":"<64 hex>","id":1,"mintedAt":"<iso>"}
//
// THE KEY IS LOCAL IN THIS BUILD. A sender on ANOTHER machine needs the receiving station's key; delivering it
// through the account (the backend) is the next slice, with the relay, and it is required before the OV test.
// On one machine (the OVEVENTS-to-itself test) the sender reads the target's key from the same database.
"use strict";

/** The source channels the Link can be patched onto (never A/B/C — automation's decks — or CART). */
const LINK_SLOTS = ["D", "E", "F", "S1", "S2", "S3", "S4", "S5"];
const KEY_INPUT = "link_input";
const KEY_SEND = "link_send";
const KEY_KEY = "link_key";
const LINK_KEYS = [KEY_INPUT, KEY_SEND, KEY_KEY];

/** D5 — used only if the engine is too old to say (audio_link_defaults is the source). */
const FALLBACK_DEFAULTS = { bitrate: 128000, bitrateRange: [32000, 256000], jitterMs: 120, jitterRangeMs: [20, 1000],
                            port: 9760, frameMs: 20, rate: 48000, transport: "UDP" };
/** D4 — the auto-cut ships OFF; its delay is shown beside the switch. */
const AUTO_CUT_DEFAULT = { autoCut: false, autoCutSec: 5 };
/** The SRT → UDP fallback timeout, PROPOSED (Jeff sets it). SRT is not in this build: the field is shown, disabled. */
const SRT_FALLBACK_PROPOSED_SEC = 3;

const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isKeyHex = (s) => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s);

/** link_input → normalised, or null (nothing patched / unreadable). */
function parseInput(value, d = FALLBACK_DEFAULTS) {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    if (!v || !LINK_SLOTS.includes(v.slot)) return null;
    return {
      slot: v.slot,
      jitterMs: clampInt(v.jitterMs, d.jitterRangeMs[0], d.jitterRangeMs[1], d.jitterMs),
      port: clampInt(v.port, 1, 65535, d.port),
      autoCut: v.autoCut === true,
      autoCutSec: clampInt(v.autoCutSec, 1, 600, AUTO_CUT_DEFAULT.autoCutSec),
    };
  } catch { return null; }
}
function serializeInput(p) {
  return JSON.stringify({ slot: p.slot, jitterMs: p.jitterMs, port: p.port, autoCut: !!p.autoCut, autoCutSec: p.autoCutSec });
}

/** link_send → normalised, or null (not sending / unreadable). */
function parseSend(value, d = FALLBACK_DEFAULTS) {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    if (!v || !isUuid(v.target) || typeof v.host !== "string" || !v.host.trim()) return null;
    return {
      target: v.target.toLowerCase(),
      host: v.host.trim(),
      port: clampInt(v.port, 1, 65535, d.port),
      bitrate: clampInt(v.bitrate, d.bitrateRange[0], d.bitrateRange[1], d.bitrate),
      fec: v.fec !== false,
      srtFallbackSec: v.srtFallbackSec == null ? null : clampInt(v.srtFallbackSec, 1, 60, SRT_FALLBACK_PROPOSED_SEC),
    };
  } catch { return null; }
}
function serializeSend(p) {
  return JSON.stringify({ target: p.target, host: p.host, port: p.port, bitrate: p.bitrate, fec: !!p.fec, srtFallbackSec: p.srtFallbackSec ?? null });
}

/** link_key → {key, id, mintedAt} or null. */
function parseKey(value) {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    if (!v || !isKeyHex(v.key)) return null;
    return { key: v.key.toLowerCase(), id: clampInt(v.id, 1, 0x7fffffff, 1), mintedAt: typeof v.mintedAt === "string" ? v.mintedAt : null };
  } catch { return null; }
}
function serializeKey(k) { return JSON.stringify({ key: k.key, id: k.id, mintedAt: k.mintedAt || new Date().toISOString() }); }

/** A short, non-secret fingerprint of a key, so two screens can be compared without showing the key. */
function keyFingerprint(k) {
  if (!k || !k.key) return "";
  return require("crypto").createHash("sha256").update(k.key).digest("hex").slice(0, 8).toUpperCase().replace(/(.{4})/, "$1-");
}

/**
 * Should SEND TO `target` be refused? Returns a sentence, or null.
 *   · to this same station — its programme would feed back into itself;
 *   · to a station THIS MACHINE airs (designated here) — patch the mics here instead (design doc §4);
 *   · to a station that is sending to this one from this machine — a loop.
 */
function sendRefusal({ ownUuid, target, targetName, designatedHere, targetSendsToOwn }) {
  if (!isUuid(target)) return "pick a station to send to";
  if (ownUuid && target.toLowerCase() === String(ownUuid).toLowerCase()) return "a station cannot send to itself — its programme would feed back into itself";
  if (designatedHere) return `this machine airs ${targetName || "that station"} — patch the mics on its own board instead of sending to it`;
  if (targetSendsToOwn) return `${targetName || "that station"} is sending to this station — sending back would make a loop`;
  return null;
}

module.exports = {
  LINK_SLOTS, KEY_INPUT, KEY_SEND, KEY_KEY, LINK_KEYS, FALLBACK_DEFAULTS, AUTO_CUT_DEFAULT, SRT_FALLBACK_PROPOSED_SEC,
  isUuid, isKeyHex, parseInput, serializeInput, parseSend, serializeSend, parseKey, serializeKey, keyFingerprint, sendRefusal,
};
