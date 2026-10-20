// scripts/test-scheduler-gate.js — the scheduler / rotation / playout release gate (Phase 0).
//
// Design: docs/scheduler-rotation-playout-design.md §4 (tests), §5 Phase 0 ("the gate harness, the
// independent checker and the ratchet, run against TODAY'S code ... the harness reports today's failures
// with receipts: the tests catch what is wrong").
//
// WHAT RUNS IS THE PRODUCT'S OWN CODE, NOT A COPY OF IT:
//   - Generate:  electron/generate-core.js  (buildScheduleCtx + generateDayRows, hour by hour, as
//                _generateDayChunked does), then main.js's own _commitDayRows and retireStaleScheduleRows,
//                lifted out of electron/main.js at run time by name and run as-is.
//   - The reader: audiod/loggen.js readLogAnchored / fillQueue (the flipped stations' playout source).
//   - The record: audiod/playlog.js logPlay, and the engine's playhead stamp (engine.js:1876-1884) and
//                missed stamp (engine.js:1445), which are two SQL statements and are reproduced verbatim.
// What is MODELLED, and said so in the report: the deck/queue machinery. One row goes live per seam, the
// row the reader names first (the engine plays the log in order, engine.js:1503). Song length on air is
// the planned length ±10% (seeded). Audio files are not opened. Sweepers (_placeJingles) are not placed.
//
// SAFETY. Never the live file. Each database is copied with VACUUM INTO from a READ-ONLY handle, the
// copies live in the OS temp folder, and they are deleted at the end (--keep-copies keeps them).
//
// Usage:
//   node scripts/test-scheduler-gate.js [--db <openair.db>]... [--days 7] [--seed 1] [--stations 2,4]
//                                       [--update-ratchet] [--keep-copies] [--reader-limit-ms 10]
//   With no --db, every profile database under %LOCALAPPDATA%\Ether\profiles is used.
//   ONE STATION AT A TIME (Jeff, 2026-10-18): each station runs in its own process, with its own two copies,
//   and writes its results table, its JSON and its ratchet entry to disk the moment it finishes, then
//   deletes its copies. A run that is stopped never loses a station that finished.
// Exit code 0 only when every test passes and nothing is worse than the ratchet.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const C = require("./lib/log-checker");
const SEGUE = require(path.join(__dirname, "..", "audiod", "segue-overlap.js"));   // the station's segue overlap, as the engine reads it

// ── arguments ─────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes(name);
const DAYS = Number(opt("--days", 7));
const SEED = Number(opt("--seed", 1));
const ONLY_STATIONS = opt("--stations", null) ? opt("--stations").split(",").map(Number) : null;
const LENGTH_ERR = 0.10;            // design T1/T8: "real song-length error (true vs planned, ±10%)"
const EARLY_START_WINDOW_S = 0;     // design §3.7 starting value
const BREAK_TOL_S = 30;             // design §3.7 starting value (3c)
const REGEN_AT = { day: 0, hour: 18, minute: 10 };   // "a regenerate on air" — Jeff's 6:10 PM on 10/17
const RATCHET_FILE = path.join(__dirname, "fixtures", "scheduler-gate-ratchet.json");
// T19 (Jeff, 2026-10-18): the reader's call time, against a limit that is a setting. Proposed starting value.
const READER_LIMIT_MS = Number(opt("--reader-limit-ms", 10));
const CHILD = flag("--child");
const RUN_DIR = opt("--run-dir", null);

const dbPaths = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--db") dbPaths.push(argv[i + 1]);
// THE GATE TESTS ITS OWN STATIONS (Jeff, 2026-10-18). With no --db, the fixture database is built (scripts/lib/
// gate-fixture.js) and only its stations are tested; an installed database lends its SCHEMA, never its rows.
const FIXTURE = !dbPaths.length || flag("--fixture");
const SCHEMA_SOURCES = [];
if (!dbPaths.length) {
  const prof = path.join(process.env.LOCALAPPDATA || "", "Ether", "profiles");
  try {
    for (const d of fs.readdirSync(prof)) {
      if (d.includes(".retired") || d.startsWith("_")) continue;
      const f = path.join(prof, d, "openair.db");
      if (fs.existsSync(f)) SCHEMA_SOURCES.push(f);
    }
  } catch { /* none */ }
}

// ── a fake clock the product's code reads through Date / Date.now ─────────────────────────────────
const RealDate = Date;
let fakeNowMs = null;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0 && fakeNowMs != null) super(fakeNowMs); else super(...a); }
  static now() { return fakeNowMs != null ? fakeNowMs : RealDate.now(); }
}
const setNow = (sec) => { fakeNowMs = sec * 1000; };
let ANCHOR = null;   // the simulated week's start (see above); set per copy in runChild
function seedSqlRandom(rawDb, seed) {
  let a = seed >>> 0;
  rawDb.function("random", { deterministic: false }, () => {
    a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) - 2147483648;
  });
}
const nowSec = () => Math.floor(FakeDate.now() / 1000);
global.Date = FakeDate;

// IDENTICAL CODE GIVES IDENTICAL NUMBERS (Jeff, 2026-10-18: "Give Generate a fixed random seed inside the harness so
// identical code gives identical numbers; the ratchet stays exact"). Three things made two runs differ, and all three are
// fixed here, inside the harness only — the product is unchanged:
//   1. SQLite's random(), behind every ORDER BY RANDOM() in Generate and the reader's floor: each copy's connection
//      gets an application-defined random() of the same name (it takes precedence over the built-in), seeded per
//      station and per copy.
//   2. JavaScript's Math.random(): seeded the same way.
//   3. The wall clock: the simulated week starts at the first local midnight after the newest play in the database
//      (ANCHOR), not at "the next top of the hour", so the same database gives the same week whenever the gate runs.
// Song-length error on air is drawn from its own seeded stream (rng below).
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── node:sqlite with better-sqlite3's db.transaction(), which main.js's code calls ───────────────
function wrapDb(raw) {
  let depth = 0, sp = 0;
  return {
    raw,
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
    transaction(fn) {
      return (...a) => {
        const name = depth === 0 ? null : `gate_sp_${++sp}`;
        raw.exec(name ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
        depth++;
        try { const r = fn(...a); depth--; raw.exec(name ? `RELEASE ${name}` : "COMMIT"); return r; }
        catch (e) { depth--; try { raw.exec(name ? `ROLLBACK TO ${name}` : "ROLLBACK"); } catch {} throw e; }
      };
    },
  };
}

// ── lift a top-level function out of electron/main.js by name and run it as-is ───────────────────
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
function liftFromMain(name, deps) {
  const start = MAIN_SRC.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`main.js has no function ${name}`);
  const m = /\r?\n\}\r?\n/.exec(MAIN_SRC.slice(start + 1));
  if (!m) throw new Error(`main.js: cannot find the end of ${name}`);
  const src = MAIN_SRC.slice(start + 1, start + 1 + m.index + m[0].length);
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${src}\nreturn ${name};`)(...names.map(n => deps[n]));
}
function lineOf(src, needle) { const i = src.indexOf(needle); return i < 0 ? null : src.slice(0, i).split("\n").length; }

// ── copies ────────────────────────────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ether-scheduler-gate-"));
function copyDb(src, tag) {
  const out = path.join(TMP, `${tag}.db`);
  const ro = new DatabaseSync(src, { readOnly: true });
  try { ro.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`); } finally { ro.close(); }
  return out;
}

// ── station facts (read once per copy) ────────────────────────────────────────────────────────────
function stationFacts(db, sid) {
  const rules = { songMin: null, artistMin: null, titleMin: null };
  const ruleRows = db.prepare("SELECT rule_type, value, is_active, is_hard FROM separation_rules WHERE station_id=? AND deleted_at IS NULL").all(sid);
  for (const r of ruleRows) {
    if (!r.is_active) continue;
    if (r.rule_type === "song_separation_min") rules.songMin = r.value;
    if (r.rule_type === "artist_separation_min") rules.artistMin = r.value;
    if (r.rule_type === "title_separation_min") rules.titleMin = r.value;
  }
  const songs = db.prepare(
    `SELECT s.id, s.title, a.name AS artist, s.category_id, s.file_path, s.file_key, s.daypart_mask, s.rotation_status,
            s.content_class, s.deleted_at, s.no_repeat_hours, s.created_at, s.duration_ms
       FROM songs s LEFT JOIN artists a ON a.id = s.artist_id`).all();
  const clockCats = new Set(db.prepare(
    `SELECT DISTINCT cs.category_id FROM clock_slots cs JOIN clocks c ON c.id = cs.clock_id
      WHERE cs.station_id=? AND cs.slot_type='music' AND cs.category_id IS NOT NULL AND cs.deleted_at IS NULL AND c.deleted_at IS NULL`).all(sid).map(r => r.category_id));
  const catName = new Map(db.prepare("SELECT id, code, name FROM categories WHERE station_id=?").all(sid).map(c => [c.id, c.code || c.name || ("#" + c.id)]));
  const shows = db.prepare("SELECT count(*) n FROM shows WHERE station_id=? AND is_active=1 AND deleted_at IS NULL AND clock_id IS NOT NULL").get(sid).n;
  const split = C.artistSplitter();
  const byId = new Map(), byRec = new Map();
  for (const s of songs) {
    byId.set(s.id, s);
    const rec = C.recordingKey(s.file_path || s.file_key);
    if (rec && !s.deleted_at && !byRec.has(rec)) byRec.set(rec, s);
  }
  // the slot category's pool at an hour: in rotation, MUSIC, not deleted, daypart allows the hour (D3)
  const inPool = (s, cat, hour) => !s.deleted_at && s.category_id === cat && s.rotation_status !== "inactive"
    && (s.content_class == null || s.content_class === "MUSIC") && (s.daypart_mask == null || ((s.daypart_mask >> hour) & 1) === 1);
  const poolCache = new Map();
  const pool = (cat, hour) => {
    const k = cat + "|" + hour;
    if (!poolCache.has(k)) poolCache.set(k, songs.filter(s => inPool(s, cat, hour)).map(s => ({
      songId: s.id, rec: C.recordingKey(s.file_path || s.file_key), artists: split(s.artist), title: C.titleKey(s.title, s.duration_ms), name: s.title,
      noRepeatMin: s.no_repeat_hours != null && Number(s.no_repeat_hours) > 0 ? Number(s.no_repeat_hours) * 60 : null,
    })).filter(p => p.rec));
    return poolCache.get(k);
  };
  return { sid, rules, ruleRows, songs, byId, byRec, clockCats, catName, shows, split, pool };
}

// an event for an aired play (play_log row) or a log row
function playEvent(F, p) {
  const rec = C.recordingKey(p.file_path);
  const s = rec ? F.byRec.get(rec) : null;
  return C.makeEvent({ ts: p.played_at, file: p.file_path, artist: s ? s.artist : p.artist, title: s ? s.title : p.title, kind: "aired", ref: "p" + p.id, songId: s ? s.id : null, noRepeatHours: s ? s.no_repeat_hours : null, durationMs: s ? s.duration_ms : null }, F.split);
}
function rowEvent(F, r) {
  const s = r.song_id != null ? F.byId.get(r.song_id) : null;
  return C.makeEvent({ ts: r.scheduled_at, file: r.file_key || r.file_path || (s && (s.file_path || s.file_key)), artist: s ? s.artist : r.artist, title: s ? s.title : r.title, kind: "log", ref: "r" + r.id, categoryId: r.category_id, songId: r.song_id, noRepeatHours: s ? s.no_repeat_hours : null, durationMs: s ? s.duration_ms : (r.duration_s ? r.duration_s * 1000 : null) }, F.split);
}
const isMusicRow = (r) => r.song_id != null && (r.content_class == null || r.content_class === "MUSIC");
const isMusicPlay = (p) => p.content_class == null || p.content_class === "MUSIC";
// Generate placed it because no song passed the rules: the least recently played song (Jeff, 2026-10-19). A rule it
// breaks is the ruling, not a defect.
const isLeastRecentRow = (r) => { try { return !!r && !!r.pick_reason && JSON.parse(r.pick_reason).m === "least-recent"; } catch { return false; } };
// A row past its hour's end does not air (the crossing song plays out, then the next hour's first row; the rest are
// didn't-play), and the picker does not count it against the next hour. The hour's end = its piece's end by the show
// schedule (audiod/show-window.js), as Generate and scheduler-core loadTimeline.
function pastEndFn(w, sid) {
  const endOf = require(path.join(ROOT, "audiod", "scheduler-core.js")).pieceEndFn(w, sid);
  const lkOf = (r) => r.log_hour_ts ?? r.scheduled_at;
  return (r) => !(r.source && String(r.source).trim().toLowerCase() === "operator") && r.scheduled_at >= endOf(lkOf(r));
}
const hourStartOf = (ts) => { const d = new RealDate(ts * 1000); d.setMinutes(0, 0, 0); return Math.floor(d.getTime() / 1000); };
const fmt = (ts) => { const d = new RealDate(ts * 1000); return d.toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hour12: true }); };

