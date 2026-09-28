// smoke-link.js — THE REMOTE LINK's stored settings and wiring (docs/remote-link-design-2026-09-28.md).
//   npm run test:link
// Pure checks of audiod/link.js, the local-only rule for every link_ key, and that the daemon, main and preload
// carry every command the UI calls. No engine, no DB, no Electron.
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("./link");

let fails = 0;
const ok = (c, msg) => { console.log(`${c ? "PASS" : "FAIL"}  ${msg}`); if (!c) fails++; };
const D = L.FALLBACK_DEFAULTS;
const U1 = "43889edc-203d-4743-9e4f-6ea311d6e035", U2 = "dfbc68ac-e4d2-4769-9519-a28ead7884ae";

// 1 · link_input
ok(L.parseInput(null) === null && L.parseInput("nonsense") === null, "input: nothing stored / unreadable = not patched");
ok(L.parseInput(JSON.stringify({ slot: "A" })) === null, "input: A (an automation deck) is refused");
const inp = L.parseInput(JSON.stringify({ slot: "S2" }), D);
ok(inp && inp.jitterMs === 120 && inp.port === 9760 && inp.autoCut === false && inp.autoCutSec === 5, "input: D5 defaults (120 ms, UDP 9760) and D4 auto-cut OFF, 5 s");
ok(L.parseInput(JSON.stringify({ slot: "S2", jitterMs: 5 }), D).jitterMs === 20 && L.parseInput(JSON.stringify({ slot: "S2", jitterMs: 99999 }), D).jitterMs === 1000, "input: buffer clamped to the engine's range 20–1000 ms");
ok(JSON.stringify(L.parseInput(L.serializeInput(inp), D)) === JSON.stringify(inp), "input: serialize ∘ parse is the identity");

// 2 · link_send
ok(L.parseSend(JSON.stringify({ target: "x", host: "h" })) === null, "send: a target that is not a UUID is refused");
ok(L.parseSend(JSON.stringify({ target: U1, host: "  " })) === null, "send: an empty address is refused");
const snd = L.parseSend(JSON.stringify({ target: U1.toUpperCase(), host: " 127.0.0.1 " }), D);
ok(snd && snd.target === U1 && snd.host === "127.0.0.1" && snd.bitrate === 128000 && snd.fec === true && snd.port === 9760 && snd.srtFallbackSec === null,
   "send: normalised (lower-case UUID, trimmed host) with D5 defaults, FEC on, SRT fallback unset");
ok(L.parseSend(JSON.stringify({ target: U1, host: "h", bitrate: 1 }), D).bitrate === 32000, "send: bitrate clamped to 32–256 kb/s");

// 3 · the key
const k = L.parseKey(L.serializeKey({ key: "ab".repeat(32), id: 3 }));
ok(k && k.id === 3 && k.key === "ab".repeat(32) && k.mintedAt, "key: round-trips with id and mintedAt");
ok(L.parseKey(JSON.stringify({ key: "zz" })) === null, "key: a malformed key is not a key");
const fp = L.keyFingerprint(k);
ok(/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(fp) && !fp.toLowerCase().includes("abab"), `key: fingerprint ${fp} — 8 hex of SHA-256, not the key`);

// 4 · the refusals
ok(/itself/.test(L.sendRefusal({ ownUuid: U1, target: U1 })), "refused: a station sending to itself");
ok(/this machine airs/.test(L.sendRefusal({ ownUuid: U1, target: U2, targetName: "Magical Forest", designatedHere: true })), "refused: a station this machine airs");
ok(/loop/.test(L.sendRefusal({ ownUuid: U1, target: U2, targetName: "X", targetSendsToOwn: true })), "refused: a two-way loop");
ok(L.sendRefusal({ ownUuid: U1, target: U2, targetName: "X" }) === null, "allowed: another station, aired elsewhere, not sending back");

// 5 · machine-local: every link_ key is refused by the synced writers
const kv = require(path.join(__dirname, "..", "electron", "sync", "handlers", "station_config_kv.js"));
ok(L.LINK_KEYS.every(key => kv.isLocalOnlyKey(key)), `local-only: ${L.LINK_KEYS.join(", ")} never ride the mutation log`);

// 6 · the wiring the UI depends on
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const daemon = read("audiod/ether-audiod.js"), main = read("electron/main.js"), preload = read("electron/preload.js");
for (const c of ["setLinkInput", "setLinkSend", "linkState", "linkDefaults", "linkKeyChanged"]) ok(new RegExp(`\\b${c}:\\s*\\(`).test(daemon), `daemon command ${c}`);
for (const h of ["link:get", "link:set-input", "link:set-send", "link:mint-key", "link:state"]) {
  ok(main.includes(`ipcMain.handle("${h}"`), `main handles ${h}`);
  ok(preload.includes(`"${h}"`), `preload exposes ${h}`);
}
ok(/tick % 30 === 0\) linkReapply\(sid\)/.test(daemon), "daemon re-applies the stored Link every 3 s per station");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
