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

// 1b · the pasted key rides in link_input
const M1 = "8e8f6181-b68a-433f-a93d-8005787b641b", M2 = "041ceb96-3d66-4d39-85c0-e2f5aa6e3b1e";
const withFrom = L.parseInput(JSON.stringify({ slot: "D", from: { machine: M2.toUpperCase(), name: "ovowforestmusic", keyId: 2, key: "AB".repeat(32) } }), D);
ok(withFrom && withFrom.from && withFrom.from.machine === M2 && withFrom.from.key === "ab".repeat(32) && withFrom.from.keyId === 2, "input: the pasted key (lower-cased) is kept on the fader");
ok(JSON.stringify(L.parseInput(L.serializeInput(withFrom), D)) === JSON.stringify(withFrom), "input: serialize ∘ parse keeps the key");
ok(L.parseInput(JSON.stringify({ slot: "D", from: { machine: M2, key: "zz" } }), D).from === null, "input: a malformed pasted key is no key");

// 2 · link_send — a computer · a station
ok(L.parseSend(JSON.stringify({ target: "x", targetMachine: M2, host: "h" })) === null, "send: a target that is not a UUID is refused");
ok(L.parseSend(JSON.stringify({ target: U1, host: "h" })) === null, "send: no computer = not a feed");
ok(L.parseSend(JSON.stringify({ target: U1, targetMachine: M2, host: "  " })) === null, "send: an empty address is refused");
const snd = L.parseSend(JSON.stringify({ target: U1.toUpperCase(), targetMachine: M2.toUpperCase(), targetMachineName: " OV ", host: " 127.0.0.1 " }), D);
ok(snd && snd.target === U1 && snd.targetMachine === M2 && snd.targetMachineName === "OV" && snd.host === "127.0.0.1" && snd.bitrate === 128000 && snd.fec === true && snd.port === 9760 && snd.srtFallbackSec === null,
   "send: normalised (lower-case UUID + machine, trimmed) with D5 defaults, FEC on, SRT fallback unset");
ok(L.parseSend(JSON.stringify({ target: U1, targetMachine: M2, host: "h", bitrate: 1 }), D).bitrate === 32000, "send: bitrate clamped to 32–256 kb/s");

// 3 · the key — made by the SENDING machine, carried as one line
const k = L.parseKey(L.serializeKey({ key: "ab".repeat(32), id: 3 }));
ok(k && k.id === 3 && k.key === "ab".repeat(32) && k.mintedAt, "key: round-trips with id and mintedAt");
ok(L.parseKey(JSON.stringify({ key: "zz" })) === null, "key: a malformed key is not a key");
const fp = L.keyFingerprint(k);
ok(/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(fp) && !fp.toLowerCase().includes("abab"), `key: fingerprint ${fp} — 8 hex of SHA-256, not the key`);
const line = L.makeToken({ machine: M1, name: "OVEVENTS", key: k });
ok(line.startsWith("ether-link:1:" + M1 + ":3:"), `line: ${line.slice(0, 60)}… names the machine and the key id`);
const back = L.parseToken("  " + line.slice(0, 40) + "\n" + line.slice(40) + " ");
ok(back && back.machine === M1 && back.name === "OVEVENTS" && back.keyId === 3 && back.key === k.key, "line: survives a copy that wraps or pads it");
ok(L.parseToken(L.makeToken({ machine: M1, name: "Studio: B / 2", key: k })).name === "Studio: B / 2", "line: a machine name with ':' and spaces round-trips");
ok(L.parseToken("ether-link:1:" + M1 + ":3:zz:x") === null && L.parseToken("hello") === null && L.parseToken("") === null, "line: anything else is not a key");
ok(L.pairing(M1.toUpperCase(), " " + M2) === `${M1}|${M2}`, "pairing: \"<receiving>|<sending>\", lower-case, trimmed");
// the machine key file, beside machine-id
const os = require("os");
ok(L.machineDir({ platform: "win32", localAppData: "C:\\L" }) === path.join("C:\\L", "EtherMachine"), "machine dir: LocalAppData\\EtherMachine on Windows (main's _machineIdDir)");
ok(L.machineDir({ platform: "darwin", userDataDir: "/u/Library/Application Support/Ether" }) === path.join("/u/Library/Application Support", "EtherMachine"), "machine dir: beside userData elsewhere");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "link-key-"));
ok(L.readMachineKey(tmp) === null, "machine key: none yet reads as none");
L.writeMachineKey(path.join(tmp, "EtherMachine"), k);
ok(L.readMachineKey(path.join(tmp, "EtherMachine")).key === k.key, "machine key: written and read back");
fs.rmSync(tmp, { recursive: true, force: true });