// ── the product's code, bound to one copy ─────────────────────────────────────────────────────────
function bindProduct(w) {
  const mainRequire = createRequire(path.join(ROOT, "electron", "main.js"));
  for (const k of Object.keys(require.cache)) if (k.includes(path.join("audiod", "loggen.js"))) delete require.cache[k];
  const gen = require(path.join(ROOT, "electron", "generate-core.js"));
  const loggen = require(path.join(ROOT, "audiod", "loggen.js"));
  const playlog = require(path.join(ROOT, "audiod", "playlog.js"));
  const deps = { db: w, require: mainRequire, _scheduleChanged: () => {}, _healthEvent: () => {}, console: { log: () => {}, error: console.error, warn: () => {} } };
  const commitDayRows = liftFromMain("_commitDayRows", deps);
  const retireStale = liftFromMain("retireStaleScheduleRows", deps);
  // Rule 4 (Jeff, 2026-10-19): every Generate starts from the end of the song on air — main.js _regenPoint, the product's own.
  const regenPoint = liftFromMain("_regenPoint", { ...deps, _genStartTs: (ts) => hourStartOf(ts) });
  const loggenSrc = fs.readFileSync(path.join(ROOT, "audiod", "loggen.js"), "utf8");
  return { gen, loggen, loggenSrc, playlog, commitDayRows, retireStale, regenPoint };
}

// Generate, the way schedule:generateDays / generateDay run it (main.js:11437-11555): one ctx across the
// range, each day hour by hour from effStart = max(dayStart, next top of hour), committed per day.
const curHour = (ts) => { const d = new Date(ts * 1000); d.setMinutes(0, 0, 0); return Math.floor(d.getTime() / 1000); };
async function runGenerate(P, w, sid, dayBases) {
  const genTs = nowSec();
  const ctx = P.gen.buildScheduleCtx(w, sid);
  const committed = [];
  // As main.js's Generate handlers (rule 4, Jeff 2026-10-19): from the end of the song on air, in the piece it belongs to.
  const regen = P.regenPoint(sid, genTs);
  ctx.regen = regen;
  // The window this run replaces, as main's callers say it (Phase 2: the one pick measures against the log outside it).
  if (ctx.planWindow && dayBases.length) {
    const first = Math.floor(dayBases[0].getTime() / 1000), last = Math.floor(dayBases[dayBases.length - 1].getTime() / 1000) + 86400;
    ctx.planWindow(Math.max(first, regen.pieceLk), last);
  }
  for (const dayBase of dayBases) {
    const dayStart = Math.floor(dayBase.getTime() / 1000), dayEnd = dayStart + 86400;
    const effStart = Math.max(dayStart, regen.pieceLk);   // the piece on air, as main.js (rule 4)
    if (effStart >= dayEnd) continue;
    const before = ctx.generatedRows.length;
    P.gen.resetGenSlice();
    for (let h = 0; h < 24; h++) await P.gen.generateDayRows(dayBase, ctx, effStart, h);
    const dayRows = ctx.generatedRows.slice(before);
    P.commitDayRows(sid, effStart, dayEnd, dayRows);
    P.retireStale(sid, "generate");
    committed.push({ effStart, dayEnd, rows: dayRows.length });
  }
  return { genTs, ctx, committed };
}

