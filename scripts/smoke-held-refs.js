// scripts/smoke-held-refs.js — a reference that arrives as another computer's bare number is HELD, then filed under the
// right row once that computer's numbering is known (electron/sync/held-refs.js; Jeff, 2026-10-20).
//   npm run test:held-refs
"use strict";
const path = require("path");
const Database = require("better-sqlite3");
const ROOT = path.join(__dirname, "..");
const H = require(path.join(ROOT, "electron", "sync", "held-refs.js"));
const N = require(path.join(ROOT, "electron", "sync", "id-numbering.js"));

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${extra ? "  — " + extra : ""}`); } };

const OV = "041ceb96-0000-4000-8000-000000000001";
const KIDS = "752f4b9a-c845-4bd7-825c-cc312f96c994", HVADULT = "5805c744-9799-4d96-8196-1faac6f3f797", UPBEAT = "278eb19e-c03a-43c2-833c-ca43de74ed91";
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  CREATE TABLE install_config_kv (key TEXT PRIMARY KEY, value TEXT, uuid TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
  CREATE TABLE categories (id INTEGER PRIMARY KEY, uuid TEXT, name TEXT);
  CREATE TABLE songs (id INTEGER PRIMARY KEY, uuid TEXT, title TEXT, category_id INTEGER);
  CREATE TABLE mutations (id TEXT PRIMARY KEY, client_id TEXT, table_name TEXT, row_id TEXT, op TEXT, hlc TEXT, payload_before TEXT, payload_after TEXT);
`);
// This computer (OVEVENTS' numbering): 18 Upbeat, 19 Kids, 20 HV Adult. The other computer: 19 Upbeat, 20 Kids, 21 HV Adult.
for (const [id, uuid, name] of [[18, UPBEAT, "Upbeat"], [19, KIDS, "Kids"], [20, HVADULT, "HV Adult"]]) db.prepare("INSERT INTO categories VALUES (?, ?, ?)").run(id, uuid, name);
db.prepare("INSERT INTO songs VALUES (1, 'song-a', 'A Nightmare On My Street', 20)").run();   // here: HV Adult (wrong)
db.prepare("INSERT INTO songs VALUES (2, 'song-b', 'Bad Blood', 18)").run();
const mut = (id, row, hlc, before, after) => db.prepare("INSERT INTO mutations VALUES (?, ?, 'songs', ?, 'update', ?, ?, ?)").run(id, OV, row, hlc, JSON.stringify(before), JSON.stringify(after));
mut("m-a1", "song-a", "1760000000000:0:" + OV, { category_id: 21 }, { category_id: 20 });   // OV: → its 20 = Kids
mut("m-b1", "song-b", "1760000000000:0:" + OV, { category_id: 21 }, { category_id: 20 });

// 1 · held, with no numbering: nothing is filed, the song keeps this computer's value
H.hold(db, { mutation_id: "m-a1", client_id: OV, table: "songs", column: "category_id", ref_table: "categories", row_id: "song-a", their_id: 20, hlc: "1760000000000:0:" + OV });
H.hold(db, { mutation_id: "m-b1", client_id: OV, table: "songs", column: "category_id", ref_table: "categories", row_id: "song-b", their_id: 20, hlc: "1760000000000:0:" + OV });
check("two changes held; the Health Monitor summary counts them by computer", H.summary(db).count === 2 && H.summary(db).byComputer[OV].count === 2);
let r = H.resolveHeld(db);
check("no numbering from that computer: both still held, nothing filed", r.waiting.length === 2 && r.filed.length === 0 && H.list(db).length === 2);
check("…and the songs keep this computer's value (never the sender's number)", db.prepare("SELECT category_id c FROM songs WHERE id = 1").get().c === 20);

// 2 · a newer change sets song B's category after the held one — the newer one stands
mut("m-b2", "song-b", "1760000000999:0:" + OV, { category_id: 20 }, { category_id: 19 });

// 3 · the other computer publishes its numbering: 19 Upbeat, 20 Kids, 21 HV Adult
db.prepare("INSERT INTO install_config_kv (key, value, uuid, created_at, updated_at) VALUES (?, ?, 'u1', 'x', ?)")
  .run(N.KEY_PREFIX + OV, JSON.stringify({ v: 1, client_id: OV, tables: { categories: { 19: UPBEAT, 20: KIDS, 21: HVADULT } }, labels: {} }), new Date().toISOString());
r = H.resolveHeld(db);
check("numbering known: song A's held change is filed under THIS computer's Kids (19), not its 20 (HV Adult)",
  r.filed.length === 1 && db.prepare("SELECT category_id c FROM songs WHERE id = 1").get().c === 19, JSON.stringify(r));
check("song B's held change is dropped — a newer change set that field since", r.superseded.length === 1 && r.superseded[0].row_id === "song-b"
  && db.prepare("SELECT category_id c FROM songs WHERE id = 2").get().c === 18);
check("nothing is held any more", H.list(db).length === 0 && H.summary(db).count === 0);

// 4 · the newest held change for a field replaces an older held one
H.hold(db, { mutation_id: "x1", client_id: OV, table: "songs", column: "category_id", ref_table: "categories", row_id: "song-c", their_id: 19 });
H.hold(db, { mutation_id: "x2", client_id: OV, table: "songs", column: "category_id", ref_table: "categories", row_id: "song-c", their_id: 21 });
check("one held entry per field: the newer replaces the older", H.list(db).length === 1 && H.list(db)[0].mutation_id === "x2");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
