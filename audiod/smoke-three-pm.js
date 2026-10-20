"use strict";
// audiod/smoke-three-pm.js — TODAY'S 3 PM, ON THE TEST STATIONS (2026-10-19).
//
// Jeff, 2026-10-19, found on OV with the installed build:
//   1. "At the top of the hour: the song crossing :00 plays out, then the NEW hour's first row. The old hour's remaining
//       rows are marked didn't-play and never air in the new hour. (Today 2 PM leftovers played 3:00–3:15 instead.)"
//   2. "Inside a show the player never waits for a row's time. No top-of-hour gate, no on-time wait. When a row ends,
//       the next row plays. (Today: ~6 min of dead air waiting for 3:15:33.)"
//   3. "Generate sees every row before a slot, including the previous hour's rows, so it never repeats a song the
//       previous hour already has."
//   4. "Regenerate starts from the next song: keep the song on air and everything played, playing, missed or placed by
//       hand; rebuild all pending rows from the end of the song on air onward, including the rest of the current hour.
//       Remove the started-hour skips in generate-core.js."
//   5. "No filler-song fallback or anything else the code decides." — answered: auto-regenerate ONLY inside a scheduled
//       show that runs out of music; no break re-placement; the watchdog resumes the stalled song, never another deck.
//       "There must always be music inside a show: when no song passes the rules, take the least-recently-played song
//       from that slot's category." — "Log reader for everything … retire the old path."
//   "Test each on the test stations with the 3 PM scenario from today."
//
// THE SCENARIO (from OVEVENTS' synced play history of OV's afternoon, read-only): station halloVeen; show "Morning"
// 9:00–15:00 and show "HalloVeen Hour One" 15:00–18:00, BOTH on clock 9 — 33 song rows (≈2 h of music for a 1 h slot)
// plus spot breaks at :00, :20, :40; segue overlap 3 s. At 3:00 the show changes and the 2 PM hour still has most of its
// rows. Built here on a blank database with the app's real schema (structure only, from an installed database opened
// READ-ONLY); every number below is a fixture. Nothing touches a real station.
//
// Run: npm run test:three-pm        [--schema <path-to-an-installed-openair.db>]

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));

let pass = 0, fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "\n        " + detail}`); ok ? pass++ : fail++; };

// ── the clock (all modules read Date) ───────────────────────────────────────────────────────────────────────────
const RealDate = Date;
let NOW = new RealDate(2026, 9, 19, 15, 0, 1).getTime();
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
global.Date = FakeDate;
const at = (h, m, s = 0) => Math.floor(new RealDate(2026, 9, 19, h, m, s).getTime() / 1000);
const setNow = (h, m, s = 0) => { NOW = new RealDate(2026, 9, 19, h, m, s).getTime(); };

// ── the test station, on the real schema ────────────────────────────────────────────────────────────────────────
function schemaSource() {
  const i = process.argv.indexOf("--schema");
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  const prof = path.join(process.env.LOCALAPPDATA || "", "Ether", "profiles");
  try { for (const d of fs.readdirSync(prof)) { if (d.includes(".retired") || d.startsWith("_")) continue; const f = path.join(prof, d, "openair.db"); if (fs.existsSync(f)) return f; } } catch {}
  return null;
}
const SRC = schemaSource();
if (!SRC) { console.log("NO SCHEMA SOURCE — pass --schema <an installed openair.db>"); process.exit(2); }
function blank() {
  const db = new Database(":memory:");
  const src = new Database(SRC, { readonly: true, fileMustExist: true });
  try {
    for (const o of src.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END").all()) { try { db.exec(o.sql); } catch {} }
    for (const r of src.prepare("SELECT version FROM schema_version").all()) db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(r.version);
  } finally { src.close(); }
  return db;
}
const cols = (db, t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
const ins = (db, t, row) => { const c = cols(db, t); const k = Object.keys(row).filter(x => c.has(x)); return Number(db.prepare(`INSERT INTO ${t} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).run(...k.map(x => row[x])).lastInsertRowid); };