// ── one station, the 7-day simulation: T1 T2 T3 T4 T8 T11(sim) T18 ────────────────────────────────
async function simulateStation(w, P, F, R) {
  const sid = F.sid;
  const rand = rng(SEED * 1000 + sid);
  const simStart = ANCHOR;
  const simEnd = simStart + DAYS * 86400;
  setNow(simStart);

  // history the rules measure against (MUSIC plays from 2 days before the run)
  const histPlays = w.prepare("SELECT id, title, artist, file_path, played_at, content_class FROM play_log WHERE station_id=? AND deleted_at IS NULL AND played_at >= ? AND played_at < ? ORDER BY played_at").all(sid, simStart - 2 * 86400, simStart);

  const runs = [];
  const t4 = { snapshots: 0, changed: [], deleted: [] };
  // In LOG order (v66: log hour, then time) — the order Generate placed them, so T2 re-derives each pick against what was
  // placed before it. A clock's extra rows past :00 belong to their own hour and were placed before the next hour's rows.
  const genRows = (genTs) => w.prepare(`SELECT * FROM generated_schedule WHERE station_id=? AND generated_at=? AND deleted_at IS NULL ORDER BY ${P.loggen.logKeySql ? P.loggen.logKeySql(w, "generated_schedule") : "scheduled_at"}, scheduled_at, id`).all(sid, genTs);
  const doGenerate = async (days, label) => {
    // T4: snapshot every non-pending row, then compare after the commit
    const snap = new Map(w.prepare("SELECT * FROM generated_schedule WHERE station_id=? AND state IS NOT NULL AND state != 'pending'").all(sid).map(r => [r.id, JSON.stringify(r)]));
    const bases = []; for (let i = 0; i < days; i++) { const d = new FakeDate(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + i); bases.push(d); }
    const g = await runGenerate(P, w, sid, bases);
    const after = new Map(w.prepare("SELECT * FROM generated_schedule WHERE station_id=?").all(sid).map(r => [r.id, r]));
    for (const [id, js] of snap) {
      const a = after.get(id);
      if (!a) t4.deleted.push({ id, label, row: JSON.parse(js) });
      else if (JSON.stringify(a) !== js) t4.changed.push({ id, label, before: JSON.parse(js), after: a });
    }
    t4.snapshots += snap.size;
    // The log AS IT STOOD when this run committed: the pending rows it did not write. Read now, not after the simulated
    // week has aired them (a row pending at 6:14 PM and played at 6:23 PM was "the log on the after side" for the 6:14
    // regenerate, and the checker must see it the way the picker did).
    // Every row this run did not write that is still in the log, from a day before the run (Generate's loadTimeline look-back,
    // rule 3): pending, didn't-play and refused rows (aired rows are counted through play_log).
    const keptAtCommit = w.prepare("SELECT * FROM generated_schedule WHERE station_id=? AND deleted_at IS NULL AND (state IS NULL OR state IN ('pending','missed','skipped')) AND scheduled_at >= ? AND (generated_at IS NULL OR generated_at != ?)").all(sid, g.genTs - 86400, g.genTs);
    runs.push({ label, genTs: g.genTs, rows: genRows(g.genTs), keptAtCommit, relaxed: g.ctx.relaxed.length, breakDrift: g.ctx.breakDrift.length, enforce: g.ctx.enforceSeparation });
    return g;
  };

  const tg0 = RealDate.now();
  await doGenerate(DAYS + 1, "Generate week");
  const genMs = RealDate.now() - tg0; const ta0 = RealDate.now();

  // ── air it ──
  const goLives = [];
  let floorPlays = 0, missedStamped = 0, regenDone = false, skippedAtPlayout = 0, fills = 0, waitedSec = 0;
  const prof = { reader: 0, logPlay: 0, stamp: 0 };
  const regenTs = (() => { const d = new FakeDate(simStart * 1000); d.setDate(d.getDate() + REGEN_AT.day); d.setHours(REGEN_AT.hour, REGEN_AT.minute, 0, 0); let t = Math.floor(d.getTime() / 1000); if (t < simStart) t += 86400; return t; })();
  let guard = 0;
  // THE LOG PLAYS AS BUILT (2026-10-18): the engine passes the last log row that aired in this AUTO session; AUTO turns
  // off when the log is done and no show is on, and on again at the next show's start, from that piece's first row.
  let lastRow = null, fromPieceStart = false, autoOffs = 0;
  // OVERLAYS (2026-10-18): the engine starts the next song the station's segue overlap before the song on air ends
  // (engine.js _segueTick), music → music only. The model does the same, from the same setting.
  const overlapS = SEGUE.readSegueOverlapSec(w, sid) || 0;
  let prevEnd = null;
  const showBoundaryReader = !P.loggen.fillShortHour && !!P.loggen.readLogAnchored && /pieceAt/.test(P.loggenSrc || "");
  while (nowSec() < simEnd && guard++ < 200000) {
    if (!regenDone && nowSec() >= regenTs) { regenDone = true; await doGenerate(1, "Regenerate on air " + fmt(nowSec())); }
    let tq = RealDate.now();
    let r = showBoundaryReader ? P.loggen.readLogAnchored(w, sid, 20, undefined, { seamTs: nowSec(), onAirRowId: lastRow, ...(fromPieceStart ? { fromPieceStart: true } : {}) })
                               : P.loggen.readLogAnchored(w, sid, 20);
    prof.reader += RealDate.now() - tq;
    let item = null, offLog = false;
    if (P.loggen.fillShortHour) {
      // Phase 2/3 engine (engine.js _refillFromLog), modelled the same way: rows the playout check refused are stamped
      // 'skipped'; nothing due → the hour's own clock fills (the row is written to the log first) or the station waits.
      const stampSkips = (rr) => { for (const k of (rr.skip || [])) { w.prepare("UPDATE generated_schedule SET state='skipped', pick_reason=? WHERE id=? AND station_id=? AND state='pending'").run(`skipped at playout: ${k.rule} ${k.measuredMin}/${k.settingMin} min`, k.rowId, sid); skippedAtPlayout++; } };
      if (r.skip && r.skip.length) {
        stampSkips(r);
        // engine.js: the refused row's slot is picked again from its own category (design §3.2.2)
        const f0 = P.loggen.fillShortHour(w, sid, nowSec(), { categoryId: r.skip[0].categoryId });
        if (f0.rowId != null) { fills++; r = P.loggen.readLogAnchored(w, sid, 20); stampSkips(r); }
      }
      if (!r.items.length) {
        const f = P.loggen.fillShortHour(w, sid, nowSec());
        if (f.rowId != null) { fills++; r = P.loggen.readLogAnchored(w, sid, 20); stampSkips(r); }
        if (!r.items.length) {
          // waiting: jump to the next moment anything can change — the fill's own retry time (the closest blocked song
          // becoming free), the next row's time, or the next hour
          const hEnd = (() => { const d = new FakeDate(nowSec() * 1000); d.setMinutes(0, 0, 0); return Math.floor(d.getTime() / 1000) + 3600; })();
          let nxt = r.nextDueTs && r.nextDueTs > nowSec() ? Math.min(r.nextDueTs, hEnd) : hEnd;
          if (f.retryAt && f.retryAt > nowSec()) nxt = Math.min(nxt, f.retryAt);
          waitedSec += Math.max(1, nxt - nowSec());
          setNow(Math.max(nowSec() + 1, nxt));
          continue;
        }
      }
    }
    if (showBoundaryReader) {
      const stampSkips = (rr) => { for (const k of (rr.skip || [])) { w.prepare("UPDATE generated_schedule SET state='skipped', pick_reason=? WHERE id=? AND station_id=? AND state='pending'").run(`skipped at playout: ${k.rule} ${k.measuredMin}/${k.settingMin} min`, k.rowId, sid); skippedAtPlayout++; } };
      stampSkips(r);
      for (let k = 0; k < 10 && r.mode === "skipping"; k++) { r = P.loggen.readLogAnchored(w, sid, 20, undefined, { seamTs: nowSec(), onAirRowId: lastRow, ...(fromPieceStart ? { fromPieceStart: true } : {}) }); stampSkips(r); }
      if (!r.items.length) {
        if (!r.inShow && lastRow != null) { lastRow = null; fromPieceStart = true; autoOffs++; }   // AUTO off; on at the next show
        const hEnd = (() => { const d = new FakeDate(nowSec() * 1000); d.setMinutes(0, 0, 0); return Math.floor(d.getTime() / 1000) + 3600; })();
        const nxt = r.nextDueTs && r.nextDueTs > nowSec() ? Math.min(r.nextDueTs, hEnd) : hEnd;
        waitedSec += Math.max(1, nxt - nowSec());
        setNow(Math.max(nowSec() + 1, nxt));
        continue;
      }
    }
    if (!showBoundaryReader && !P.loggen.fillShortHour && (r.mode === "exhausted" || r.mode === "error" || !r.items.length)) {
      const fill = P.loggen.fillQueue(w, sid, 20);
      item = fill.items && fill.items[0];
      offLog = true;
      if (!item) { setNow(nowSec() + 60); continue; }      // starved: a minute of silence, then retry
      floorPlays++;
    } else {
      if (r.missedRowIds.length) {
        const ph = r.missedRowIds.map(() => "?").join(",");
        // engine.js _refillFromLog, verbatim (never a row added by hand)
        const info = w.prepare(`UPDATE generated_schedule SET state='missed' WHERE id IN (${ph}) AND station_id=? AND state='pending' AND ${P.loggen.notOperatorSql ? P.loggen.notOperatorSql("generated_schedule") : "1"}`).run(...r.missedRowIds, sid);
        missedStamped += Number(info.changes || 0);
      }
      item = r.items[0];
    }
    const itemIsMusic = !item.contentClass || item.contentClass === "MUSIC";
    if (!itemIsMusic && prevEnd != null && nowSec() < prevEnd) setNow(prevEnd);   // a spot edge never overlaps
    const t = nowSec();
    const plannedS = Math.max(1, Math.round((item.durationMs || 240000) / 1000));
    const actualS = Math.max(1, Math.round(plannedS * (1 + (rand() * 2 - 1) * LENGTH_ERR)));
    tq = RealDate.now();
    let playId;
    if (P.playlog.recordGoLive) {
      // Phase 1 and after: the engine's own go-live record (audiod/playlog.js recordGoLive, called by engine
      // _recordGoLive) — the play and the row's stamp in one transaction. Nothing copied.
      const rec = P.playlog.recordGoLive(w.raw, { stationId: sid, title: item.title, artist: item.artist, deck: "A", durationMs: actualS * 1000, sessionId: "scheduler-gate", filePath: item.filePath, contentClass: item.contentClass, rowId: item.schedId ?? null, playedAt: t });
      playId = rec.playUuid;
      if (!rec.ok && !globalThis.__recErr) { globalThis.__recErr = 1; console.log("    go-live record failed: " + rec.error); }
      prof.logPlay += RealDate.now() - tq; tq = RealDate.now();
    } else {
      playId = P.playlog.logPlay(w.raw, { stationId: sid, title: item.title, artist: item.artist, deck: "A", durationMs: actualS * 1000, sessionId: "scheduler-gate", filePath: item.filePath, contentClass: item.contentClass });
      prof.logPlay += RealDate.now() - tq; tq = RealDate.now();
      // engine.js:1876-1884 (6558e57), verbatim
      if (item.schedId != null) {
        w.prepare("UPDATE generated_schedule SET state='played' WHERE station_id=? AND state='playing' AND id!=?").run(sid, item.schedId);
        w.prepare("UPDATE generated_schedule SET state='playing', played_at=? WHERE id=? AND station_id=?").run(t, item.schedId, sid);
      } else {
        w.prepare("UPDATE generated_schedule SET state='played' WHERE station_id=? AND state='playing'").run(sid);
      }
    }
    const row = item.schedId != null ? w.prepare(`SELECT id, scheduled_at, category_id, clock_id, content_class, song_id, ${P.loggen.logKeySql ? P.loggen.logKeySql(w, "generated_schedule") : "scheduled_at"} AS lk FROM generated_schedule WHERE id=?`).get(item.schedId) : null;
    prof.stamp += RealDate.now() - tq;
    if (item.schedId != null) { lastRow = item.schedId; fromPieceStart = false; }
    goLives.push({ ts: t, schedId: item.schedId ?? null, row, title: item.title, filePath: item.filePath, contentClass: item.contentClass || (row && row.content_class) || "MUSIC", offLog, mode: r.mode, playUuid: playId });
    prevEnd = t + actualS;
    setNow(t + actualS - (itemIsMusic ? overlapS : 0));
  }

  // ── check ──
  const res = { station: F.sid, window: `${fmt(simStart)} → ${fmt(simEnd)}`, generateSec: Math.round(genMs / 1000), airSec: Math.round((RealDate.now() - ta0) / 1000), airProfileMs: prof, goLives: goLives.length, floorPlays, missedStamped, skippedAtPlayout, fillRows: fills, autoOffs, silentHours: +(waitedSec / 3600).toFixed(1), runs: runs.map(r => ({ label: r.label, rows: r.rows.length, relaxedByGenerate: r.relaxed, breakDriftByGenerate: r.breakDrift, enforceSeparation: r.enforce })) };

  // on-air timeline: history + simulated plays (MUSIC)
  const simPlays = w.prepare("SELECT id, title, artist, file_path, played_at, content_class, scheduled_log_id, category_code FROM play_log WHERE station_id=? AND session_id='scheduler-gate' ORDER BY played_at, id").all(sid);
  const air = new C.Timeline();
  for (const p of histPlays) if (isMusicPlay(p)) air.add(playEvent(F, p));
  const simEvents = [];
  for (const p of simPlays) if (isMusicPlay(p)) { const ev = playEvent(F, p); air.add(ev); simEvents.push(ev); }

  // T1 on air: every simulated play against what aired before it
  const t1Air = [];
  const lrpRowUuids = new Set(w.prepare("SELECT uuid, pick_reason FROM generated_schedule WHERE station_id=? AND pick_reason LIKE '%least-recent%'").all(sid).filter(isLeastRecentRow).map(r => r.uuid));
  const lrpPlayRefs = new Set();
  if (w.prepare("PRAGMA table_info(play_log)").all().some(c => c.name === "row_uuid"))
    for (const p of w.prepare("SELECT id, row_uuid FROM play_log WHERE station_id=? AND session_id='scheduler-gate'").all(sid)) if (p.row_uuid && lrpRowUuids.has(p.row_uuid)) lrpPlayRefs.add("p" + p.id);
  let t1AirLrp = 0;
  for (const ev of simEvents) for (const b of C.breaches(air, ev, F.rules, { sides: "before" })) {
    if (lrpPlayRefs.has(ev.ref)) { t1AirLrp++; continue; }
    t1Air.push({ at: fmt(ev.ts), rule: b.rule, key: b.key, measuredMin: b.measuredMin, settingMin: b.settingMin });
  }
  res.T1_onAir = { violations: t1Air.length, byRule: countBy(t1Air, "rule"), examples: t1Air.slice(0, 8), leastRecentPlays: t1AirLrp };

  // T1 in the log + T2 the pick, per Generate run, against the state at that run
  const t1Log = new Map(); const t2 = { checked: 0, notPassing: [], notLongest: [], nothingPassedButPlaced: 0, nBreaking: 0, nNotLongest: 0 };
  // every play this station has on record before the run: "waited longest since it last aired" needs
  // the whole history, not a window
  const allPlaysAt = w.prepare("SELECT id, title, artist, file_path, played_at, content_class FROM play_log WHERE station_id=? AND deleted_at IS NULL AND played_at >= ? AND played_at < ? ORDER BY played_at");
  const HISTORY_FROM = 0;
  for (const run of runs) {
    const tl = new C.Timeline();
    for (const p of allPlaysAt.all(sid, HISTORY_FROM, run.genTs)) if (isMusicPlay(p)) tl.add(playEvent(F, p));
    const runIds = new Set(run.rows.map(r => r.id));
    // what was already in the log, on either side, that this run did not write (kept rows)
    const kept = run.keptAtCommit;
    const pastEnd = pastEndFn(w, sid);
    // RULE 3 (Jeff, 2026-10-19): "Generate sees every row before a slot, including the previous hour's rows, so it never
    // repeats a song the previous hour already has." Exactly Generate's timeline (scheduler-core loadTimeline): what
    // aired counts through play_log; every other row still in the log — pending, didn't-play, refused, the previous
    // hour's rows timed past its :00 — counts by its row.
    // Only rows that air count (exactly Generate's loadTimeline): not the aired ones (counted through play_log), not
    // didn't-play or refused rows, not automatic rows timed past their hour's end (rule 1 marks them didn't-play).
    const counts = (k) => !(k.state === "played" || k.state === "playing" || k.state === "missed" || k.state === "skipped") && !pastEnd(k);
    for (const k of kept) if (isMusicRow(k) && !runIds.has(k.id) && counts(k)) tl.add(rowEvent(F, k));
    // full log after the commit for the T1 in-log check: the rows that air (not past their hour's end), and a least
    // recently played row breaks a rule by the ruling
    const full = new C.Timeline();
    for (const p of allPlaysAt.all(sid, run.genTs - 2 * 86400, run.genTs)) if (isMusicPlay(p)) full.add(playEvent(F, p));   // rules reach ≤ 1 day
    for (const k of kept) if (isMusicRow(k) && !pastEnd(k) && k.state !== "missed" && k.state !== "skipped") full.add(rowEvent(F, k));   // rows that air
    const runEvents = run.rows.filter(isMusicRow).map(r => [r, rowEvent(F, r)]);
    const lrpRefs = new Set([...kept, ...run.rows].filter(isLeastRecentRow).map(r => "r" + r.id));
    for (const [r, ev] of runEvents) if (!pastEnd(r)) full.add(ev);
    for (const [r, ev] of runEvents) if (!pastEnd(r) && !lrpRefs.has(ev.ref)) for (const b of C.breaches(full, ev, F.rules)) {
      if (lrpRefs.has(b.other.ref)) continue;
      const pair = [ev.ref, b.other.ref].sort().join("~") + "|" + b.rule + "|" + b.key;
      if (!t1Log.has(pair)) t1Log.set(pair, { at: fmt(Math.min(ev.ts, b.other.ts)), rule: b.rule, key: b.key, measuredMin: b.measuredMin, settingMin: b.settingMin, run: run.label });
    }
    // T2: walk this run's rows in order; each music row re-derived against what came before it. A row past its hour's end
    // is on the timeline while its own hour is built and comes off when the next hour starts (generate-core pastEnd):
    // it never airs.
    let curLk = null; const pastEndEvs = [];
    for (const [r, ev] of runEvents) {
      const lk = r.log_hour_ts ?? r.scheduled_at;
      if (lk !== curLk) { for (const x of pastEndEvs) tl.remove(x); pastEndEvs.length = 0; curLk = lk; }
      if (pastEnd(r)) pastEndEvs.push(ev);
      const hour = new RealDate(r.scheduled_at * 1000).getHours();
      const pool = F.pool(r.category_id, hour);
      const d = C.rederivePick(tl, pool, r.scheduled_at, F.rules);
      t2.checked++;
      const placedPasses = !C.breaches(tl, { ...ev, ts: r.scheduled_at }, F.rules).length;
      // Nothing passed → the least recently played song goes in, rules set aside (Jeff, 2026-10-19): a rule broken there
      // is the ruling, not a defect; it must still be the least recently played.
      if (d.leastRecent) t2.nothingPassedButPlaced++;
      if (!placedPasses && !d.leastRecent) {
        t2.nBreaking++;
        if (t2.notPassing.length < 400) t2.notPassing.push({ at: fmt(r.scheduled_at), category: F.catName.get(r.category_id), placed: r.title, passingSongs: d.passing.length, rules: C.breaches(tl, { ...ev, ts: r.scheduled_at }, F.rules).map(b => `${b.rule} ${b.measuredMin}/${b.settingMin} min`).join(", ") });
      } else if (!d.longestWaiting.some(s => s.rec === ev.rec)) {
        const lastPlaced = tl.lastBefore(ev.rec, r.scheduled_at);
        const best = d.longestWaiting[0];
        t2.nNotLongest++;
        if (t2.notLongest.length < 400) t2.notLongest.push({ at: fmt(r.scheduled_at), category: F.catName.get(r.category_id), placed: r.title, placedLastAired: lastPlaced == null ? "never" : fmt(lastPlaced), shouldBe: best ? best.name : null, shouldBeLastAired: d.bestLastTs === -Infinity ? "never" : fmt(d.bestLastTs), tiedCandidates: d.longestWaiting.length });
      }
      tl.add(ev);
    }
  }
  const t1LogList = [...t1Log.values()];
  res.T1_inLog = { violations: t1LogList.length, byRule: countBy(t1LogList, "rule"), examples: t1LogList.slice(0, 8) };
  res.T2 = { checked: t2.checked, placedBreakingARule: t2.nBreaking, notTheLongestWaiting: t2.nNotLongest, slotsWhereNothingPassedLeastRecentWentIn: t2.nothingPassedButPlaced, unscheduledSlots: runs.reduce((n, r) => n + r.rows.filter(x => x.content_class === "UNSCHEDULED").length, 0), examplesBreaking: t2.notPassing.slice(0, 5), examplesNotLongest: t2.notLongest.slice(0, 5) };

  // T3: the count proof over the simulated week, per clock category
  const pools = new Map();
  for (const cat of F.clockCats) pools.set(cat, new Set(F.songs.filter(s => !s.deleted_at && s.category_id === cat && s.rotation_status !== "inactive" && (s.content_class == null || s.content_class === "MUSIC")).map(s => C.recordingKey(s.file_path || s.file_key)).filter(Boolean)));
  const proof = new C.CountProof(pools);
  const tAir = new C.Timeline();
  for (const p of histPlays) if (isMusicPlay(p)) tAir.add(playEvent(F, p));
  // every music row any run planned (whatever became of it), for the after side of a T3 exception
  const tLog = new C.Timeline();
  for (const run of runs) for (const r of run.rows) if (isMusicRow(r)) tLog.add(rowEvent(F, r));
  for (const r of w.prepare("SELECT * FROM generated_schedule WHERE station_id=? AND deleted_at IS NULL AND source='fill'").all(sid)) if (isMusicRow(r)) tLog.add(rowEvent(F, r));
  const playByUuid = new Map(w.prepare("SELECT uuid, id, title, artist, file_path, played_at, content_class FROM play_log WHERE station_id=? AND session_id='scheduler-gate'").all(sid).map(p => [p.uuid, p]));
  for (const g of goLives) {
    const p = playByUuid.get(g.playUuid); if (!p || !isMusicPlay(p)) continue;
    const ev = playEvent(F, p);
    const s = ev.rec ? F.byRec.get(ev.rec) : null;
    const cat = g.row && g.row.category_id != null ? g.row.category_id : (s ? s.category_id : null);
    const hour = new RealDate(g.ts * 1000).getHours();
    proof.onAir(cat, ev.rec, g.ts, (rec) => {
      const so = F.byRec.get(rec);
      if (!so) return "not in library";
      if (so.daypart_mask != null && ((so.daypart_mask >> hour) & 1) !== 1) return "daypart";
      const probe = C.makeEvent({ ts: g.ts, file: so.file_path || so.file_key, artist: so.artist, title: so.title, kind: "probe", ref: null, noRepeatHours: so.no_repeat_hours, durationMs: so.duration_ms }, F.split);
      const b = C.breaches(tAir, probe, F.rules, { sides: "before" });
      if (b.length) return `${b[0].rule} ${b[0].measuredMin}/${b[0].settingMin} min`;
      // ...or by the LOG on the after side (design §3.2: the rules are measured against what aired plus the log on either
      // side): a song already planned within its rule after this moment cannot be placed here.
      const a2 = C.breaches(tLog, probe, F.rules, { sides: "after" });
      return a2.length ? `${a2[0].rule} (in the log) ${a2[0].measuredMin}/${a2[0].settingMin} min` : null;
    });
    tAir.add(ev);
  }
  const spreads = [...proof.maxSpread.entries()].map(([c, v]) => ({ category: F.catName.get(c) || c, songs: pools.get(c).size, maxSpread: v }));
  res.T3 = { failures: proof.failures.length, d1Exceptions: proof.exceptions.length, maxSpreadByCategory: spreads, examples: proof.failures.slice(0, 5).map(f => ({ at: fmt(f.ts), category: F.catName.get(f.cat), aired: f.aired, countBefore: f.countBefore, lowest: f.minCount, unblockedLowerCountSongs: f.passedOverCount, passedOver: f.passedOver })) };

  // T4: aired rows untouched by Generate / regenerate
  res.T4 = { nonPendingRowsSnapshotted: t4.snapshots, deleted: t4.deleted.length, changed: t4.changed.length,
    examples: [...t4.deleted.slice(0, 4).map(d => ({ what: "DELETED", by: d.label, row: `${fmt(d.row.scheduled_at)} ${d.row.title} [${d.row.state}${d.row.played_at ? " at " + fmt(d.row.played_at) : ""}]` })),
               ...t4.changed.slice(0, 4).map(d => ({ what: "CHANGED", by: d.label, row: `${fmt(d.before.scheduled_at)} ${d.before.title}`, fields: Object.keys(d.before).filter(k => String(d.before[k]) !== String(d.after[k])) }))] };

  // T8: never ahead. Jeff, 2026-10-18: "'Never run ahead' only means: never play rows from outside the show schedule,
  // never jump past the show's end, never pull rows from another day." Inside a show the next hour's rows play as soon
  // as the hour before runs out — that is not ahead. A row is ahead when it aired before its own piece (the hour, cut at
  // show starts/ends — its log hour, v66) began AND either no show was on when it aired, a different show was, or it was
  // another day.
  const SW = require(path.join(ROOT, "audiod", "show-window.js"));
  const t8Shows = w.prepare("SELECT * FROM shows WHERE station_id = ? AND is_active = 1 AND deleted_at IS NULL").all(sid);
  const dayOf = (ts) => { const d = new RealDate(ts * 1000); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };
  const rowPieceStart = (g) => SW.pieceAt(t8Shows, g.row.lk ?? g.row.scheduled_at).startTs;
  const ahead = goLives.filter(g => {
    if (!g.row) return false;
    const pRow = SW.pieceAt(t8Shows, g.row.lk ?? g.row.scheduled_at);
    if (pRow.startTs <= g.ts + EARLY_START_WINDOW_S) return false;              // aired inside or after its own piece
    const pAir = SW.pieceAt(t8Shows, g.ts);
    return !(pAir.show && pRow.show && pAir.show.id === pRow.show.id && dayOf(pAir.startTs) === dayOf(pRow.startTs));
  });
  res.T8 = { goLives: goLives.length, rowsAiredBeforeTheirHour: ahead.length, maxAheadMin: ahead.length ? Math.round(Math.max(...ahead.map(g => rowPieceStart(g) - g.ts)) / 60) : 0,
    offLogPlays: floorPlays, examples: ahead.slice(0, 5).map(g => ({ aired: fmt(g.ts), rowFor: fmt(g.row.scheduled_at), title: g.title })),
    // every one, for checking by hand: the row id, when it was scheduled, when the reader aired it, and what
    // the reader said about the moment (mode ahead / on-time / behind)
    all: ahead.slice(0, 3000).map(g => ({ rowId: g.schedId, scheduledAt: g.row.scheduled_at, airedAt: g.ts, aheadMin: Math.round((g.row.scheduled_at - g.ts) / 60), mode: g.mode, title: g.title })),
    largest: ahead.length ? (() => { const m = ahead.reduce((a, b) => (rowPieceStart(b) - b.ts > rowPieceStart(a) - a.ts ? b : a)); return { rowId: m.schedId, scheduledAt: m.row.scheduled_at, airedAt: m.ts, scheduled: fmt(m.row.scheduled_at), aired: fmt(m.ts), title: m.title, mode: m.mode }; })() : null };

  // T11 (simulated part): every go-live recorded with its row and category
  // A play that came from a log row must carry that row (v63 row_uuid; before v63 there was no link at all, and the
  // retired scheduled_log_id was always NULL) and, for music, its category. Off-log floor plays have no row to carry.
  const hasLink = w.prepare("PRAGMA table_info(play_log)").all().some(c => c.name === "row_uuid");
  const linkOf = new Map(hasLink ? w.prepare("SELECT uuid, row_uuid, category_code, content_class FROM play_log WHERE station_id=? AND session_id='scheduler-gate'").all(sid).map(p => [p.uuid, p]) : []);
  const fromLog = goLives.filter(g => g.schedId != null);
  const unlinked = fromLog.filter(g => { const p = linkOf.get(g.playUuid); return !p || !p.row_uuid; }).length;
  const noCat = fromLog.filter(g => { const p = linkOf.get(g.playUuid); return g.row && g.row.category_id != null && (g.contentClass === "MUSIC") && (!p || p.category_code == null); }).length;
  res.T11_sim = { plays: simPlays.length, logPlays: fromLog.length, playsWithoutLogRowId: unlinked, musicPlaysWithoutCategory: noCat };

  // T18: spot breaks on time (3c). First spot of each break against its clock_breaks minute.
  const breaksByClock = new Map();
  for (const b of w.prepare("SELECT clock_id, minute FROM clock_breaks WHERE station_id=? AND deleted_at IS NULL ORDER BY clock_id, minute, sort_order").all(sid)) {
    if (!breaksByClock.has(b.clock_id)) breaksByClock.set(b.clock_id, []);
    const a = breaksByClock.get(b.clock_id); if (!a.includes(b.minute)) a.push(b.minute);
  }
  const t18 = []; let breaksSeen = 0, inHourSeen = 0; const seenIdx = new Map();
  for (let i = 0; i < goLives.length; i++) {
    const g = goLives[i];
    if (g.contentClass !== "SPOT" || !g.row) continue;
    if (i > 0 && goLives[i - 1].contentClass === "SPOT") continue;     // only a break's first spot
    const mins = breaksByClock.get(g.row.clock_id); if (!mins || !mins.length) continue;
    const H = hourStartOf(g.row.scheduled_at); const k = g.row.clock_id + "|" + H;
    const idx = seenIdx.get(k) || 0; seenIdx.set(k, idx + 1);
    if (idx >= mins.length) continue;
    breaksSeen++;
    const planned = H + mins[idx] * 60, drift = g.ts - planned;
    const inHour = g.ts >= H && g.ts < H + 3600;
    if (inHour) inHourSeen++;
    if (Math.abs(drift) > BREAK_TOL_S) t18.push({ planned: fmt(planned), started: fmt(g.ts), driftSec: drift, inHour });
  }
  const t18In = t18.filter(x => x.inHour);
  res.T18 = { timedBreaksAired: breaksSeen, outsideTolerance: t18.length, airedInOwnHour: inHourSeen, inOwnHourOutsideTolerance: t18In.length,
    inOwnHourMaxLateSec: t18In.length ? Math.max(0, ...t18In.map(x => x.driftSec)) : 0, inOwnHourMaxEarlySec: t18In.length ? Math.max(0, ...t18In.map(x => -x.driftSec)) : 0, inOwnHourExamples: t18In.slice(0, 5), toleranceSec: BREAK_TOL_S, maxLateSec: t18.length ? Math.max(0, ...t18.map(x => x.driftSec)) : 0, maxEarlySec: t18.length ? Math.max(0, ...t18.map(x => -x.driftSec)) : 0, examples: t18.slice(0, 5) };
  R.push(res);
  return res;
}

