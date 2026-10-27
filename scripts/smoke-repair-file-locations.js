// scripts/smoke-repair-file-locations.js — the one-time file-location repair (scripts/repair-file-locations.js) on a
// database built here, in a temp folder (never a real one):
//   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-repair-file-locations.js
// Four songs: one in the catalogue, one at a location the user chose outside it, one whose stored folder is gone but whose
// name is in the catalogue, one gone everywhere with a cloud copy, one gone with nothing. Read-only first (nothing changes),
// then --apply: only the lost-but-in-the-catalogue row moves, the user's location is untouched, a backup is written.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const Database = require("better-sqlite3");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };

const T = fs.mkdtempSync(path.join(os.tmpdir(), "loc-repair-"));
const CAT = path.join(T, "catalogue"), MINE = path.join(T, "my music");
fs.mkdirSync(CAT); fs.mkdirSync(MINE);
for (const n of ["In Catalogue.mp3", "Lost But Here.mp3"]) fs.writeFileSync(path.join(CAT, n), "x");
fs.writeFileSync(path.join(MINE, "My Choice.mp3"), "x");
const DB = path.join(T, "openair.db");
const db = new Database(DB);
db.exec("CREATE TABLE songs (id INTEGER PRIMARY KEY, uuid TEXT, title TEXT, file_path TEXT, file_key TEXT, deleted_at TEXT)");
const rows = [
  [1, "In Catalogue", path.join(CAT, "In Catalogue.mp3"), null],
  [2, "My Choice", path.join(MINE, "My Choice.mp3"), null],
  [3, "Lost But Here", "C:\\Users\\projector\\Music\\Lost But Here.mp3", null],
  [4, "Cloud Only", path.join(CAT, "Cloud Only.mp3"), "Cloud Only.mp3"],
  [5, "Nowhere", "C:\\Users\\projector\\Music\\Nowhere.mp3", null],
];
for (const r of rows) db.prepare("INSERT INTO songs (id, title, file_path, file_key) VALUES (?, ?, ?, ?)").run(...r);
db.close();

const run = (extra) => cp.spawnSync(process.execPath, [path.join(__dirname, "repair-file-locations.js"), DB, "--catalogue", CAT, "--out", path.join(T, "r.json"), ...extra],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
const paths = () => { const d = new Database(DB, { readonly: true }); const m = Object.fromEntries(d.prepare("SELECT id, file_path FROM songs").all().map(r => [r.id, r.file_path])); d.close(); return m; };

const before = paths();
let r = run([]);
const rep = JSON.parse(fs.readFileSync(path.join(T, "r.json"), "utf8"));
ok(r.status === 0, "read-only run exits 0");
ok(JSON.stringify(paths()) === JSON.stringify(before), "read-only: nothing in the database changed");
ok(rep.totals.kept === 2 && rep.totals.repoint === 1 && rep.totals.download === 1 && rep.totals.missing === 1,
   `read-only: kept 2, repoint 1, download 1, missing 1 (got ${JSON.stringify(rep.totals)})`);
ok(rep.rows.find(x => x.id === 3 && x.action === "repoint" && x.to === path.join(CAT, "Lost But Here.mp3")), "the lost row would point at its same-named catalogue file");
ok(!rep.rows.some(x => x.id === 2), "the user's chosen location is not even listed — it is kept");

// --apply refuses while Ether runs; here it is not running (a dev machine may have it: then this check is skipped).
const etherUp = /^"(Ether|ether-engine)\.exe"/im.test(cp.execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" }));
if (etherUp) { console.log("  ..   Ether is running here — --apply correctly refuses; the apply checks are skipped"); ok(run(["--apply"]).status === 3, "--apply refuses while Ether runs"); }
else {
  r = run(["--apply"]);
  const after = paths();
  ok(r.status === 0, "--apply exits 0");
  ok(after[3] === path.join(CAT, "Lost But Here.mp3"), "--apply: the lost row now points at the catalogue file");
  ok(after[1] === before[1] && after[2] === before[2] && after[4] === before[4] && after[5] === before[5], "--apply: every other row is exactly as it was (the user's choice included)");
  ok(fs.readdirSync(T).some(n => n.startsWith("openair.before-location-repair-")), "--apply: a backup of the database was written first");
}
fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
