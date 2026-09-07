// Bench: WHAT MAY BE QUEUED TO A ROTATION DECK. Exercises the REAL loggen queue-fill queries against an
// in-memory database — no live station, no audio, safe to run anytime.
//   Run:  node audiod/smoke-queue-classes.js   (exit 0 = pass)
//
// THE INVARIANT:
//
//     A SWEEPER IS NEVER QUEUE-ELIGIBLE FOR A ROTATION DECK,
//     AND THAT MUST NOT DEPEND ON THE CATEGORY CLAUSE BEING PRESENT.
//
// Why this file exists. Until 2026-09-07 the two queue-fill queries excluded only content_class 'JIN' —
// an empty set since v52 collapsed every sweeper to 'SWP' — while the two anchor queries in the same file
// correctly excluded NOT IN ('JIN','SWP'). The file disagreed with itself about what may go on a deck.
//
// What actually kept sweepers off the decks was INCIDENTAL: catClause requires
// `s.category_id IN (…format categories…)` and sweeper songs carry category_id = NULL, so they failed it.
// But that clause is conditional — `fmt.length ? … : ""` — so on an hour with no active show clock it
// disappears, and the only remaining filter excluded a class nobody uses. 6,715 rows on the live station
// were under 5s, which is exactly the band with no position-based end detection (engine.js checkEnd).
//
// So the SECOND case below is the one that matters: with NO clocks and NO categories, the exclusion must
// still hold on its own. A test that only covers the happy path would have passed the whole time.
"use strict";
const path = require("path");
const Database = require(path.join("C:/openair", "node_modules", "better-sqlite3"));
const loggen = require(path.join(__dirname, "loggen.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

/** A database with one music row and one sweeper row on the log. `withClock` decides whether the format
 *  category clause will be present — the whole point of the second case. */
function makeDb({ withClock }) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE stations (id INTEGER PRIMARY KEY, scheduler_mode TEXT);
    CREATE TABLE categories (id INTEGER PRIMARY KEY, station_id INTEGER, code TEXT, deleted_at TEXT);
    CREATE TABLE shows (id INTEGER PRIMARY KEY, station_id INTEGER, clock_id INTEGER, is_active INTEGER, deleted_at TEXT);
    CREATE TABLE clock_slots (id INTEGER PRIMARY KEY, station_id INTEGER, clock_id INTEGER, slot_type TEXT, category_id INTEGER, deleted_at TEXT);
    CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE songs (
      id INTEGER PRIMARY KEY, title TEXT, artist_id INTEGER, category_id INTEGER, file_path TEXT, file_key TEXT,
      duration_ms INTEGER, intro_end REAL, outro_start REAL, content_class TEXT, rotation_status TEXT,
      daypart_mask INTEGER, no_repeat_hours INTEGER, deleted_at TEXT);
    CREATE TABLE generated_schedule (
      id INTEGER PRIMARY KEY, station_id INTEGER, scheduled_at INTEGER, song_id INTEGER, title TEXT, artist TEXT,
      file_key TEXT, file_path TEXT, duration_s INTEGER, category_id INTEGER, content_class TEXT,
      channel TEXT, lead_in_sec REAL, jingle_category_id INTEGER, state TEXT, source TEXT, deleted_at TEXT);
    CREATE TABLE play_log (id INTEGER PRIMARY KEY, station_id INTEGER, file_path TEXT, played_at INTEGER, deleted_at TEXT);
    CREATE TABLE separation_rules (id INTEGER PRIMARY KEY, station_id INTEGER, rule_type TEXT, value INTEGER, is_active INTEGER);
  `);
  db.prepare("INSERT INTO stations (id, scheduler_mode) VALUES (1, NULL)").run();
  db.prepare("INSERT INTO categories (id, station_id, code) VALUES (7, 1, 'HV')").run();
  // A MUSIC song, in a category. A SWEEPER, with category_id NULL — exactly as the live library stores them.
  db.prepare("INSERT INTO songs (id,title,category_id,file_path,duration_ms,content_class) VALUES (10,'A Song',7,'X:/song.mp3',180000,'MUSIC')").run();
  db.prepare("INSERT INTO songs (id,title,category_id,file_path,duration_ms,content_class) VALUES (20,'A Sweeper',NULL,'X:/swp.mp3',2000,'SWP')").run();
  if (withClock) {
    db.prepare("INSERT INTO shows (id,station_id,clock_id,is_active) VALUES (1,1,5,1)").run();
    db.prepare("INSERT INTO clock_slots (id,station_id,clock_id,slot_type,category_id) VALUES (1,1,5,'music',7)").run();
  }
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO generated_schedule (id,station_id,scheduled_at,song_id,title,file_path,duration_s,content_class) VALUES (100,1,?,10,'A Song','X:/song.mp3',180,'MUSIC')").run(now + 60);
  db.prepare("INSERT INTO generated_schedule (id,station_id,scheduled_at,song_id,title,file_path,duration_s,content_class,channel) VALUES (101,1,?,20,'A Sweeper','X:/swp.mp3',2,'SWP','CART')").run(now + 60);
  return db;
}

const titles = (rows) => (rows || []).map(r => r.title).sort();

console.log("── what the queue-fill may put on a rotation deck (real loggen queries, in-memory DB) ──\n");

// 1) THE HAPPY PATH — a clock exists, so the category clause is present.
{
  const db = makeDb({ withClock: true });
  loggen.resetScheduleCursor();
  const q = loggen.fillQueue(db, 1, 20);
  const r = q.items || [];
  check("with a clock: Tier 0 is the generated log", q.source, "generated_schedule");
  check("with a clock: the music row is queued", titles(r), ["A Song"]);
  check("with a clock: the sweeper is NOT queued", r.some(x => x.contentClass === "SWP"), false);
  db.close();
}

// 2) THE CASE THAT MATTERS — no clock, no format categories, so catClause is the empty string. The
//    content_class exclusion must hold entirely on its own. Before 2026-09-07 this case FAILED.
{
  const db = makeDb({ withClock: false });
  loggen.resetScheduleCursor();
  const r = (loggen.fillQueue(db, 1, 20).items) || [];
  check("NO clock (no category clause): the sweeper is STILL not queued",
    r.some(x => x.contentClass === "SWP"), false);
  check("NO clock: the music row still is", titles(r), ["A Song"]);
  db.close();
}

// 3) The hour-fill path takes the same rows and must agree with the query above.
{
  const db = makeDb({ withClock: false });
  const hourStart = Math.floor(Date.now() / 1000);
  const r = loggen.fillFromHour(db, 1, hourStart, 20) || [];
  check("fillFromHour with no clock: no sweeper", r.some(x => (x.contentClass || x.content_class) === "SWP"), false);
  db.close();
}

// 4) THE DRIFT GUARD. The queue-fill and the anchor queries read the same table for the same purpose and
//    must exclude the same classes. They did not, for months, and nothing caught it.
{
  const src = require("fs").readFileSync(path.join(__dirname, "loggen.js"), "utf8");
  const jinOnly = (src.match(/content_class != 'JIN'/g) || []).length;
  const both = (src.match(/content_class NOT IN \('JIN','SWP'\)/g) || []).length;
  check("no query excludes 'JIN' alone any more", jinOnly, 0);
  check("all four deck-eligibility queries exclude both classes", both >= 4, true);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
