// scripts/verify-package-contents.js — release check: the packaged app holds every package the last good build held,
// and its size is in line with it (Jeff, 2026-10-18, after a build shipped ~130 packages short through a node_modules link).
//
//   node scripts/verify-package-contents.js <new win-unpacked dir> <last good win-unpacked dir> [new installer.exe] [last good installer.exe]
//
// FAIL if any node_modules package (inside app.asar or app.asar.unpacked) of the good build is missing from the new one.
// Size: the new installer is reported against the last good one and FAILs if more than 10% smaller (a missing dependency
// tree shows up as tens of MB). Packages only in the new build are listed, not failed.
"use strict";
const fs = require("fs");
const path = require("path");
const asar = (() => { try { return require("@electron/asar"); } catch { return require("asar"); } })();

const [newDir, goodDir, newExe, goodExe] = process.argv.slice(2);
if (!newDir || !goodDir) { console.log("usage: verify-package-contents.js <new win-unpacked> <good win-unpacked> [new.exe] [good.exe]"); process.exit(2); }

function packages(dir) {
  const res = path.join(dir, "resources");
  const set = new Set();
  const add = (p) => {
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== "node_modules" || !parts[i + 1]) continue;
      const name = parts[i + 1].startsWith("@") ? (parts[i + 2] ? parts[i + 1] + "/" + parts[i + 2] : null) : parts[i + 1];
      if (name) set.add(parts.slice(0, i).filter(x => x !== "node_modules").length ? parts.slice(0, i + 1).join("/") + "/" + name : name);
    }
  };
  for (const f of asar.listPackage(path.join(res, "app.asar"))) add(f);
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel + "/" + e.name; if (e.isDirectory()) { add(r + "/x"); walk(path.join(d, e.name), r); } } };
  const un = path.join(res, "app.asar.unpacked");
  if (fs.existsSync(un)) walk(un, "");
  // top-level names only (nested copies differ legitimately between dedupe runs)
  return new Set([...set].filter(n => !n.includes("/node_modules/")).map(n => n.replace(/^.*node_modules\//, "")));
}

let fail = 0;
const a = packages(newDir), b = packages(goodDir);
const missing = [...b].filter(x => !a.has(x)).sort();
const extra = [...a].filter(x => !b.has(x)).sort();
console.log(`packages: new ${a.size}, last good ${b.size}`);
if (missing.length) { fail++; console.log(`FAIL  ${missing.length} package(s) of the last good build are missing: ${missing.join(", ")}`); }
else console.log("PASS  every package of the last good build is present");
if (extra.length) console.log(`note  only in the new build: ${extra.join(", ")}`);

if (newExe && goodExe) {
  const sn = fs.statSync(newExe).size, sg = fs.statSync(goodExe).size;
  const pct = ((sn - sg) / sg * 100).toFixed(1);
  const ok = sn >= sg * 0.9;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  installer size ${(sn / 1e6).toFixed(1)} MB vs last good ${(sg / 1e6).toFixed(1)} MB (${pct}%)`);
}
console.log(fail ? "VERDICT: FAIL" : "VERDICT: PASS");
process.exit(fail ? 1 : 0);