const SID = 1, CLOCK = 9;
function buildStation() {
  const db = blank();
  const iso = new RealDate(2026, 9, 1).toISOString();
  try { ins(db, "client_identity", { client_id: "three-pm-fixture", created_at: iso }); } catch {}
  ins(db, "stations", { id: SID, name: "FX halloVeen", uuid: "fx-3pm-station", is_active: 1, created_at: iso, updated_at: iso, scheduler_mode: "clock" });
  ins(db, "station_config_kv", { station_id: SID, key: "segue_overlap_sec", value: "3", uuid: "fx-3pm-overlap", created_at: iso, updated_at: iso });
  const cat = {};
  for (const code of ["kids", "Disney", "HV"]) cat[code] = ins(db, "categories", { station_id: SID, code, name: code, uuid: "fx-cat-" + code, created_at: iso, updated_at: iso });
  ins(db, "clocks", { id: CLOCK, station_id: SID, name: "Clock 9", uuid: "fx-clock-9", created_at: iso, updated_at: iso });
  // clock 9's 33 song rows, in the order the real clock has them
  const order = "kids Disney HV HV Disney HV kids HV kids Disney kids HV HV HV HV Disney HV kids Disney HV kids HV HV HV HV kids Disney Disney HV HV kids kids kids".split(" ");
  order.forEach((code, i) => ins(db, "clock_slots", { clock_id: CLOCK, station_id: SID, slot_type: "music", category_id: cat[code], position: i, uuid: "fx-slot-" + i, created_at: iso, updated_at: iso }));
  const spotCat = ins(db, "spot_categories", { station_id: SID, name: "Sponsors", uuid: "fx-spotcat", created_at: iso, updated_at: iso });
  for (const minute of [0, 20, 40]) ins(db, "clock_breaks", { clock_id: CLOCK, station_id: SID, minute, spot_category_id: spotCat, count: 1, sort_order: 0, uuid: "fx-brk-" + minute, created_at: iso, updated_at: iso });
  ins(db, "spots", { station_id: SID, spot_category_id: spotCat, title: "UNLV Health 15", file_path: "C:/fx/spot.mp3", length_sec: 15, is_active: 1, uuid: "fx-spot", created_at: iso, updated_at: iso });
  ins(db, "shows", { id: 13, station_id: SID, name: "Morning", start_hour: 9, end_hour: 15, start_minute: 0, end_minute: 0, days: "0123456", clock_id: CLOCK, is_active: 1, uuid: "fx-show-morning", created_at: iso, updated_at: iso });
  ins(db, "shows", { id: 8, station_id: SID, name: "HalloVeen Hour One", start_hour: 15, end_hour: 18, start_minute: 0, end_minute: 0, days: "0123456", clock_id: CLOCK, is_active: 1, uuid: "fx-show-hv1", created_at: iso, updated_at: iso });
  // 40 songs per category, ~3.5 min each, distinct artists
  let n = 0;
  for (const code of ["kids", "Disney", "HV"]) for (let k = 0; k < 40; k++) {
    n++;
    const a = ins(db, "artists", { name: `${code} artist ${k}`, uuid: `fx-art-${code}-${k}`, created_at: iso, updated_at: iso });
    ins(db, "songs", { id: n, title: `${code} song ${k}`, artist_id: a, category_id: cat[code], file_path: `C:/fx/${code}-${k}.mp3`, duration_ms: (195 + (k % 7) * 9) * 1000,
      rotation_status: "active", content_class: "MUSIC", daypart_mask: 16777215, uuid: `fx-song-${code}-${k}`, created_at: iso, updated_at: iso });
  }
  return { db, cat, spotCat };
}
const lkOf = (r) => r.log_hour_ts ?? r.scheduled_at;
function logRow(db, r) {
  // Like a real Generate row: a song row carries its song's own file (Generate's timeline matches songs by file).
  const song = r.song_id != null ? db.prepare("SELECT file_path FROM songs WHERE id = ?").get(r.song_id) : null;
  const fp = r.file_path || (song && song.file_path) || "C:/fx/x.mp3";
  return ins(db, "generated_schedule", { station_id: SID, song_id: r.song_id ?? null, title: r.title || "row", artist: "", file_path: fp, file_key: path.basename(fp),
    duration_s: r.duration_s ?? 210, scheduled_at: r.scheduled_at, log_hour_ts: r.log_hour_ts ?? null, state: r.state || "pending", played_at: r.played_at ?? null,
    content_class: r.content_class || "MUSIC", source: r.source ?? "auto", category_id: r.category_id ?? null, clock_id: CLOCK, uuid: "fx-row-" + Math.random().toString(36).slice(2), created_at: "x", updated_at: "x" });
}