// ── T19: the reader's call time on the database as it is (Jeff, 2026-10-18) ──────────────────────
// Measured on copy A BEFORE anything on it is changed (no ANALYZE, nothing pruned), so it is the number the
// daemon pays on this database today. The air loop is engine.js:559 setInterval(poll, 250) → _maintain()
// (engine.js:953) → refillIfNeeded → _refillFromLog (throttled 2 s) → readLogAnchored, and node:sqlite is
// synchronous, so the whole call is time the loop is not running.
// Judged as the MEDIAN OF 3 RUNS (Jeff, 2026-10-18), each run the median of `calls` calls, against the limit setting. A
// timing is not exact, so T19 is judged against its limit and is not in the exact ratchet.
function measureReader(w, P, sid, calls = 15, runs = 3) {
  setNow(Math.ceil(RealDate.now() / 1000 / 3600) * 3600);
  const runMedians = [];
  let max = 0;
  for (let k = 0; k < runs; k++) {
    const ms = [];
    for (let i = 0; i < calls; i++) {
      const t0 = process.hrtime.bigint();
      try { P.loggen.readLogAnchored(w, sid, 20); } catch {}
      ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    ms.sort((a, b) => a - b);
    runMedians.push(ms[Math.floor(calls / 2)]); max = Math.max(max, ms[calls - 1]);
  }
  fakeNowMs = null;
  const sorted = [...runMedians].sort((a, b) => a - b);
  return { calls, runs, runMediansMs: runMedians.map(x => +x.toFixed(1)), medianMs: +sorted[Math.floor(runs / 2)].toFixed(1), maxMs: +max.toFixed(1),
    limitMs: READER_LIMIT_MS, pollIntervalMs: 250, generatedScheduleRows: w.prepare("SELECT count(*) n FROM generated_schedule WHERE station_id=?").get(sid).n };
}

// ── T5: started early (automation at 12:25, the log starts at 3 PM) ───────────────────────────────
async function scenarioStartedEarly(w, P, F) {
  const sid = F.sid;
  const d = new FakeDate(ANCHOR * 1000); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 9); // a clean day after the simulated week
  const dayStart = Math.floor(d.getTime() / 1000);
  setNow(dayStart - 3600);
  const bases = [new FakeDate(dayStart * 1000)];
  await runGenerate(P, w, sid, bases);
  // the day's log starts at 3 PM: pending rows before 15:00 are removed (soft delete, as Clear does)
  const three = dayStart + 15 * 3600;
  w.prepare("UPDATE generated_schedule SET deleted_at='gate' WHERE station_id=? AND state='pending' AND scheduled_at >= ? AND scheduled_at < ?").run(sid, dayStart, three);
  const evening = w.prepare("SELECT count(*) n FROM generated_schedule WHERE station_id=? AND deleted_at IS NULL AND state='pending' AND scheduled_at >= ? AND scheduled_at < ?").get(sid, three, dayStart + 86400).n;
  setNow(dayStart + 12 * 3600 + 25 * 60);
  const consumed = [];
  let guard = 0;
  while (nowSec() < three && guard++ < 2000) {
    const r = P.loggen.readLogAnchored(w, sid, 20);
    const item = r.items && r.items[0];
    if (!item) { setNow(nowSec() + 60); continue; }
    const row = w.prepare("SELECT scheduled_at FROM generated_schedule WHERE id=?").get(item.schedId);
    if (P.playlog.recordGoLive) P.playlog.recordGoLive(w.raw, { stationId: sid, title: item.title, artist: item.artist, deck: "A", durationMs: item.durationMs || 0, sessionId: "scheduler-gate-t5", filePath: item.filePath, contentClass: item.contentClass, rowId: item.schedId, playedAt: nowSec() });
    else {
      w.prepare("UPDATE generated_schedule SET state='played' WHERE station_id=? AND state='playing' AND id!=?").run(sid, item.schedId);
      w.prepare("UPDATE generated_schedule SET state='playing', played_at=? WHERE id=? AND station_id=?").run(nowSec(), item.schedId, sid);
    }
    if (row && row.scheduled_at >= three) consumed.push({ aired: fmt(nowSec()), rowFor: fmt(row.scheduled_at), title: item.title, mode: r.mode });
    setNow(nowSec() + Math.max(1, Math.round((item.durationMs || 240000) / 1000)));
  }
  // RULE 2 (Jeff, 2026-10-19): "Inside a show the player never waits for a row's time." A station whose show is ON at 12:25
  // plays the next row at once (here the 3 PM rows — same show, same day); one whose show is not on airs nothing before it.
  const SWin = require(path.join(ROOT, "audiod", "show-window.js"));
  const showRows = w.prepare("SELECT * FROM shows WHERE station_id = ? AND is_active = 1 AND deleted_at IS NULL").all(sid);
  const start = dayStart + 12 * 3600 + 25 * 60;
  // "Inside a show" for this test = the show on at 12:25 is the 3 PM rows' own show (a different show still waits for its start).
  const at1225 = SWin.showAt(showRows, start), at3 = SWin.showAt(showRows, three);
  const inShowAt1225 = !!(at1225 && at3 && at1225.id === at3.id);
  return { station: sid, day: fmt(dayStart), eveningRowsInLog: evening, eveningRowsAiredBefore3PM: consumed.length, inShowAt1225,
    startedAt1225: consumed.length > 0 && consumed[0].aired === fmt(start), examples: consumed.slice(0, 5) };
}