// 4 · the one refusal: this same computer
ok(/pick where/.test(L.sendRefusal({ thisMachine: M1, target: "x", targetMachine: M2 })), "refused: no station");
ok(/no computer airs/.test(L.sendRefusal({ thisMachine: M1, target: U2, targetMachine: "" })), "refused: no computer for that station");
ok(/this computer.*loop/.test(L.sendRefusal({ thisMachine: M1, ownUuid: U1, target: U2, targetMachine: M1.toUpperCase(), targetMachineName: "OVEVENTS" })), "refused: a feed to this same computer (a loop)");
ok(L.sendRefusal({ thisMachine: M1, ownUuid: U1, target: U1, targetMachine: M2 }) === null, "allowed: the SAME station on another computer (the normal case)");
ok(L.sendRefusal({ thisMachine: M1, ownUuid: U1, target: U2, targetMachine: M2 }) === null, "allowed: another station on another computer");
ok(L.sendRefusal({ thisMachine: M1, ownUuid: U1, target: U2, targetMachine: M1, selfTest: true }) === null, "self-test: another station on this computer is allowed");
ok(/own board/.test(L.sendRefusal({ thisMachine: M1, ownUuid: U1, target: U1, targetMachine: M1, selfTest: true })), "self-test: a station never feeds its own board");
ok(/this computer/.test(L.inputRefusal({ thisMachine: M1, from: { machine: M1 } })), "fader: this computer's own key is refused");
ok(L.inputRefusal({ thisMachine: M1, from: { machine: M1 }, selfTest: true }) === null, "fader: …unless the self-test override is on");
ok(L.inputRefusal({ thisMachine: M1, from: { machine: M2 } }) === null && L.inputRefusal({ thisMachine: M1, from: null }) === null, "fader: another computer's key, or none, is fine");
ok(L.selfTestOn({ ETHER_LINK_SELF_TEST: "1" }) && !L.selfTestOn({}) && !L.selfTestOn({ ETHER_LINK_SELF_TEST: "true" }), "self-test: only ETHER_LINK_SELF_TEST=1");

// 5 · machine-local: every link_ key is refused by the synced writers
const kv = require(path.join(__dirname, "..", "electron", "sync", "handlers", "station_config_kv.js"));
ok(L.LINK_KEYS.every(key => kv.isLocalOnlyKey(key)), `local-only: ${L.LINK_KEYS.join(", ")} never ride the mutation log`);

// 6 · the wiring the UI depends on
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const daemon = read("audiod/ether-audiod.js"), main = read("electron/main.js"), preload = read("electron/preload.js");
for (const c of ["setLinkInput", "setLinkSend", "linkState", "linkDefaults", "linkKeyChanged"]) ok(new RegExp(`\\b${c}:\\s*\\(`).test(daemon), `daemon command ${c}`);
for (const h of ["link:get", "link:set-input", "link:set-send", "link:mint-key", "link:key-line", "link:state"]) {
  ok(main.includes(`ipcMain.handle("${h}"`), `main handles ${h}`);
  ok(preload.includes(`"${h}"`), `preload exposes ${h}`);
}
ok(/tick % 30 === 0\) linkReapply\(sid\)/.test(daemon), "daemon re-applies the stored Link every 3 s per station");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
