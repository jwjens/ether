// link.js — THE REMOTE LINK: the stored settings, one implementation (docs/remote-link-design-2026-09-28.md).
//
// Used by the daemon (audiod/ether-audiod.js — what it hands the engine) and by main (electron/main.js — what
// Preferences and the strip read and write). Pure: no DB, no native, no Electron.
//
// A Link is a FEED over the network into a FADER — the input selector on the channel set to "Link" — not a
// station talking to a station. With sync, the same station (halloVeen) runs on the remote box and on OV; the
// remote box sends its halloVeen programme to OV's halloVeen board, into the fader set to Link.
//
// THE KEY IS MADE BY THE SENDING MACHINE (Jeff's ruling, 2026-09-29 — "B", like telling a codec which caller to
// accept). It is shown in Preferences → Broadcast → Remote Link as ONE copyable line that names the sending
// machine; on the receiving side it is pasted into the fader's Link input. Each fader holds its own copy, so each
// can be cut off on its own. Packets are paired "<receiving machine id>|<sending machine id>" (native link.rs).
//
//   <EtherMachine>/link-key   (the SENDING MACHINE's key, beside machine-id)  {"key":"<64 hex>","id":1,"mintedAt":"<iso>"}
//   link_input  (per RECEIVING station, machine-local) {"slot":"D","jitterMs":120,"port":9760,"autoCut":false,"autoCutSec":5,
//                                                        "from":{"machine":"<id>","name":"OVEVENTS","keyId":1,"key":"<64 hex>"}|null}
//   link_send   (per SENDING station, machine-local)   {"target":"<station uuid>","targetMachine":"<id>","targetMachineName":"…",
//                                                        "host":"…","port":9760,"bitrate":128000,"fec":true,"srtFallbackSec":null}
//
// The one refusal: a feed to THIS SAME machine (a real loop). ETHER_LINK_SELF_TEST=1 lifts it for the one-box test
// (design §7 step 2), and even then a station never feeds its own board.
"use strict";
const path = require("path");

/** The source channels the Link can be patched onto (never A/B/C — automation's decks — or CART). */
const LINK_SLOTS = ["D", "E", "F", "S1", "S2", "S3", "S4", "S5"];
const KEY_INPUT = "link_input";
const KEY_SEND = "link_send";
const LINK_KEYS = [KEY_INPUT, KEY_SEND];
/** The sending machine's key file, in the machine-identity folder (beside machine-id; survives every wipe). */
const MACHINE_KEY_FILE = "link-key";
/** The copyable line: ether-link:1:<machine id>:<key id>:<64 hex>:<machine name, URI-encoded>. */
const TOKEN_PREFIX = "ether-link:1:";
/** How a fader's key was paired (link_input.from.via). */
const PAIR_VIA = ["account", "code", "line"];

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
/** A machine id: what client_identity / machine-id hold (a UUID in practice). No ':' or '|' — they delimit. */
const isMachineId = (s) => typeof s === "string" && /^[0-9a-z][0-9a-z._-]{0,43}$/i.test(s.trim());
const lc = (s) => String(s || "").trim().toLowerCase();

/** The test-only override for the one-box self-test. Never set by the UI. */
const selfTestOn = (env = process.env) => env && env.ETHER_LINK_SELF_TEST === "1";

/** The machine-identity folder, resolved exactly as main's _machineIdDir: LocalAppData\EtherMachine on Windows,
 *  else beside the app's userData. The daemon passes the userData it derives from its log path. */
function machineDir({ platform = process.platform, localAppData = process.env.LOCALAPPDATA, userDataDir } = {}) {
  if (platform === "win32" && localAppData) return path.join(localAppData, "EtherMachine");
  return userDataDir ? path.join(path.dirname(userDataDir), "EtherMachine") : null;
}

/** The key, stored → {key, id, mintedAt} or null. */
function parseKey(value) {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    if (!v || !isKeyHex(v.key)) return null;
    return { key: v.key.toLowerCase(), id: clampInt(v.id, 1, 0x7fffffff, 1), mintedAt: typeof v.mintedAt === "string" ? v.mintedAt : null };
  } catch { return null; }
}
function serializeKey(k) { return JSON.stringify({ key: k.key, id: k.id, mintedAt: k.mintedAt || new Date().toISOString() }); }
function readMachineKey(dir, fs = require("fs")) {
  if (!dir) return null;
  try { return parseKey(fs.readFileSync(path.join(dir, MACHINE_KEY_FILE), "utf8")); } catch { return null; }
}
function writeMachineKey(dir, k, fs = require("fs")) {
  if (!dir) throw new Error("no machine folder to keep the key in");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MACHINE_KEY_FILE), serializeKey(k), "utf8");
}

/** A short, non-secret fingerprint of a key, so two screens can be compared. */
function keyFingerprint(k) {
  if (!k || !k.key) return "";
  return require("crypto").createHash("sha256").update(k.key).digest("hex").slice(0, 8).toUpperCase().replace(/(.{4})/, "$1-");
}

/** The one copyable line the sending machine shows. */
function makeToken({ machine, name, key }) {
  if (!isMachineId(machine) || !key || !isKeyHex(key.key)) return "";
  return `${TOKEN_PREFIX}${lc(machine)}:${key.id}:${key.key.toLowerCase()}:${encodeURIComponent(String(name || "").trim())}`;
}
/** The pasted line → {machine, name, keyId, key} or null. Whitespace and line breaks from a copy are ignored. */
function parseToken(text) {
  const t = String(text || "").replace(/\s+/g, "");
  if (!t.toLowerCase().startsWith(TOKEN_PREFIX)) return null;
  const [machine, id, key, ...rest] = t.slice(TOKEN_PREFIX.length).split(":");
  if (!isMachineId(machine) || !isKeyHex(key)) return null;
  const keyId = clampInt(id, 1, 0x7fffffff, NaN);
  if (!Number.isFinite(keyId)) return null;
  let name = "";
  try { name = decodeURIComponent(rest.join(":")); } catch { name = rest.join(":"); }
  return { machine: lc(machine), name: name || lc(machine).slice(0, 8), keyId, key: key.toLowerCase() };
}