const loggen = require(path.join(ROOT, "audiod", "loggen.js"));
// The product's own main.js functions, lifted against the fixture database (the scheduler gate's pattern).
const { createRequire } = require("module");
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
function liftFromMain(name, deps) {
  const start = MAIN_SRC.indexOf(`\nfunction ${name}(`) >= 0 ? MAIN_SRC.indexOf(`\nfunction ${name}(`) : MAIN_SRC.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`main.js has no function ${name}`);
  const m = /\r?\n\}\r?\n/.exec(MAIN_SRC.slice(start + 1));
  const src = MAIN_SRC.slice(start + 1, start + 1 + m.index + m[0].length);
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${src}\nreturn ${name};`)(...names.map(n => deps[n]));
}
const core = require(path.join(ROOT, "audiod", "scheduler-core.js"));
const gc = require(path.join(ROOT, "electron", "generate-core.js"));

// The 2 PM hour as OV had it at 3:00: 9 rows aired, the crossing song on air (started 14:59:43, 201 s), and 23 of
// clock 9's rows still pending — timed past 15:00 because every clock row is placed. The 3 PM hour: its :00 break first.
function threePm(db) {
  const r = { leftovers: [], hand: null, crossing: null, head: null, three: [] };
  for (let i = 0; i < 9; i++) logRow(db, { song_id: 81 + i, title: "2PM aired " + i, scheduled_at: at(14, 0) + i * 200, log_hour_ts: at(14, 0), state: "played", played_at: at(14, 0) + i * 200 });
  r.crossing = logRow(db, { song_id: 90, title: "Monster Mash (crossing)", scheduled_at: at(14, 59, 43), log_hour_ts: at(14, 0), state: "playing", played_at: at(14, 59, 43), duration_s: 201 });
  for (let i = 0; i < 23; i++) r.leftovers.push(logRow(db, { song_id: 1 + i, title: "2PM leftover " + i, scheduled_at: at(15, 3, 1) + i * 210, log_hour_ts: at(14, 0) }));
  // Added by hand while the crossing song played: Up Next writes it right after the song on air, in that song's hour.
  r.hand = logRow(db, { song_id: 60, title: "Hand-added at 2 PM", scheduled_at: at(14, 59, 50), log_hour_ts: at(14, 0), source: "operator" });
  r.head = logRow(db, { title: "3PM :00 break — UNLV Health", scheduled_at: at(15, 0), log_hour_ts: at(15, 0), content_class: "SPOT", song_id: null, duration_s: 15 });
  for (let i = 0; i < 8; i++) r.three.push(logRow(db, { song_id: 41 + i, title: "3PM row " + i, scheduled_at: at(15, 0, 15) + i * 210, log_hour_ts: at(15, 0) }));
  return r;
}

(async () => {
  console.log(`three-pm smoke — schema from ${SRC} (read-only, structure only)`);

  // ════ RULE 1 — the reader: the crossing song plays out, then the NEW hour's first row; leftovers didn't-play ═══
  {
    const { db } = buildStation();
    const r = threePm(db);
    setNow(15, 3, 1);   // the crossing song has just ended
    const read = loggen.readLogAnchored(db, SID, 20, undefined, { onAirRowId: r.crossing, seamTs: at(15, 3, 4) });
    check("1a · after the crossing song: the hand-added 2 PM row plays (Jeff: hand rows play after the crossing song)", read.items[0] && read.items[0].schedId === r.hand,
      JSON.stringify(read.items.slice(0, 3).map(i => i.title)));
    check("1b · …then the NEW hour's first row (the 3 PM :00 break)", read.items[1] && read.items[1].schedId === r.head, JSON.stringify(read.items.slice(0, 3).map(i => i.title)));
    check("1c · no 2 PM leftover is offered in the new hour", !read.items.some(i => r.leftovers.includes(i.schedId)));
    check("1d · every 2 PM leftover is marked didn't-play", r.leftovers.every(id => read.missedRowIds.includes(id)), `${read.missedRowIds.length} of ${r.leftovers.length}`);
  }

  // ════ RULE 1 — the engine: a 2 PM leftover already CUED on a standby deck before 3:00 never airs ══════════════
  {
    const { db } = buildStation();
    const r = threePm(db);
    const { DaemonEngine } = require(path.join(ROOT, "audiod", "engine.js"));
    const e = new DaemonEngine(SID, db, () => {});
    const logs = [];
    e._log = (m) => logs.push(m);
    e._stop = () => {}; e._play = () => true; e.preload = () => Promise.resolve(); e._maybeEmitDeck = () => {};
    e._advance = (w, fn) => { const p = Promise.resolve().then(fn); return p; };
    // A on air with the crossing song; B cued with a 2 PM leftover (cued at 14:59:50, before :00); C cued by hand.
    e.stateA = { status: "playing", title: "Monster Mash (crossing)", filePath: "C:/fx/x.mp3", positionSec: 10, durationSec: 201 };
    e.stateB = { status: "idle", title: "2PM leftover 0", filePath: "C:/fx/x.mp3", positionSec: 0, durationSec: 210 };
    e.stateC = { status: "idle", title: "Hand-added at 2 PM", filePath: "C:/fx/x.mp3", positionSec: 0, durationSec: 210 };
    e.deckSchedId = { A: r.crossing, B: r.leftovers[0], C: r.hand };
    e.queue = [{ qid: 1, schedId: r.leftovers[0], logHourTs: at(14, 0), title: "2PM leftover 0" }, { qid: 2, schedId: r.hand, logHourTs: at(14, 0), title: "Hand-added at 2 PM", handAdded: true }];
    e.deckQid = { B: 1, C: 2 };
    setNow(14, 59, 55);
    check("1e · before 3:00 nothing is let go (a row cued before :00 may still be the crossing song)", e._releaseEndedHourRows(at(14, 59, 55)).length === 0);
    setNow(15, 0, 1);
    const ended = e._releaseEndedHourRows(at(15, 0, 1));
    await new Promise(r2 => setTimeout(r2, 20));
    check("1f · at 3:00:01 the standby deck holding the 2 PM leftover lets go of it", ended.length === 1 && ended[0].d === "B" && e.deckSchedId.B == null, JSON.stringify(ended));
    check("1g · …and that row is marked didn't-play", db.prepare("SELECT state FROM generated_schedule WHERE id = ?").get(r.leftovers[0]).state === "missed");
    check("1h · the hand-added row's deck keeps it (it plays after the crossing song)", e.deckSchedId.C === r.hand);
    check("1i · the deck playing the crossing song is never touched", e.deckSchedId.A === r.crossing && e.stateA.status === "playing");
    // The seam is the latest-ending playing deck (a segue overlap: the outgoing has 2 s, the incoming 200 s).
    e.stateA = { status: "playing", positionSec: 199, durationSec: 201 };
    e.stateB = { status: "playing", positionSec: 1, durationSec: 201 };
    check("1j · the seam is the song really on air (the latest-ending deck), not the outgoing one", e._projectedSeamTs() - Math.floor(NOW / 1000) === 200, String(e._projectedSeamTs() - Math.floor(NOW / 1000)));
  }

  // ════ RULE 2 — inside a show the player never waits for a row's time ══════════════════════════════════════
  {
    const { db } = buildStation();
    // The 3 PM hour on air: its rows from 3:15:33 on are pending; the row it was on is gone (a regenerate replaced it),
    // so the engine has nothing of the log on air — the case that waited ~6 min for 3:15:33 today.
    logRow(db, { song_id: 41, title: "3PM aired", scheduled_at: at(15, 0, 15), log_hour_ts: at(15, 0), state: "played", played_at: at(15, 2) });
    const next = logRow(db, { song_id: 42, title: "3PM row at 3:15:33", scheduled_at: at(15, 15, 33), log_hour_ts: at(15, 0) });
    setNow(15, 9, 32);
    const read = loggen.readLogAnchored(db, SID, 20, undefined, { onAirRowId: null, seamTs: at(15, 9, 32) });
    check("2a · nothing on air at 3:09:32: the next row (3:15:33) plays NOW — no wait for its time", read.items[0] && read.items[0].schedId === next && read.nextDueTs == null,
      JSON.stringify({ items: read.items.map(i => i.title), mode: read.mode, nextDueTs: read.nextDueTs }));
    // The on-air path at 3:00, from Morning into HalloVeen Hour One (a different show starting at the same minute).
    const db2 = buildStation().db;
    const cr = logRow(db2, { song_id: 90, title: "crossing", scheduled_at: at(14, 59, 43), log_hour_ts: at(14, 0), state: "playing", played_at: at(14, 59, 43), duration_s: 201 });
    const h3 = logRow(db2, { song_id: 41, title: "3PM first song", scheduled_at: at(15, 0), log_hour_ts: at(15, 0) });
    setNow(15, 3, 1);
    const r2 = loggen.readLogAnchored(db2, SID, 20, undefined, { onAirRowId: cr, seamTs: at(15, 3, 4) });
    check("2b · at the 3:00 show change the new show's first row follows the crossing song at once (no gate)", r2.items[0] && r2.items[0].schedId === h3, JSON.stringify(r2.items.map(i => i.title)));
  }

  // ════ RULE 3 — Generate sees every row before a slot, including the previous hour's ══════════════════════════
  {
    const { db } = buildStation();
    const r = threePm(db);
    // A didn't-play row of the 2 PM hour, too.
    db.prepare("UPDATE generated_schedule SET state = 'missed' WHERE id = ?").run(r.leftovers[22]);
    // A 2 PM row timed before 3:00 that has not aired yet (still pending) — it can still air.
    logRow(db, { song_id: 70, title: "2PM pending before 3:00", scheduled_at: at(14, 58, 30), log_hour_ts: at(14, 0) });
    setNow(15, 3, 1);
    const tl = core.loadTimeline(db, SID, { beforeTs: Math.floor(NOW / 1000), replace: [at(15, 0), at(16, 0)] });
    const rules = { songMin: 120, artistMin: 0, titleMin: 0 };
    const song = (id) => { const s = db.prepare("SELECT s.file_path f, s.title, a.name artist, s.duration_ms FROM songs s JOIN artists a ON a.id = s.artist_id WHERE s.id = ?").get(id); return { file: s.f, title: s.title, artist: s.artist, durationMs: s.duration_ms }; };
    // Only rows that air count (2026-10-19, the rotation fix): an extra 2 PM row timed past 3:00 never airs (rule 1), so it
    // does not burn its song — counting it took the gate's rotation from 131 to 236.
    check("3a · a 2 PM row timed past 3:00 (it never airs) does not burn its song", !core.breach(tl, song(1), at(15, 5), rules));
    check("3b · a 2 PM pending row timed before 3:00 (it can still air) blocks its song", !!core.breach(tl, song(70), at(15, 5), rules));
    check("3c · a 2 PM row marked didn't-play (never aired) does not count", !core.breach(tl, song(23), at(15, 5), rules));
    check("3d · the hand-added 2 PM row blocks its song", !!core.breach(tl, song(60), at(15, 5), rules));
    check("3e · a song nowhere near the log does not", !core.breach(tl, song(100), at(15, 5), rules));
  }

  // ════ RULE 4 — Regenerate starts from the next song ════════════════════════════════════════════════════════
  {
    const { db } = buildStation();
    // The 3 PM hour on air: its :00 break and 4 songs aired, the 5th on air (started 3:12:30, 210 s → ends 3:16:00).
    logRow(db, { title: "3PM :00 break", scheduled_at: at(15, 0), log_hour_ts: at(15, 0), content_class: "SPOT", song_id: null, duration_s: 15, state: "played", played_at: at(15, 0) });
    for (let i = 0; i < 4; i++) logRow(db, { song_id: 41 + i, title: "3PM aired " + i, scheduled_at: at(15, 0, 15) + i * 210, log_hour_ts: at(15, 0), state: "played", played_at: at(15, 0, 15) + i * 190 });
    logRow(db, { song_id: 45, title: "3PM on air", scheduled_at: at(15, 14), log_hour_ts: at(15, 0), state: "playing", played_at: at(15, 12, 30), duration_s: 210 });
    setNow(15, 13, 0);
    const ctx = gc.buildScheduleCtx(db, SID);
    ctx.regen = { fromTs: at(15, 16, 0), pieceLk: at(15, 0), consumed: 5 };   // what main.js _regenPoint returns here
    ctx.planWindow(at(15, 0), at(16, 0));
    gc.resetGenSlice();
    await gc.generateDayRows(new RealDate(2026, 9, 19), ctx, at(15, 0), 15);
    const rows = ctx.generatedRows.filter(x => (x.log_hour_ts ?? x.scheduled_at) === at(15, 0));
    const music = rows.filter(x => (x.content_class || "MUSIC") === "MUSIC");
    check("4a · the rest of the hour on air is rebuilt (the started-hour skips are gone)", rows.length > 0, `${rows.length} rows`);
    // The station's segue overlap is 3 s: the next song starts 3 s before the song on air ends (Jeff, 2026-10-18: "All
    // timing uses each song's real segue/overlay point").
    check("4b · it starts at the end of the song on air (3:16:00, less the 3 s segue overlap), nothing before", rows.length > 0 && Math.min(...rows.map(x => x.scheduled_at)) >= at(15, 16, 0) - 3,
      rows.length ? new RealDate(Math.min(...rows.map(x => x.scheduled_at)) * 1000).toTimeString().slice(0, 8) : "none");
    check("4c · the clock continues after the 5 positions that already happened: 33 − 5 = 28 songs", music.length === 28, `${music.length} songs`);
    check("4d · the :00 break (already aired) is not placed again; the :20 and :40 breaks are", rows.filter(x => x.content_class === "SPOT").length === 2, `${rows.filter(x => x.content_class === "SPOT").length} spots`);
  }

  // ════ RULE 5 — nothing the code decides ═════════════════════════════════════════════════════════════════════
  {
    // 5a: a break whose minute the clock never reaches is reported, never moved after the last row.
    const { db, spotCat } = buildStation();
    db.prepare("DELETE FROM clock_slots WHERE position >= 3").run();             // a 3-row clock: ~11 min of music
    setNow(12, 0, 0);
    const ctx = gc.buildScheduleCtx(db, SID);
    ctx.planWindow(at(13, 0), at(14, 0));
    gc.resetGenSlice();
    await gc.generateDayRows(new RealDate(2026, 9, 19), ctx, at(13, 0), 13);
    const spots = ctx.generatedRows.filter(x => x.content_class === "SPOT");
    check("5a · the :20 and :40 breaks the clock never reaches are not re-placed after its last row", spots.length === 1, `${spots.length} spot rows`);
    check("5b · …they are reported (unreached)", ctx.breakDrift.filter(b => b.direction === "unreached").length === 2, JSON.stringify(ctx.breakDrift));
    void spotCat;
    // 5c: always music inside a show — no song passes the rules → that slot's category's least-recently-played.
    const db3 = buildStation().db;
    ins(db3, "separation_rules", { station_id: SID, rule_type: "song_separation_min", scope: "global", value: 100000, is_hard: 1, is_active: 1, uuid: "fx-sep-song", created_at: "x", updated_at: "x" });
    for (let s = 1; s <= 120; s++) logRow(db3, { song_id: s, title: "played " + s, scheduled_at: at(10, 0) + s * 60, log_hour_ts: at(10, 0), state: "played", played_at: at(10, 0) + s * 60 });
    try { db3.prepare("INSERT INTO play_log (title, station_id, played_at, file_path, content_class, deleted_at) SELECT title, ?, ?, file_path, 'MUSIC', NULL FROM songs").run(SID, at(10, 30)); } catch {}
    setNow(12, 0, 0);
    const ctx3 = gc.buildScheduleCtx(db3, SID);
    ctx3.planWindow(at(13, 0), at(14, 0));
    gc.resetGenSlice();
    await gc.generateDayRows(new RealDate(2026, 9, 19), ctx3, at(13, 0), 13);
    const m3 = ctx3.generatedRows.filter(x => (x.content_class || "MUSIC") === "MUSIC");
    check("5c · always music inside a show: every slot has a song (least recently played when none passes), none UNSCHEDULED",
      m3.length === 33 && !ctx3.generatedRows.some(x => x.content_class === "UNSCHEDULED"), `${m3.length} songs, ${ctx3.generatedRows.filter(x => x.content_class === "UNSCHEDULED").length} unscheduled`);
    // 5d–5f: the static facts in the shipped code.
    const eng = fs.readFileSync(path.join(ROOT, "audiod", "engine.js"), "utf8");
    const main = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
    check("5d · one way to play the log: the log reader, no per-machine switch", /_logReaderOn\(\) \{ return true; \}/.test(eng) && /return this\._refillFromLog\(\);/.test(eng));
    check("5e · the watchdog resumes the stalled song, never another deck", /_recoverStall\(\) \{\s*this\._advance\("watchdog-recover", \(\) => this\._resumeStalled\(\)\);/.test(eng));
    check("5f · no generating on a timer: only a show that ran out of music generates", !/_scheduleIsSparse\(st\.id, nowTs\)\)/.test(main) && /reason === "waiting:log-ended-inside-show"\) _outOfMusicRegenerate/.test(main) && /no show is on — nothing generates/.test(main));
  }

  // ════ RULE 5 — the watchdog resumes the stalled song AT THE EXACT SPOT, on its own deck ═════════════════════
  // Jeff, 2026-10-19: "after a stall, resume the stalled song at the exact spot it stalled. Never play a different deck."
  {
    const { db } = buildStation();
    const { DaemonEngine } = require(path.join(ROOT, "audiod", "engine.js"));
    const e = new DaemonEngine(SID, db, () => {});
    e._log = () => {}; e._stop = () => {}; e.preload = () => Promise.resolve(); e._maybeEmitDeck = () => {};
    const loads = [], plays = [];
    const prevHook = DaemonEngine.loadHook;
    DaemonEngine.loadHook = (deck, fp, title, artist, sid, startSec) => { loads.push({ deck, fp, startSec }); return true; };
    e._play = (d) => { plays.push(d); return true; };
    // B on air at 123.4 s of a 210 s song; B's source then vanishes (Rust emptied it); C holds a cued row.
    e.stateB = { status: "playing", title: "Monster Mash", artist: "Bobby Pickett", filePath: "C:/fx/mash.mp3", positionSec: 123.4, durationSec: 210 };
    e.stateC = { status: "idle", title: "next row", filePath: "C:/fx/next.mp3", positionSec: 0, durationSec: 200 };
    e._started = true;
    e._watchdog();                                   // healthy tick: records what is on air and where
    e.stateB = { status: "idle", title: "Monster Mash", filePath: "", positionSec: 0, durationSec: 210 };
    const ok = await e._resumeStalled();
    check("5g · source gone mid-song: the same song is reloaded on its own deck (B) at the exact spot (123.4 s)",
      ok === true && loads.length === 1 && loads[0].deck === "B" && loads[0].fp === "C:/fx/mash.mp3" && loads[0].startSec === 123.4, JSON.stringify({ ok, loads }));
    check("5h · …and only that deck plays — never a different deck", plays.length === 1 && plays[0] === "B", JSON.stringify(plays));
    check("5i · the deck shows the song at that position", e.stateB.status === "playing" && e.stateB.positionSec === 123.4 && e.stateB.filePath === "C:/fx/mash.mp3", JSON.stringify(e.stateB));
    // An engine that cannot load from a point: refused loudly, nothing else played.
    loads.length = 0; plays.length = 0;
    DaemonEngine.loadHook = () => false;
    e.stateB = { status: "playing", title: "Monster Mash", filePath: "C:/fx/mash.mp3", positionSec: 50, durationSec: 210 };
    e._watchdog();
    e.stateB = { status: "idle", title: "Monster Mash", filePath: "", positionSec: 0, durationSec: 210 };
    const errs = []; e.emit = (ev, p) => { if (ev === "error") errs.push(p); };
    const ok2 = await e._resumeStalled();
    check("5j · if the song cannot be reloaded, nothing else plays and it says so", ok2 === false && plays.length === 0 && errs.some(x => x.kind === "stalled-unresumable"), JSON.stringify({ ok2, plays, errs: errs.map(x => x.kind) }));
    DaemonEngine.loadHook = prevHook;
  }

  // ════ RULE 6 — no switch: the log is built before a show starts ════════════════════════════════════════════
  // Jeff, 2026-10-19: "Remove the 'Generate when a show runs out' switch. No switches. Inside a show there is always
  // music; the log is built before a show starts, never silence while it generates."
  {
    const { db } = buildStation();
    try { db.prepare("INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES ('hlc_last', '0:0:three-pm-fixture', 'x')").run(); } catch {}
    const mainRequire = createRequire(path.join(ROOT, "electron", "main.js"));
    const base = { db, require: mainRequire, console: { log() {}, error: console.error, warn() {} }, _scheduleChanged: () => {}, _healthEvent: () => {} };
    const _genStartTs = (ts) => { const d = new Date(ts * 1000); d.setMinutes(0, 0, 0); return Math.floor(d.getTime() / 1000); };
    const _regenPoint = liftFromMain("_regenPoint", { ...base, _genStartTs });
    const _generateDayChunked = liftFromMain("_generateDayChunked", { ...base, _genCancel: false, _genEmit: () => {}, generateDayRows: gc.generateDayRows, resetGenSlice: gc.resetGenSlice });
    const _commitDayRows = liftFromMain("_commitDayRows", base);
    const _generateRange = liftFromMain("_generateRange", { ...base, buildScheduleCtx: gc.buildScheduleCtx, _regenPoint, _generateDayChunked, _placeJingles: () => {}, _commitDayRows,
      retireStaleScheduleRows: () => {}, finishGenerateRun: () => {} });
    const _missingShowSpans = liftFromMain("_missingShowSpans", base);
    const shows = () => db.prepare("SELECT * FROM shows WHERE station_id = ? AND is_active = 1 AND deleted_at IS NULL").all(SID);
    const rowsIn = (a, b) => db.prepare("SELECT id, state, deleted_at FROM generated_schedule WHERE station_id = ? AND deleted_at IS NULL AND COALESCE(log_hour_ts, scheduled_at) >= ? AND COALESCE(log_hour_ts, scheduled_at) < ?").all(SID, a, b);
    // 2 PM: Morning (9–15) has its log; HalloVeen Hour One (15–18) has none.
    for (let h = 9; h < 15; h++) logRow(db, { song_id: 1 + h, title: `Morning ${h}:00`, scheduled_at: at(h, 0), log_hour_ts: at(h, 0), state: h < 14 ? "played" : "pending", played_at: h < 14 ? at(h, 0) : null });
    const twoPmRow = db.prepare("SELECT id FROM generated_schedule WHERE log_hour_ts = ?").get(at(14, 0)).id;
    setNow(14, 0, 30);
    const spans = _missingShowSpans(SID, shows(), Math.floor(NOW / 1000));
    check("6a · at 2 PM the next show (HalloVeen Hour One, 3–6 PM) has no log: it is found to be built", spans.length === 1 && spans[0].fromLk === at(15, 0) && spans[0].toTs === at(18, 0),
      JSON.stringify(spans.map(x => [new RealDate(x.fromLk * 1000).toTimeString().slice(0, 5), new RealDate(x.toTs * 1000).toTimeString().slice(0, 5)])));
    const r = await _generateRange(SID, spans[0].fromLk, spans[0].toTs, { source: "auto", window: spans[0] });
    check("6b · it is built before it starts: every hour 3–6 PM has its clock's rows (33 songs each)",
      [15, 16, 17].every(h => rowsIn(at(h, 0), at(h + 1, 0)).length >= 33), [15, 16, 17].map(h => rowsIn(at(h, 0), at(h + 1, 0)).length).join("/") + ` (${r && r.count} built)`);
    check("6c · nothing else is touched: the 2 PM hour's pending row is still there, no row after 6 PM",
      !!db.prepare("SELECT 1 FROM generated_schedule WHERE id = ? AND deleted_at IS NULL").get(twoPmRow) && rowsIn(at(18, 0), at(23, 59)).length === 0);
    check("6d · built once: the next pass finds nothing to build", _missingShowSpans(SID, shows(), Math.floor(NOW / 1000)).length === 0);
    db.prepare("UPDATE generated_schedule SET deleted_at = 'cleared' WHERE station_id = ? AND COALESCE(log_hour_ts, scheduled_at) = ?").run(SID, at(16, 0));
    const sp2 = _missingShowSpans(SID, shows(), Math.floor(NOW / 1000));
    check("6e · an hour of the show cleared before it airs is found and built again — only that hour", sp2.length === 1 && sp2[0].fromLk === at(16, 0) && sp2[0].toTs === at(17, 0), JSON.stringify(sp2));
    const before17 = rowsIn(at(17, 0), at(18, 0)).map(x => x.id).join(",");
    await _generateRange(SID, sp2[0].fromLk, sp2[0].toTs, { source: "auto", window: sp2[0] });
    check("6f · …and the hours around it keep their rows exactly", rowsIn(at(16, 0), at(17, 0)).length >= 33 && rowsIn(at(17, 0), at(18, 0)).map(x => x.id).join(",") === before17);
    // Between shows nothing is built: at 7 PM with no show until tomorrow 9 AM, only tomorrow's Morning is the next show.
    setNow(19, 0, 0);
    const sp3 = _missingShowSpans(SID, shows(), Math.floor(NOW / 1000));
    check("6g · after the last show the next one is tomorrow's Morning — nothing between shows is built",
      sp3.length === 1 && sp3[0].fromLk === at(9, 0) + 86400 && sp3[0].toTs === at(15, 0) + 86400, JSON.stringify(sp3.map(x => new RealDate(x.fromLk * 1000).toString().slice(0, 21))));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("SMOKE CRASH", e && e.stack || e); process.exit(1); });