// ── T10: a row that breaks separation is in the log; does it air? ─────────────────────────────────
async function scenarioViolatorInLog(w, P, F) {
  const sid = F.sid;
  if (F.rules.songMin == null) return { station: sid, ran: false, why: "song separation is off on this station" };
  const d = new FakeDate(ANCHOR * 1000); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 11);
  const dayStart = Math.floor(d.getTime() / 1000);
  setNow(dayStart - 3600);
  await runGenerate(P, w, sid, [new FakeDate(dayStart * 1000)]);
  // two neighbouring music rows of that day, closer together than the song rule
  const rows = w.prepare(`SELECT * FROM generated_schedule WHERE station_id=? AND state='pending' AND deleted_at IS NULL AND song_id IS NOT NULL
                            AND (content_class IS NULL OR content_class='MUSIC') AND scheduled_at >= ? AND scheduled_at < ? ORDER BY scheduled_at`).all(sid, dayStart, dayStart + 86400);
  let i = rows.findIndex((r, k) => k + 1 < rows.length && rows[k + 1].scheduled_at - r.scheduled_at < F.rules.songMin * 30);
  if (i < 0) return { station: sid, ran: false, why: "no two music rows closer than half the song rule" };
  const aired = rows[i], next = rows[i + 1];
  // air the first one at its own time
  setNow(aired.scheduled_at);
  let r = P.loggen.readLogAnchored(w, sid, 20);
  const fp = (r.items || []).find(it => it.schedId === aired.id);
  if (P.playlog.recordGoLive) P.playlog.recordGoLive(w.raw, { stationId: sid, title: aired.title, artist: aired.artist, deck: "A", durationMs: (aired.duration_s || 200) * 1000, sessionId: "scheduler-gate-t10", filePath: fp ? fp.filePath : aired.file_path, rowId: aired.id, playedAt: nowSec() });
  else {
    w.prepare("UPDATE generated_schedule SET state='playing', played_at=? WHERE id=?").run(nowSec(), aired.id);
    P.playlog.logPlay(w.raw, { stationId: sid, title: aired.title, artist: aired.artist, deck: "A", durationMs: (aired.duration_s || 200) * 1000, sessionId: "scheduler-gate-t10", filePath: fp ? fp.filePath : aired.file_path });
  }
  const airedAt = nowSec();
  // the next row becomes the same song (as a swap in the editor, a sync from another machine, or a bug can do)
  w.prepare("UPDATE generated_schedule SET song_id=?, title=?, artist=?, file_key=?, file_path=?, duration_s=?, category_id=? WHERE id=?")
    .run(aired.song_id, aired.title, aired.artist, aired.file_key, aired.file_path, aired.duration_s, aired.category_id, next.id);
  w.prepare("UPDATE generated_schedule SET state='played' WHERE id=?").run(aired.id);
  // its slot arrives: it is the log's row for now. Does the reader check it against what just aired?
  setNow(Math.max(airedAt + (aired.duration_s || 200), next.scheduled_at));
  r = P.loggen.readLogAnchored(w, sid, 20);
  const nextUp = r.items && r.items[0];
  const airs = !!nextUp && nextUp.schedId === next.id;
  return { station: sid, ran: true, song: aired.title, songRuleMin: F.rules.songMin, gapMin: Math.round((nowSec() - airedAt) / 60), violatorAirsNext: airs, readerChose: nextUp ? `${nextUp.title} (row ${nextUp.schedId})` : null, violatorRow: next.id };
}

