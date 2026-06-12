// Standalone proof for the top-of-hour scheduler read (loggen.fillFromHour). No daemon,
// no native addon, no audio — an in-memory node:sqlite DB with a hand-built schedule, so we
// can verify the hard-cut picks the NEW hour's first element and never a previous-hour tail.
//   node audiod/smoke-topofhour.js
const { DatabaseSync } = require("node:sqlite");
const loggen = require("./loggen");

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, artist_id INTEGER, file_path TEXT,
    duration_ms INTEGER, intro_end REAL, outro_start REAL, category_id INTEGER,
    rotation_status TEXT, daypart_mask INTEGER, last_played_at INTEGER, no_repeat_hours INTEGER);
  CREATE TABLE generated_schedule (id INTEGER PRIMARY KEY AUTOINCREMENT, scheduled_at INTEGER,
    song_id INTEGER, title TEXT, artist TEXT, file_path TEXT, file_key TEXT, duration_s INTEGER,
    category_id INTEGER, clock_id INTEGER, station_id INTEGER, deleted_at TEXT);
  CREATE TABLE clock_slots (clock_id INTEGER, slot_type TEXT, category_id INTEGER, position INTEGER, duration_min INTEGER, station_id INTEGER, deleted_at TEXT);
  CREATE TABLE shows (id INTEGER, clock_id INTEGER, is_active INTEGER, start_hour INTEGER, end_hour INTEGER, days TEXT, station_id INTEGER, name TEXT, deleted_at TEXT);
  CREATE TABLE separation_rules (rule_type TEXT, value INTEGER, is_active INTEGER, station_id INTEGER);
`);

const SID = 1;
// Local 6:00 and 7:00 today (matches how generated_schedule.scheduled_at is computed: local setHours).
const d6 = new Date(); d6.setHours(6, 0, 0, 0); const h6 = Math.floor(d6.getTime() / 1000);
const d7 = new Date(); d7.setHours(7, 0, 0, 0); const h7 = Math.floor(d7.getTime() / 1000);

const ins = db.prepare(`INSERT INTO generated_schedule (scheduled_at, song_id, title, artist, file_path, duration_s, station_id) VALUES (?,?,?,?,?,?,?)`);
// 6 o'clock hour
ins.run(h6,        1, "Six AM Opener",  "A", __filename, 180, SID);
ins.run(h6 + 180,  2, "Six-Oh-Three",   "B", __filename, 200, SID);
ins.run(h6 + 3500, 3, "Six Fifty-Eight","C", __filename, 240, SID); // tail of 6, runs past 7:00
// 7 o'clock hour
ins.run(h7,        4, "TOP OF HOUR 7",  "D", __filename, 5,   SID); // the legal/station ID slot
ins.run(h7 + 5,    5, "Seven-Oh-Five",  "E", __filename, 210, SID);
ins.run(h7 + 215,  6, "Seven-Oh-Eight", "F", __filename, 200, SID);

const items = loggen.fillFromHour(db, SID, h7, 20);
console.log(`\nfillFromHour(@7:00) returned ${items.length} item(s):`);
items.forEach((it, i) => console.log(`  ${i + 1}. ${it.title}  (scheduledAt=${it.scheduledAt})`));

const first = items[0];
const noTail = !items.some(it => it.title.startsWith("Six"));
const firstIsTop = first && first.title === "TOP OF HOUR 7" && first.scheduledAt === h7;
const ok = firstIsTop && noTail && items.length === 3;
console.log("\nchecks:");
console.log(`  first element is the 7:00 top-of-hour item ........ ${firstIsTop ? "PASS" : "FAIL"}`);
console.log(`  no previous-hour (6 o'clock) tail leaked in ....... ${noTail ? "PASS" : "FAIL"}`);
console.log(`  exactly the 3 seven-o'clock rows returned ......... ${items.length === 3 ? "PASS" : "FAIL"}`);
console.log("\n" + (ok ? "✅ top-of-hour read is correct" : "❌ top-of-hour read is WRONG"));
process.exit(ok ? 0 : 1);