/** "<receiving machine id>|<sending machine id>" — the engine's pairing; the same string on both ends. */
function pairing(receivingMachine, sendingMachine) { return `${lc(receivingMachine)}|${lc(sendingMachine)}`; }

/** link_input → normalised, or null (nothing patched / unreadable). `from` = the pasted key, or null (none yet). */
function parseInput(value, d = FALLBACK_DEFAULTS) {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    if (!v || !LINK_SLOTS.includes(v.slot)) return null;
    const f = v.from;
    const from = f && isMachineId(f.machine) && isKeyHex(f.key)
      ? { machine: lc(f.machine), name: String(f.name || "").trim() || lc(f.machine).slice(0, 8), keyId: clampInt(f.keyId, 1, 0x7fffffff, 1), key: f.key.toLowerCase(),
          // HOW it was paired (2026-10-04): account (re-fetched when the sender replaces its key) · code (a guest's
          // one-use code) · line (the advanced paste — and every key stored before pairing existed).
          via: PAIR_VIA.includes(f.via) ? f.via : "line" }
      : null;
    return {
      slot: v.slot,
      jitterMs: clampInt(v.jitterMs, d.jitterRangeMs[0], d.jitterRangeMs[1], d.jitterMs),
      port: clampInt(v.port, 1, 65535, d.port),
      autoCut: v.autoCut === true,
      autoCutSec: clampInt(v.autoCutSec, 1, 600, AUTO_CUT_DEFAULT.autoCutSec),
      from,
    };
  } catch { return null; }
}
function serializeInput(p) {
  return JSON.stringify({ slot: p.slot, jitterMs: p.jitterMs, port: p.port, autoCut: !!p.autoCut, autoCutSec: p.autoCutSec,
                          from: p.from ? { machine: p.from.machine, name: p.from.name, keyId: p.from.keyId, key: p.from.key,
                                           via: PAIR_VIA.includes(p.from.via) ? p.from.via : "line" } : null });
}

/** link_send → normalised, or null (not sending / unreadable). */
function parseSend(value, d = FALLBACK_DEFAULTS) {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    if (!v || !isUuid(v.target) || !isMachineId(v.targetMachine) || typeof v.host !== "string" || !v.host.trim()) return null;
    return {
      target: v.target.toLowerCase(),
      targetMachine: lc(v.targetMachine),
      targetMachineName: String(v.targetMachineName || "").trim(),
      host: v.host.trim(),
      port: clampInt(v.port, 1, 65535, d.port),
      bitrate: clampInt(v.bitrate, d.bitrateRange[0], d.bitrateRange[1], d.bitrate),
      fec: v.fec !== false,
      srtFallbackSec: v.srtFallbackSec == null ? null : clampInt(v.srtFallbackSec, 1, 60, SRT_FALLBACK_PROPOSED_SEC),
    };
  } catch { return null; }
}
function serializeSend(p) {
  return JSON.stringify({ target: p.target, targetMachine: p.targetMachine, targetMachineName: p.targetMachineName || "",
                          host: p.host, port: p.port, bitrate: p.bitrate, fec: !!p.fec, srtFallbackSec: p.srtFallbackSec ?? null });
}

/**
 * Should a feed from this station to `target` on `targetMachine` be refused? A sentence, or null.
 * The ONE refusal is this same machine — its own feed would come back into it (a loop). A station this machine
 * also airs is the normal case (the same station runs at the venue and at the studio). The self-test override
 * lifts the machine rule, but a station still never feeds its own board.
 */
function sendRefusal({ thisMachine, ownUuid, target, targetMachine, targetMachineName, selfTest = false }) {
  if (!isUuid(target)) return "pick where to send the feed";
  if (!isMachineId(targetMachine)) return "no computer airs that station yet — nothing to send to";
  if (thisMachine && lc(targetMachine) === lc(thisMachine)) {
    if (!selfTest) return `${targetMachineName || "that"} is this computer — sending its own feed back into itself would loop`;
    if (ownUuid && lc(target) === lc(ownUuid)) return "self-test: a station cannot feed its own board — the programme would loop";
  }
  return null;
}
/** Should this fader refuse the pasted key? The same rule from the receiving end. */
function inputRefusal({ thisMachine, from, selfTest = false }) {
  if (!from) return null;
  if (thisMachine && from.machine === lc(thisMachine) && !selfTest) return "that key was made on this computer — a fader cannot take this computer's own feed (it would loop)";
  return null;
}

module.exports = {
  LINK_SLOTS, KEY_INPUT, KEY_SEND, LINK_KEYS, MACHINE_KEY_FILE, TOKEN_PREFIX, FALLBACK_DEFAULTS, AUTO_CUT_DEFAULT, SRT_FALLBACK_PROPOSED_SEC,
  isUuid, isKeyHex, isMachineId, selfTestOn, machineDir, parseKey, serializeKey, readMachineKey, writeMachineKey, keyFingerprint,
  makeToken, parseToken, pairing, parseInput, serializeInput, parseSend, serializeSend, sendRefusal, inputRefusal,
};