// ── T20: the log plays straight through the show (Jeff, 2026-10-18) — FX-PLAYTHROUGH only ──────────────────────────
//   1 Generate places EVERY row on the clock; 2 timing uses the segue overlap, not the file length; 3 a song that crosses
//   :00 plays out, then the next hour's first row; the old hour's rows that did not air are didn't-air, never deleted;
//   4 a row added by hand is never removed by anything automatic; 6 inside a show the log never waits for :00;
//   7 an hour whose rows end early because of overlays plays straight into the next hour's first row with no silence,
//   and a show's last row ends and nothing plays after the show.
// The product's own Generate (generate-core + main.js _commitDayRows), reader (loggen.readLogAnchored) and record
// (playlog.recordGoLive); the deck machinery is modelled as in the week (one row per seam, overlap from the setting),
// with every song at exactly its planned length so the hours are known in advance.
async function scenarioPlaysThrough(w, P, F, stationName) {
  const sid = F.sid;
  if (stationName !== "FX-PLAYTHROUGH") return null;
  const SW = require(path.join(ROOT, "audiod", "show-window.js"));
  const out = { station: sid, checks: [] };
  const check = (rule, pass, line) => out.checks.push({ rule, pass: !!pass, line });
  const d = new FakeDate(ANCHOR * 1000); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 13);
  const dayStart = Math.floor(d.getTime() / 1000);
  const at = (h, m = 0, sec = 0) => dayStart + h * 3600 + m * 60 + sec;
  const lkSql = P.loggen.logKeySql(w, "generated_schedule");
  const overlapS = SEGUE.readSegueOverlapSec(w, sid) || 0;
  const shows = w.prepare("SELECT * FROM shows WHERE station_id = ? AND is_active = 1 AND deleted_at IS NULL").all(sid);
  const clockRows = (name) => w.prepare("SELECT COUNT(*) n FROM clock_slots cs JOIN clocks c ON c.id = cs.clock_id WHERE c.name = ? AND c.station_id = ? AND cs.deleted_at IS NULL AND cs.slot_type = 'music'").get(name, sid).n;
  const hourRows = (h) => w.prepare(`SELECT id, scheduled_at, duration_s, source, state, deleted_at, ${lkSql} AS lk FROM generated_schedule WHERE station_id = ? AND ${lkSql} = ? AND (content_class IS NULL OR content_class = 'MUSIC') ORDER BY scheduled_at, id`).all(sid, at(h));

  // ── Generate the day (and the next, so tomorrow's rows exist and must not be pulled) ──
  setNow(dayStart - 3600);
  await runGenerate(P, w, sid, [new FakeDate(dayStart * 1000), new FakeDate((dayStart + 86400) * 1000)]);
  // 1 — every row on the clock is placed, in every hour of both shows; rows past :00 belong to their hour
  for (const [h, clockName] of [[12, "Short clock"], [13, "Short clock"], [15, "Extra clock"], [16, "Extra clock"]]) {
    const rows = hourRows(h), want = clockRows(clockName);
    const past = rows.filter(r => r.scheduled_at >= at(h + 1)).length;
    check(1, rows.length === want, `${String(h).padStart(2, "0")}:00 hour: ${rows.length} of the ${clockName}'s ${want} rows placed${past ? `, ${past} of them timed past ${String(h + 1).padStart(2, "0")}:00 and still in the ${String(h).padStart(2, "0")}:00 hour` : ""}`);
  }
  // 2 — each song starts the segue overlap before the one before it ends
  {
    let n = 0, bad = 0;
    for (const h of [12, 13, 15, 16]) {
      const rows = hourRows(h);
      for (let i = 1; i < rows.length; i++) { n++; if (rows[i].scheduled_at - rows[i - 1].scheduled_at !== rows[i - 1].duration_s - overlapS) bad++; }
    }
    check(2, n > 0 && bad === 0, `${n - bad} of ${n} back-to-back songs start ${overlapS} s before the song before them ends (the station's segue overlap), ${bad} do not`);
    const r12 = hourRows(12);
    const lastEnd = r12.length ? r12[r12.length - 1].scheduled_at + r12[r12.length - 1].duration_s : null;
    out.hour12EndsAt = lastEnd ? fmt(lastEnd) : null;
  }

  // 4 — a row added by hand survives a regenerate (Generate keeps operator rows)
  const handInsert = (afterRow, title) => {
    const song = w.prepare("SELECT s.id, s.title, s.file_path, s.duration_ms FROM songs s JOIN categories c ON c.id = s.category_id WHERE c.station_id = ? AND s.title = ?").get(sid, title);
    // as the engine writes it (engine.js _writeOperatorLogRow, the Up Next add): right after the row it follows, in that row's hour
    const r = w.prepare(`INSERT INTO generated_schedule (scheduled_at, song_id, title, artist, file_path, duration_s, station_id, uuid, state, source, content_class, created_at, updated_at, log_hour_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'operator', 'MUSIC', ?, ?, ?)`)
      .run(afterRow.scheduled_at + 1, song.id, song.title, "Through Artist", song.file_path, Math.round(song.duration_ms / 1000), sid, require("crypto").randomUUID(), new RealDate().toISOString(), new RealDate().toISOString(), afterRow.lk);
    return Number(r.lastInsertRowid);
  };
  const keepRow = hourRows(16)[5];
  const keptId = handInsert(keepRow, "Through Song 44");
  setNow(at(10));
  await runGenerate(P, w, sid, [new FakeDate(dayStart * 1000)]);
  const kept = w.prepare("SELECT state, deleted_at, source FROM generated_schedule WHERE id = ?").get(keptId);
  check(4, kept && !kept.deleted_at && kept.state === "pending", `a row added by hand in the 16:00 hour, then a regenerate: ${kept ? (kept.deleted_at ? "DELETED" : "kept, " + kept.state) : "GONE"}`);

  // 4 + 3 — a row added by hand right after the song that will cross 16:00 (the Extra clock overruns the hour)
  const r15 = hourRows(15);
  const crossing = r15.find(r => r.scheduled_at < at(16) && r.scheduled_at + r.duration_s > at(16));
  const handId = crossing ? handInsert(crossing, "Through Song 45") : null;

  // ── air it, 11:55 → 18:00 ──
  const goLives = [];
  let lastRow = null, fromPieceStart = false, prevEnd = null, guard = 0;
  setNow(at(11, 55));
  while (nowSec() < at(18) && guard++ < 5000) {
    const opts = { seamTs: nowSec(), onAirRowId: lastRow, ...(fromPieceStart ? { fromPieceStart: true } : {}) };
    let r = P.loggen.readLogAnchored(w, sid, 20, undefined, opts);
    for (let k = 0; k < 10 && r.mode === "skipping"; k++) {
      for (const sk of (r.skip || [])) w.prepare("UPDATE generated_schedule SET state='skipped' WHERE id=? AND state='pending'").run(sk.rowId);
      r = P.loggen.readLogAnchored(w, sid, 20, undefined, opts);
    }
    if (!r.items.length) {
      if (!r.inShow && lastRow != null) { lastRow = null; fromPieceStart = true; }   // AUTO off; on at the next show
      const hEnd = (() => { const x = new FakeDate(nowSec() * 1000); x.setMinutes(0, 0, 0); return Math.floor(x.getTime() / 1000) + 3600; })();
      const nxt = r.nextDueTs && r.nextDueTs > nowSec() ? Math.min(r.nextDueTs, hEnd) : hEnd;
      setNow(Math.max(nowSec() + 1, prevEnd && prevEnd > nowSec() ? Math.min(prevEnd, nxt) : nxt));
      continue;
    }
    if (r.missedRowIds.length) {
      const ph = r.missedRowIds.map(() => "?").join(",");
      w.prepare(`UPDATE generated_schedule SET state='missed' WHERE id IN (${ph}) AND station_id=? AND state='pending' AND ${P.loggen.notOperatorSql("generated_schedule")}`).run(...r.missedRowIds, sid);
    }
    const item = r.items[0];
    const t = nowSec();
    const durS = Math.round((item.durationMs || 0) / 1000);
    P.playlog.recordGoLive(w.raw, { stationId: sid, title: item.title, artist: item.artist, deck: "A", durationMs: durS * 1000, sessionId: "scheduler-gate-t20", filePath: item.filePath, contentClass: item.contentClass, rowId: item.schedId, playedAt: t });
    const row = w.prepare(`SELECT id, scheduled_at, ${lkSql} AS lk, source FROM generated_schedule WHERE id = ?`).get(item.schedId);
    goLives.push({ t, end: t + durS, id: item.schedId, lk: row.lk, source: row.source, title: item.title });
    lastRow = item.schedId; fromPieceStart = false; prevEnd = t + durS;
    setNow(t + durS - overlapS);
  }
  out.goLives = goLives.length;
  const first = (h) => goLives.find(g => g.lk === at(h));
  const lastOfHour = (h) => [...goLives].reverse().find(g => g.lk === at(h));

  // 7a / 6 — the 12:00 hour ends early because of the overlays: the 13:00 head plays straight on, no silence
  {
    const head = first(13), before = head ? goLives[goLives.indexOf(head) - 1] : null;
    const gap = head && before ? head.t - before.end : null;
    check(7, head && before && before.lk === at(12) && gap <= 0 && head.t < at(13),
      head ? `12:00 hour's last song ends ${fmt(before.end)}; the 13:00 hour's first row starts ${fmt(head.t)} (${gap <= 0 ? -gap + " s overlap, no silence" : gap + " s of SILENCE"})` : "the 13:00 hour's first row never aired");
    let silences = 0;
    for (let i = 1; i < goLives.length; i++) { const g = goLives[i], p = goLives[i - 1]; if (g.t < at(14) && g.t > p.end) silences++; }
    check(6, silences === 0, `inside the Through Show (12:00–14:00) the log never waited: ${silences} silences between rows`);
  }
  // 7b — a show's last row ends and nothing plays after the show (before the next show, nor after the last one)
  {
    const lastA = lastOfHour(13);
    const between = goLives.filter(g => lastA && g.t >= lastA.end && g.t < at(15));
    check(7, lastA && between.length === 0, `the Through Show's last row ends ${lastA ? fmt(lastA.end) : "?"}; ${between.length} rows aired before the Extra Show at 15:00`);
    const lastB = [...goLives].reverse().find(g => g.t < at(17));
    const after = goLives.filter(g => lastB && g.t >= lastB.end);
    check(7, lastB && after.length === 0, `the Extra Show's last song (started ${lastB ? fmt(lastB.t) : "?"}) ends ${lastB ? fmt(lastB.end) : "?"}; ${after.length} rows aired after it (tomorrow's rows are in the log)`);
  }
  // 3 + 4 — the song crossing 16:00 plays out; the hand-added row after it plays; the 15:00 hour's other rows are
  // didn't-air (missed, not deleted); the 16:00 head follows
  {
    const crossed = goLives.find(g => g.lk === at(15) && g.t < at(16) && g.end > at(16));
    const i = crossed ? goLives.indexOf(crossed) : -1;
    const next1 = i >= 0 ? goLives[i + 1] : null, next2 = i >= 0 ? goLives[i + 2] : null;
    check(4, crossed && next1 && next1.id === handId, crossed ? `the song on air at 16:00 ("${crossed.title}", ${fmt(crossed.t)}–${fmt(crossed.end)}) is followed by the row added by hand: ${next1 ? (next1.id === handId ? "yes" : `no — "${next1.title}"`) : "nothing"}` : "no song crossed 16:00");
    check(3, next2 && next2.id === (hourRows(16)[0] || {}).id, `then the 16:00 hour's first row: ${next2 ? (next2.lk === at(16) ? `"${next2.title}"` : `NO — "${next2.title}" of another hour`) : "nothing"}`);
    const left = hourRows(15).filter(r => r.source !== "operator" && !goLives.some(g => g.id === r.id));
    const notMissed = left.filter(r => r.state !== "missed" || r.deleted_at);
    check(3, left.length > 0 && notMissed.length === 0, `the 15:00 hour's ${left.length} rows that did not air: ${left.length - notMissed.length} marked didn't-air (missed), ${notMissed.filter(r => r.deleted_at).length} deleted, ${notMissed.filter(r => !r.deleted_at).length} left pending`);
    const hand = w.prepare("SELECT state, deleted_at FROM generated_schedule WHERE id = ?").get(handId);
    check(4, hand && hand.state === "played" && !hand.deleted_at, `the row added by hand: ${hand ? hand.state : "GONE"}`);
    const keptAfter = w.prepare("SELECT state, deleted_at FROM generated_schedule WHERE id = ?").get(keptId);
    check(4, keptAfter && !keptAfter.deleted_at && keptAfter.state !== "missed", `the row added by hand in the 16:00 hour after the regenerate: ${keptAfter ? keptAfter.state : "GONE"} (never 'missed')`);
  }
  out.pass = out.checks.every(c => c.pass);
  return out;
}

// ── T11 (history part): what this machine's own record says, last 7 days ─────────────────────────
function historyRecord(w, F, sinceTs) {
  const sid = F.sid;
  const plays = w.prepare("SELECT id, played_at, content_class, scheduled_log_id, category_code, file_path, session_id FROM play_log WHERE station_id=? AND deleted_at IS NULL AND played_at >= ?").all(sid, sinceTs);
  if (!plays.length) return { station: sid, plays: 0 };
  const hours = new Set(plays.map(p => Math.floor(p.played_at / 3600))).size;
  const byClass = countBy(plays, "content_class");
  const unlinked = plays.filter(p => p.scheduled_log_id == null).length;
  const noCat = plays.filter(p => isMusicPlay(p) && p.category_code == null).length;
  // log rows stamped played/playing with no play within 10 s of their stamp
  const stamped = w.prepare("SELECT id, played_at, content_class, file_key, title FROM generated_schedule WHERE station_id=? AND deleted_at IS NULL AND state IN ('played','playing') AND played_at >= ?").all(sid, sinceTs);
  const playTimes = plays.map(p => p.played_at).sort((a, b) => a - b);
  const near = (t) => { let lo = 0, hi = playTimes.length; while (lo < hi) { const m = (lo + hi) >> 1; if (playTimes[m] < t - 10) lo = m + 1; else hi = m; } return lo < playTimes.length && playTimes[lo] <= t + 10; };
  const stampedNoPlay = stamped.filter(r => !near(r.played_at)).length;
  // sweepers that aired (play_log SWP/JIN) vs sweeper rows ever stamped
  const swpPlays = plays.filter(p => p.content_class === "SWP" || p.content_class === "JIN").length;
  const swpStamped = w.prepare("SELECT count(*) n FROM generated_schedule WHERE station_id=? AND deleted_at IS NULL AND content_class IN ('SWP','JIN') AND state IN ('played','playing') AND scheduled_at >= ?").get(sid, sinceTs).n;
  const swpRows = w.prepare("SELECT count(*) n FROM generated_schedule WHERE station_id=? AND deleted_at IS NULL AND content_class IN ('SWP','JIN') AND scheduled_at >= ? AND scheduled_at < ?").get(sid, sinceTs, Math.floor(RealDate.now() / 1000)).n;
  // the same log row stamped twice cannot be seen (one played_at); a row aired twice shows as two plays
  // of its file within its own length while the row was 'playing' — counted as consecutive same-file plays
  const sameFileBackToBack = (() => { const ps = plays.filter(isMusicPlay).sort((a, b) => a.played_at - b.played_at); let n = 0; for (let i = 1; i < ps.length; i++) if (ps[i].file_path && ps[i].file_path === ps[i - 1].file_path && ps[i].played_at - ps[i - 1].played_at < 1800) n++; return n; })();
  return { station: sid, window: `${fmt(sinceTs)} → now`, plays: plays.length, hoursWithPlays: hours, byClass, playsWithoutLogRowId: unlinked, musicPlaysWithoutCategory: noCat,
    logRowsStampedWithNoPlayWithin10s: stampedNoPlay, sweeperPlays: swpPlays, sweeperRowsInLog: swpRows, sweeperRowsStampedAired: swpStamped, sameSongReairedWithin30Min: sameFileBackToBack };
}

