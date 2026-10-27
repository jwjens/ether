#!/usr/bin/env node
// scripts/engine-fill-check.js — does an audio ENGINE fill a station's queue from its log? (2026-10-27, 4.6.66: the staged
// engine had no electron/catalogue.js, so every song read as unplayable and the queue never filled on OV.)
//
// Starts the engine at <engineRoot> (an install's resources\app.asar.unpacked, or a staged %LOCALAPPDATA%\Ether\engine)
// with <runtimeExe> as Node (ELECTRON_RUN_AS_NODE), on <dbPath> (use a COPY), on its OWN pipe — never the running app's.
// Sends `engine` (what it loaded) and `fill` for <stationId> (refill the queue from the log; nothing plays), prints what the
// queue holds and what the engine logged, then shuts it down. Exit 0 = the queue filled, 1 = it did not.
//
//   node scripts/engine-fill-check.js <runtimeExe> <engineRoot> <dbPath> <stationId>
"use strict";
const cp = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const [exe, root, dbPath, sidArg] = process.argv.slice(2);
if (!exe || !root || !dbPath || !sidArg) { console.error("usage: engine-fill-check.js <runtimeExe> <engineRoot> <dbPath> <stationId>"); process.exit(2); }
const stationId = Number(sidArg);
const script = path.join(root, "audiod", "ether-audiod.js");
for (const p of [exe, script, dbPath]) if (!fs.existsSync(p)) { console.error("not found: " + p); process.exit(2); }

const pipe = process.platform === "win32" ? `\\\\.\\pipe\\ether-audiod-fillcheck-${process.pid}` : path.join(os.tmpdir(), `ether-audiod-fillcheck-${process.pid}.sock`);
const logFile = path.join(os.tmpdir(), `ether-fillcheck-${process.pid}.log`);
const out = fs.openSync(logFile, "a");
const child = cp.spawn(exe, [script], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ETHER_DB_PATH: dbPath, ETHER_AUDIOD_PIPE: pipe },
  stdio: ["ignore", out, out], windowsHide: true,
});
console.log(`engine: ${script}\nrunning as: ${exe} (pid ${child.pid})\npipe: ${pipe}\ndatabase: ${dbPath}\nengine log: ${logFile}`);

function connect(deadline) {
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(pipe);
      s.once("connect", () => resolve(s));
      s.once("error", () => { s.destroy(); if (Date.now() > deadline) reject(new Error("engine never opened its pipe")); else setTimeout(tryOnce, 250); });
    };
    tryOnce();
  });
}

(async () => {
  let ok = false;
  try {
    const sock = await connect(Date.now() + 20000);
    let buf = "", nextId = 1; const pending = new Map();
    sock.on("data", (d) => {
      buf += d.toString("utf8"); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      }
    });
    const cmd = (name, args = {}, ms = 30000) => new Promise((resolve, reject) => {
      const id = nextId++; pending.set(id, resolve);
      sock.write(JSON.stringify({ id, cmd: name, ...args }) + "\n");
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${name}: no reply in ${ms} ms`)); } }, ms);
    });
    const eng = await cmd("engine");
    console.log(`loaded: native ${String(eng.result && eng.result.native).slice(0, 12)}  code ${String(eng.result && eng.result.code).slice(0, 12)}  root ${eng.result && eng.result.root}`);
    const r = await cmd("fill", { stationId });
    if (!r.ok) console.log(`fill: ERROR ${r.error}`);
    const q = Array.isArray(r.result) ? r.result : [];
    console.log(`station ${stationId}: queue after fill = ${q.length} item(s)`);
    for (const it of q.slice(0, 5)) console.log(`  ${it.title || "?"} — ${it.artist || ""}  ${it.filePath ? path.basename(String(it.filePath)) : ""}`);
    ok = q.length > 0;
    try { await cmd("shutdown", {}, 3000); } catch { /* it is exiting */ }
    sock.destroy();
  } catch (e) { console.log("ERROR " + e.message); }
  await new Promise(r => setTimeout(r, 1500));
  try { if (child.exitCode == null) child.kill(); } catch {}
  try { fs.closeSync(out); } catch {}
  const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(l => /playable|catalogue|Cannot find module|MODULE_NOT_FOUND|✗|ERROR|fill|refill/i.test(l));
  console.log(`--- engine log lines about playability / errors (${lines.length}):`);
  for (const l of lines.slice(0, 20)) console.log("  " + l.slice(0, 220));
  console.log(ok ? "RESULT: the queue FILLED" : "RESULT: the queue did NOT fill");
  process.exit(ok ? 0 : 1);
})();
