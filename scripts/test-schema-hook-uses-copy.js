// scripts/test-schema-hook-uses-copy.js — the pre-commit schema check (scripts/verify-transformer-chain.js) checks against
// a COPY, never the live profile database (Jeff, 2026-10-27).
//   npm run test:schema-hook
// A fake Ether data folder is built in a temp folder (LOCALAPPDATA points at it): an active profile whose openair.db is
// NOT a database. The old hook opened it on every commit (and failed here, "file is not a database"); the new one must
// never touch it — not open it, not create its -wal/-shm.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const Database = require("better-sqlite3");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };

const T = fs.mkdtempSync(path.join(os.tmpdir(), "schema-hook-"));
const LOCAL = path.join(T, "LocalAppData");
const PROFILE = path.join(LOCAL, "Ether", "profiles", "ETH-STN-TEST-0000-0000");
fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(path.join(LOCAL, "Ether", "profiles", "active"), "ETH-STN-TEST-0000-0000");
const LIVE = path.join(PROFILE, "openair.db");
fs.writeFileSync(LIVE, "THE LIVE DATABASE — the hook must never open this");
const liveBefore = fs.readFileSync(LIVE);

const ROOT = path.join(__dirname, "..");
const electron = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
// Exactly as .githooks/pre-commit runs it: Electron itself, not Electron-as-Node.
const hook = (env) => {
  const e = { ...process.env, LOCALAPPDATA: LOCAL, ETHER_SCHEMA_DB: "", ...env };
  delete e.ELECTRON_RUN_AS_NODE;
  return cp.spawnSync(electron, ["--no-sandbox", path.join(ROOT, "scripts", "verify-transformer-chain.js")],
    { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", timeout: 180000, env: e });
};
const untouched = () => fs.readFileSync(LIVE).equals(liveBefore) && !fs.existsSync(LIVE + "-wal") && !fs.existsSync(LIVE + "-shm");

console.log("\n── no copy named: the hook checks the database it builds itself ──");
let r = hook({});
ok(r.status === 0, `the hook passes without opening the live profile (exit ${r.status})${r.status ? "\n" + (r.stdout + r.stderr).slice(-600) : ""}`);
ok(/checking against the database this check builds/.test(r.stdout), "it says which database it checked");
ok(untouched(), "the live profile database was not opened (unchanged; no -wal / -shm)");

console.log("\n── a copy named: that copy is checked ──");
const COPY = path.join(T, "copies", "openair-copy.db");
fs.mkdirSync(path.dirname(COPY));
const d = new Database(COPY);
d.exec("CREATE TABLE schema_version (version INTEGER)");
const maxV = Math.max(...fs.readdirSync(path.join(ROOT, "scripts")).map(f => /^migrate-.+-phase-sync-(\d+)\.js$/.exec(f)).filter(Boolean).map(m => +m[1]));
for (let v = 1; v <= maxV; v++) d.prepare("INSERT INTO schema_version VALUES (?)").run(v);
d.close();
r = hook({ ETHER_SCHEMA_DB: COPY });
ok(r.status === 0 && r.stdout.includes(`copy: ${COPY}`), `the named copy is the one checked (exit ${r.status})`);
ok(untouched(), "the live profile database still untouched");

console.log("\n── a path inside the Ether data folder is refused, not opened ──");
r = hook({ ETHER_SCHEMA_DB: LIVE });
ok(r.status === 1 && /refusing to open/.test(r.stderr), `naming the live database is refused (exit ${r.status})`);
ok(untouched(), "and it was not opened");

console.log("\n── the hook itself ──");
const src = fs.readFileSync(path.join(ROOT, "scripts", "verify-transformer-chain.js"), "utf8");
ok(!/resolveActive|P\.dbPath|activeKey/.test(src), "the hook never resolves the active profile");
ok(/verify-transformer-chain\.js/.test(fs.readFileSync(path.join(ROOT, ".githooks", "pre-commit"), "utf8")), ".githooks/pre-commit runs this script");

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