// ── T15 / T16: static, on the tree ────────────────────────────────────────────────────────────────
function staticChecks() {
  const files = {
    "electron/generate-core.js": null, "audiod/loggen.js": null, "audiod/scheduler-core.js": null,
    "electron/separation-enforce.js": null, "audiod/engine.js": null, "src/audio/loggen.ts": null,
    "src/audio/separationEnforce.ts": null, "electron/library-health.js": null,
    // (the repo-root loggen.js is a one-off patcher script that writes source, not a picker: not scanned)
  };
  for (const f of Object.keys(files)) { try { files[f] = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { files[f] = null; } }
  const hits = (re, only) => {
    const out = [];
    for (const [f, src] of Object.entries(files)) {
      if (!src || (only && !only.includes(f))) continue;
      src.split(/\r?\n/).forEach((line, i) => { if (re.test(line) && !/^\s*(\/\/|\*)/.test(line)) out.push(`${f}:${i + 1}`); });
    }
    return out;
  };
  const pickFiles = ["electron/generate-core.js", "audiod/loggen.js", "audiod/scheduler-core.js", "electron/separation-enforce.js"];
  const t15 = {
    settingsRegistry: fs.existsSync(path.join(ROOT, "electron", "settings-registry.js")) ? "present" : "ABSENT — no registry exists, so no key the pick reads is registered",
    enforceSeparationRead: hits(/enforce_separation/, pickFiles),
    lastPlayedAtReadByPick: hits(/\b(song|s)\.last_played_at\b/, ["electron/generate-core.js", "audiod/scheduler-core.js"]),
    maxSameCategoryRead: hits(/max_same_category/, pickFiles),
    noRepeatHoursRead: hits(/no_repeat_hours/, pickFiles),
    isHardRead: hits(/is_hard/, pickFiles),
    breakLengthFit: hits(/fitTargetTs|FIT_WINDOW_S|FIT_TOL_S/, ["electron/generate-core.js", "electron/separation-enforce.js"]),
    bakedRuleDefaults: hits(/artistSepMin\s*=\s*\d|songRepeatMin\s*=\s*\d|titleSepMin\s*=\s*\d|'artist_separation_min',\s*\d|'song_separation_min',\s*\d|'title_separation_min',\s*\d|no_repeat_hours,\s*\d|\|\|\s*60\)\s*\*\s*60/, pickFiles),
    bakedTimingNumbers: hits(/slackSec\s*=\s*\d|scheduled_at\s*>=\s*\?\s*-\s*\d|FIT_TOL_S\s*=|FIT_WINDOW_S\s*=|STALL_MS\s*=\s*\d|duration_min\s*\|\|\s*4|length_sec\s*\|\|\s*30|defaultDurS\s*=\s*\d/, null),
  };
  // NOTHING READS songs.last_played_at (Jeff, 2026-10-18: "leave it unwritten AND remove every read of it. Every 'last
  // aired' shown anywhere is derived from the play record. Add to the gate: nothing reads last_played_at"). Every
  // mention in the product (electron/, audiod/, src/, tests and smoke fixtures excepted) must be on this list, which
  // names the OTHER table it belongs to; anything else is a finding, with its file and line.
  const LP_ALLOW = [
    [/^electron[\/]sync[\/]/, null, "sync registry / handlers copy the column between machines (no reader; songsMarkPlayed has no caller)"],
    [/^electron[\/]generate-core\.js$/, /SPOT_SELECT|FROM spots|\bsp\.last_played_at|length_sec, last_played_at, max_plays_day/, "spots.last_played_at (spot rotation)"],
    [/^electron[\/]main\.js$/, /ALTER TABLE songs ADD COLUMN last_played_at|announcement|row\.last_played_at|s\.last_played_at AS last_played_at/, "the column's creation, and announcements / announcement_schedule"],
    [/^audiod[\/]playlog\.js$/, /UPDATE spots/, "spots accounting"],
    [/^src[\/]components[\/]Announcements\.tsx$/, null, "announcement_schedule lines"],
    [/^src[\/]lib[\/]ccData\.ts$/, null, "announcement_schedule lines (the Park page's mirror)"],
  ];
  const lpHits = [];
  const walk = (dir) => { let out = []; for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") out = out.concat(walk(rel)); }
    else if (/\.(js|ts|tsx)$/.test(e.name) && !/\.test\.|^smoke-/.test(e.name)) out.push(rel);
  } return out; };
  for (const rel of [...walk("electron"), ...walk("audiod"), ...walk("src")]) {
    let src; try { src = fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { continue; }
    if (!src.includes("last_played_at")) continue;
    src.split(/\r?\n/).forEach((line, i) => {   // CRLF checkouts too: `.` stops at \r, so `//.*$` kept a trailing comment
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;              // a comment line
      const code = line.replace(/\/\/.*$/, "");                       // a trailing comment
      if (!code.includes("last_played_at")) return;
      const relN = rel.replace(/\\/g, "/");                            // one slash, on every OS
      const ok = LP_ALLOW.some(([f, l]) => f.test(relN) && (!l || l.test(code)));
      if (!ok) lpHits.push(`${rel.replace(/\\/g, "/")}:${i + 1}`);
    });
  }
  t15.songsLastPlayedRead = lpHits;
  t15.markPlayedCallers = hits(/\.markPlayed\(/, null);
  t15.findings = t15.songsLastPlayedRead.length + t15.markPlayedCallers.length + t15.enforceSeparationRead.length + t15.lastPlayedAtReadByPick.length + t15.maxSameCategoryRead.length + t15.noRepeatHoursRead.length
    + t15.breakLengthFit.length + t15.bakedRuleDefaults.length + t15.bakedTimingNumbers.length + (t15.settingsRegistry.startsWith("ABSENT") ? 1 : 0) + (t15.isHardRead.length ? 0 : 1);
  t15.isHardNote = t15.isHardRead.length ? "is_hard is read" : "is_hard (STRICT) is read by NO picker — the STRICT button decides nothing";

  const t16 = {
    orderByRandom: hits(/ORDER BY RANDOM\(\)/i, null),
    pickers: {
      "scheduler-core: the one pick": hits(/^function pick\(/, ["audiod/scheduler-core.js"]),
      "generate-core: a picker of its own (first compliant / LRP fallback / ORDER BY RANDOM)": hits(/function _legacyPickMusic|function _lrpFallback|ORDER BY RANDOM|stmtCandidates/, ["electron/generate-core.js"]),
      "separation-enforce: pickEnforced": hits(/function pickEnforced/, ["electron/separation-enforce.js"]),
      "loggen (daemon): pickFromClock / pickTier / fillQueueEnforced / ORDER BY RANDOM": hits(/function pickFromClock|function pickTier|function fillQueueEnforced|ORDER BY RANDOM/, ["audiod/loggen.js"]),
      "src/audio/loggen.ts (renderer)": files["src/audio/loggen.ts"] ? hits(/ORDER BY RANDOM|function pick/i, ["src/audio/loggen.ts"]) : [],
      "src/audio/separationEnforce.ts (renderer)": files["src/audio/separationEnforce.ts"] ? hits(/function pick|export function/i, ["src/audio/separationEnforce.ts"]) : [],
    },
  };
  t16.modulesThatChooseSongs = Object.values(t16.pickers).filter(a => a.length).length;
  return { T15: t15, T16: t16 };
}

function countBy(arr, k) { const m = {}; for (const x of arr) { const v = x[k] == null ? "null" : String(x[k]); m[v] = (m[v] || 0) + 1; } return m; }

// ── pass / fail ───────────────────────────────────────────────────────────────────────────────────
function verdicts(sim, t5, t10, hist, stat, t20 = []) {
  const v = [];
  const add = (t, pass, line) => v.push({ test: t, pass, line });
  for (const t of t20) if (t) for (const c of t.checks) add("T20", c.pass, `station ${t.station} (rule ${c.rule}): ${c.line}`);
  for (const s of sim) {
    const st = `station ${s.station}`;
    add("T1", s.T1_onAir.violations === 0 && s.T1_inLog.violations === 0, `${st}: ${s.T1_onAir.violations} separation violations on air, ${s.T1_inLog.violations} in the log (${JSON.stringify(s.T1_onAir.byRule)} / ${JSON.stringify(s.T1_inLog.byRule)})`);
    add("T2", s.T2.placedBreakingARule === 0 && s.T2.notTheLongestWaiting === 0, `${st}: of ${s.T2.checked} picks, ${s.T2.placedBreakingARule} broke a rule and ${s.T2.notTheLongestWaiting} were not the longest-waiting song (of those that passed, or of the whole category where none passed); ${s.T2.unscheduledSlots} slots UNSCHEDULED (empty category), ${s.T2.slotsWhereNothingPassedLeastRecentWentIn} slots had no passing song and got the least recently played`);
    add("T3", s.T3.failures === 0, `${st}: ${s.T3.failures} go-lives pushed a category past spread 1 while a lower-count song was free (D1 exceptions: ${s.T3.d1Exceptions}); worst spread ${Math.max(0, ...s.T3.maxSpreadByCategory.map(c => c.maxSpread))}`);
    add("T4", s.T4.deleted === 0 && s.T4.changed === 0, `${st}: of ${s.T4.nonPendingRowsSnapshotted} non-pending rows, Generate deleted ${s.T4.deleted} and changed ${s.T4.changed}`);
    add("T8", s.T8.rowsAiredBeforeTheirHour === 0, `${st}: ${s.T8.rowsAiredBeforeTheirHour} of ${s.T8.goLives} go-lives aired a row before its hour began outside its own show and day (up to ${s.T8.maxAheadMin} min early); ${s.T8.offLogPlays} off-log floor plays`);
    add("T11", s.T11_sim.playsWithoutLogRowId === 0 && s.T11_sim.musicPlaysWithoutCategory === 0, `${st} (simulated): ${s.T11_sim.playsWithoutLogRowId} of ${s.T11_sim.logPlays ?? s.T11_sim.plays} plays from log rows carry no link to their row, ${s.T11_sim.musicPlaysWithoutCategory} music plays no category`);
    if (s.T18.timedBreaksAired === 0) add("T18", null, `station ${s.station}: not applicable — this station's clocks have no timed breaks`);
    else add("T18", s.T18.outsideTolerance === 0, `${st}: ${s.T18.outsideTolerance} of ${s.T18.timedBreaksAired} timed breaks started outside ±${BREAK_TOL_S} s; of the ${s.T18.airedInOwnHour} aired inside their own hour, ${s.T18.inOwnHourOutsideTolerance} were off (up to ${s.T18.inOwnHourMaxLateSec} s late, ${s.T18.inOwnHourMaxEarlySec} s early)`);
  }
  for (const h of hist) if (h.plays) add("T11", h.playsWithoutLogRowId === 0 && h.musicPlaysWithoutCategory === 0 && h.logRowsStampedWithNoPlayWithin10s === 0, `station ${h.station} (this machine's record, ${h.window}, ${h.hoursWithPlays} hours with plays): ${h.playsWithoutLogRowId}/${h.plays} plays without a log row id, ${h.musicPlaysWithoutCategory} music plays without category, ${h.logRowsStampedWithNoPlayWithin10s} rows stamped aired with no play, ${h.sweeperPlays} sweeper plays vs ${h.sweeperRowsStampedAired} sweeper rows stamped`);
  for (const s of sim) if (s.T19) add("T19", s.T19.medianMs <= s.T19.limitMs, `station ${s.station}: the reader takes ${s.T19.medianMs} ms a call (median of ${s.T19.runs || 1} runs: ${(s.T19.runMediansMs || [s.T19.medianMs]).join(" / ")} ms; slowest call ${s.T19.maxMs} ms; ${s.T19.generatedScheduleRows} log rows) against a limit of ${s.T19.limitMs} ms, inside the ${s.T19.pollIntervalMs} ms air loop`);
  for (const t of t5) add("T5", t.inShowAt1225 ? t.startedAt1225 : t.eveningRowsAiredBefore3PM === 0,
    t.inShowAt1225
      ? `station ${t.station}: automation at 12:25 INSIDE its show, the log starting at 3 PM — rule 2: the next row plays at once (${t.startedAt1225 ? "started 12:25, no wait" : "it WAITED"}; ${t.eveningRowsAiredBefore3PM} rows aired before 3 PM)`
      : `station ${t.station}: automation at 12:25 with no show on, the log starting at 3 PM — ${t.eveningRowsAiredBefore3PM} evening rows aired before 3 PM (of ${t.eveningRowsInLog})`);
  for (const t of t10) if (t.ran) add("T10", !t.violatorAirsNext, `station ${t.station}: "${t.song}" placed again right after it aired (song rule ${t.songRuleMin} min) — ${t.violatorAirsNext ? `the reader AIRS it next, ${t.gapMin} min after it aired` :"not aired: the reader chose " + t.readerChose}`);
  if (stat) add("T15", stat.T15.findings === 0, `${stat.T15.findings} findings: registry ${stat.T15.settingsRegistry.split(" ")[0]}; songs.last_played_at read at ${stat.T15.songsLastPlayedRead.length} places${stat.T15.songsLastPlayedRead.length ? " (" + stat.T15.songsLastPlayedRead.slice(0, 4).join(", ") + ")" : ""}; enforce_separation read at ${stat.T15.enforceSeparationRead.length} places; last_played_at by the pick at ${stat.T15.lastPlayedAtReadByPick.length}; no_repeat_hours at ${stat.T15.noRepeatHoursRead.length}; max_same_category at ${stat.T15.maxSameCategoryRead.length}; break length fit at ${stat.T15.breakLengthFit.length}; baked rule defaults at ${stat.T15.bakedRuleDefaults.length}; baked timing numbers at ${stat.T15.bakedTimingNumbers.length}; ${stat.T15.isHardNote}`);
  if (stat) add("T16", stat.T16.modulesThatChooseSongs === 1 && stat.T16.orderByRandom.length === 0, `${stat.T16.modulesThatChooseSongs} modules choose songs; ORDER BY RANDOM() at ${stat.T16.orderByRandom.length} places`);
  return v;
}

function ratchetMetrics(sim, stat) {
  const m = stat ? { static: { T15_findings: stat.T15.findings, T16_pickers: stat.T16.modulesThatChooseSongs, T16_random: stat.T16.orderByRandom.length } } : {};
  for (const s of sim) m["station:" + s.uuid] = {
    T1_onAir: s.T1_onAir.violations, T1_inLog: s.T1_inLog.violations, T2_breaking: s.T2.placedBreakingARule, T2_notLongest: s.T2.notTheLongestWaiting,
    T3_failures: s.T3.failures, T4_touched: s.T4.deleted + s.T4.changed, T8_ahead: s.T8.rowsAiredBeforeTheirHour, T11_unlinked: s.T11_sim.playsWithoutLogRowId, T18_off: s.T18.outsideTolerance,
  };
  return m;
}

// ── ratchet: merged one entry at a time, so a station that finished is never lost ───────────────
function ratchetMerge(entries) {
  let prev = null; try { prev = JSON.parse(fs.readFileSync(RATCHET_FILE, "utf8")); } catch {}
  const worse = [];
  if (prev && prev.metrics) for (const [k, obj] of Object.entries(entries)) for (const [mk, val] of Object.entries(obj)) {
    const was = prev.metrics[k] && prev.metrics[k][mk];
    if (was != null && val != null && val > was) worse.push(`${k} ${mk}: ${was} → ${val}`);
  }
  if (flag("--update-ratchet")) {
    const next = prev && prev.metrics ? prev : { note: "Scheduler gate ratchet: a worse number than this fails the gate. Lower is better. Written by --update-ratchet, one entry as each station finishes.", metrics: {} };
    // A RATCHET ONLY TIGHTENS: each metric keeps the better (lower) of what it held and what this run measured. A worse
    // run is reported above and never loosens the file.
    for (const [k, obj] of Object.entries(entries)) {
      const was = next.metrics[k] || {};
      const merged = { ...was };
      for (const [mk, val] of Object.entries(obj)) merged[mk] = (val == null) ? was[mk] ?? null : (was[mk] == null ? val : Math.min(was[mk], val));
      next.metrics[k] = merged;
    }
    next.writtenAt = new RealDate().toISOString(); next.days = DAYS; next.seed = SEED;
    fs.mkdirSync(path.dirname(RATCHET_FILE), { recursive: true });
    const tmp = RATCHET_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n"); fs.renameSync(tmp, RATCHET_FILE);
  }
  return worse;
}
const ORDER = ["T1", "T2", "T3", "T4", "T5", "T8", "T10", "T11", "T15", "T16", "T18", "T19", "T20"];
const table = (v) => ORDER.flatMap(t => v.filter(y => y.test === t).map(x => `${x.pass === null ? "N/A " : x.pass ? "PASS" : "FAIL"}  ${t.padEnd(4)} ${x.line}`)).join("\n");

// ── child: ONE station of ONE database ────────────────────────────────────────────────────────────
async function runChild() {
  const src = dbPaths[0], sid = ONLY_STATIONS[0];
  const tag = path.basename(path.dirname(src)) + "-st" + sid;
  const aPath = copyDb(src, tag + "-sim"), bPath = copyDb(src, tag + "-scen");
  const A = wrapDb(new DatabaseSync(aPath)), B = wrapDb(new DatabaseSync(bPath));
  seedSqlRandom(A.raw, SEED * 1000 + sid); seedSqlRandom(B.raw, SEED * 1000 + sid + 500);
  { const r = rng(SEED * 7919 + sid); Math.random = r; }
  { const n = A.prepare("SELECT MAX(played_at) t FROM play_log").get().t; const d = new RealDate((n || Math.floor(RealDate.now() / 1000)) * 1000); d.setHours(24, 0, 0, 0); ANCHOR = Math.floor(d.getTime() / 1000); }
  const out = { db: src, station: sid };
  try {
    const st = A.prepare("SELECT id, name, uuid FROM stations WHERE id=?").get(sid);
    const F = stationFacts(A, sid);
    console.log(`  station ${sid} ${st.name}: rules song ${F.rules.songMin ?? "off"} / artist ${F.rules.artistMin ?? "off"} / title ${F.rules.titleMin ?? "off"} min; per-song no-repeat-hours on ${F.songs.filter(x => !x.deleted_at && x.no_repeat_hours != null && F.clockCats.has(x.category_id)).length} songs`);
    // this machine's own record (T11) and the reader's call time (T19) are read before the copy is touched
    const hist = flag("--fixture") ? { station: sid, plays: 0 } : { ...historyRecord(A, F, Math.floor(RealDate.now() / 1000) - 7 * 86400), name: st.name };
    const t19 = measureReader(A, bindProduct(A), sid);
    // The copies only (a copy that is deleted afterwards needs no durability; ANALYZE changes plans, never
    // results; history rows > 2 days old that nothing decides from are removed — see the run report's model).
    for (const X of [A, B]) { X.exec("PRAGMA synchronous=OFF"); X.exec("PRAGMA journal_mode=MEMORY"); }
    const cut = ANCHOR - 2 * 86400;   // from the data anchor, so the same database trims the same rows
    for (const X of [A, B]) X.prepare("DELETE FROM generated_schedule WHERE state IS NOT NULL AND state != 'pending' AND scheduled_at < ?").run(cut);
    // The copies reach this tree's schema the way the app does on launch: main.js's own runMigrationChain, lifted and run
    // as-is (a database copied from an older build gets this build's migrations, e.g. v63's play columns and triggers).
    const chainLog = [];
    for (const X of [A, B]) {
      const runChain = liftFromMain("runMigrationChain", { path, __dirname: path.join(ROOT, "electron"), require: createRequire(path.join(ROOT, "electron", "main.js")), console: { log: (m) => chainLog.push(String(m)), error: (...m) => chainLog.push("ERROR " + m.join(" ")), warn: () => {} } });
      runChain(X);
    }
    if (chainLog.length) console.log("    migrations on the copies: " + [...new Set(chainLog)].slice(0, 4).join(" | "));
    if (!flag("--no-analyze")) { A.exec("ANALYZE"); B.exec("ANALYZE"); }
    const ts = RealDate.now();
    const r = await simulateStation(A, bindProduct(A), stationFacts(A, sid), []);
    r.name = st.name; r.uuid = st.uuid; r.T19 = t19;
    console.log(`    simulated ${r.goLives} go-lives in ${Math.round((RealDate.now() - ts) / 1000)} s (Generate ${r.generateSec} s, air ${r.airSec} s)`);
    const FB = stationFacts(B, sid);
    const t5 = await scenarioStartedEarly(B, bindProduct(B), FB);
    const t10 = await scenarioViolatorInLog(B, bindProduct(B), FB);
    const t20 = await scenarioPlaysThrough(B, bindProduct(B), FB, st.name);
    fakeNowMs = null;
    Object.assign(out, { name: st.name, uuid: st.uuid, sim: r, t5, t10, t20, hist });
  } finally {
    A.raw.close(); B.raw.close();
    if (!flag("--keep-copies")) { for (const p of [aPath, bPath]) { try { fs.rmSync(p); } catch {} } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
    else console.log(`    copies kept: ${aPath} ${bPath}`);
  }
  const v = verdicts([out.sim], [out.t5], [out.t10], [out.hist], null, [out.t20]);
  const worse = ratchetMerge(ratchetMetrics([out.sim], null));
  out.verdicts = v; out.ratchetWorse = worse;
  fs.writeFileSync(path.join(RUN_DIR, `station-${sid}.json`), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(RUN_DIR, `station-${sid}.txt`), `station ${sid} ${out.name} — ${r_window(out)}\n${table(v)}\n${worse.length ? "RATCHET worse: " + worse.join("; ") : "ratchet: nothing worse"}\n`);
  console.log(`    written: ${path.join(RUN_DIR, `station-${sid}.txt`)}`);
}
function r_window(o) { return o.sim ? o.sim.window : ""; }

// ── driver: static checks once, then one child process per station, in turn ─────────────────────
async function runDriver() {
  const t0 = RealDate.now();
  const stamp = new RealDate().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(ROOT, "dist-electron", "gate-logs", `scheduler-gate-${stamp}`);
  fs.mkdirSync(runDir, { recursive: true });
  console.log(`scheduler gate — ${new RealDate().toLocaleString()} — ${DAYS} days per station, seed ${SEED}, one station at a time`);
  console.log(`results folder: ${runDir}`);
  if (FIXTURE && !dbPaths.length) {
    const fx = require("./lib/gate-fixture");
    const fpath = path.join(TMP, "gate-fixture.db");
    const runChain = (X) => liftFromMain("runMigrationChain", { path, __dirname: path.join(ROOT, "electron"), require: createRequire(path.join(ROOT, "electron", "main.js")), console: { log() {}, error() {}, warn() {} } })(X);
    const built = fx.buildFixtureDb(fpath, { schemaFrom: SCHEMA_SOURCES[0] || null, migrate: runChain });
    console.log(`fixture database built (${built.schemaFrom}): ${built.stations.map(s => s.name).join(", ")}`);
    dbPaths.push(fpath);
  }
  if (!dbPaths.length) { console.log("NO DATABASE — nothing to test."); process.exit(2); }
  const stat = staticChecks();
  const sv = verdicts([], [], [], [], stat);
  const sworse = ratchetMerge({ static: { T15_findings: stat.T15.findings, T16_pickers: stat.T16.modulesThatChooseSongs, T16_random: stat.T16.orderByRandom.length } });
  fs.writeFileSync(path.join(runDir, "static.json"), JSON.stringify({ static: stat, verdicts: sv, ratchetWorse: sworse }, null, 2));
  fs.writeFileSync(path.join(runDir, "static.txt"), table(sv) + "\n");
  const { spawnSync } = require("child_process");
  const done = [];
  for (const src of dbPaths) {
    console.log(`\ndatabase: ${src}`);
    const ro = new DatabaseSync(src, { readOnly: true });
    const sts = ro.prepare("SELECT id, name FROM stations WHERE deleted_at IS NULL ORDER BY id").all().filter(s => !ONLY_STATIONS || ONLY_STATIONS.includes(s.id))
      .filter(s => { const n = ro.prepare("SELECT count(*) n FROM shows WHERE station_id=? AND is_active=1 AND deleted_at IS NULL AND clock_id IS NOT NULL").get(s.id).n; if (!n) console.log(`  station ${s.id} ${s.name}: no active show with a clock — skipped`); return n > 0; });
    ro.close();
    for (const st of sts) {
      const args = [__filename, "--child", "--db", src, "--stations", String(st.id), "--run-dir", runDir, "--days", String(DAYS), "--seed", String(SEED), "--reader-limit-ms", String(READER_LIMIT_MS), ...(FIXTURE ? ["--fixture"] : [])];
      for (const f of ["--update-ratchet", "--keep-copies", "--no-analyze"]) if (flag(f)) args.push(f);
      const r = spawnSync(process.execPath, ["--no-warnings", ...args], { stdio: "inherit" });
      if (r.status !== 0 && r.status !== 1) console.log(`  station ${st.id}: the station's run ended with code ${r.status}${r.signal ? " (" + r.signal + ")" : ""} — its results were not written`);
      done.push(st.id);
    }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  // the summary is assembled from what is on disk, so it is the same whether or not a station was lost
  const all = [...sv]; const worse = [...sworse]; const parts = [];
  for (const f of fs.readdirSync(runDir).filter(f => /^station-\d+\.json$/.test(f))) {
    const o = JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")); all.push(...o.verdicts); worse.push(...o.ratchetWorse); parts.push(o.station);
  }
  const missing = done.filter(id => !parts.includes(id));
  const summary = `${table(all)}\n\nnot run in Phase 0 (need the engine or a scenario not yet built): T6, T7, T9, T12, T13, T13a, T14, T10's replay and stall parts\n` +
    (missing.length ? `\nSTATIONS WITH NO RESULTS (their run stopped): ${missing.join(", ")}\n` : "") +
    (worse.length ? `\nRATCHET — worse than the last recorded run:\n  ${worse.join("\n  ")}\n` : `\nratchet: nothing worse${flag("--update-ratchet") ? " (entries written as each station finished)" : ""}\n`);
  fs.writeFileSync(path.join(runDir, "summary.txt"), summary);
  console.log("\n══ RESULTS ══\n" + summary);
  console.log(`results folder: ${runDir}\ntook ${Math.round((RealDate.now() - t0) / 1000)} s`);
  process.exit(all.some(x => x.pass === false) || worse.length || missing.length ? 1 : 0);
}

(CHILD ? runChild() : runDriver()).then(() => { if (CHILD) process.exit(0); }).catch(e => { console.error("GATE ERROR:", e && e.stack || e); fakeNowMs = null; process.exit(2); });
