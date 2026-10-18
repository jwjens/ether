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
if (!dbPaths.length) {
  const prof = path.join(process.env.LOCALAPPDATA || "", "Ether", "profiles");
  try {
    for (const d of fs.readdirSync(prof)) {
      if (d.includes(".retired") || d.startsWith("_")) continue;
      const f = path.join(prof, d, "openair.db");
      if (fs.existsSync(f)) dbPaths.push(f);
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
const nowSec = () => Math.floor(FakeDate.now() / 1000);
global.Date = FakeDate;

// seeded RNG for song-length error (Generate's own ORDER BY RANDOM() is not seedable; reported)
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
            s.content_class, s.deleted_at, s.no_repeat_hours, s.created_at
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
      songId: s.id, rec: C.recordingKey(s.file_path || s.file_key), artists: split(s.artist), title: C.normaliseTitle(s.title), name: s.title,
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
  return C.makeEvent({ ts: p.played_at, file: p.file_path, artist: s ? s.artist : p.artist, title: s ? s.title : p.title, kind: "aired", ref: "p" + p.id, songId: s ? s.id : null, noRepeatHours: s ? s.no_repeat_hours : null }, F.split);
}
function rowEvent(F, r) {
  const s = r.song_id != null ? F.byId.get(r.song_id) : null;
  return C.makeEvent({ ts: r.scheduled_at, file: r.file_key || r.file_path || (s && (s.file_path || s.file_key)), artist: s ? s.artist : r.artist, title: s ? s.title : r.title, kind: "log", ref: "r" + r.id, categoryId: r.category_id, songId: r.song_id, noRepeatHours: s ? s.no_repeat_hours : null }, F.split);
}
const isMusicRow = (r) => r.song_id != null && (r.content_class == null || r.content_class === "MUSIC");
const isMusicPlay = (p) => p.content_class == null || p.content_class === "MUSIC";
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
  return { gen, loggen, playlog, commitDayRows, retireStale };
}

// Generate, the way schedule:generateDays / generateDay run it (main.js:11437-11555): one ctx across the
// range, each day hour by hour from effStart = max(dayStart, next top of hour), committed per day.
async function runGenerate(P, w, sid, dayBases) {
  const genTs = nowSec();
  const ctx = P.gen.buildScheduleCtx(w, sid);
  const committed = [];
  for (const dayBase of dayBases) {
    const dayStart = Math.floor(dayBase.getTime() / 1000), dayEnd = dayStart + 86400;
    const effStart = Math.max(dayStart, Math.ceil(genTs / 3600) * 3600);
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
  const simStart = Math.ceil(RealDate.now() / 1000 / 3600) * 3600;
  const simEnd = simStart + DAYS * 86400;
  setNow(simStart);

  // history the rules measure against (MUSIC plays from 2 days before the run)
  const histPlays = w.prepare("SELECT id, title, artist, file_path, played_at, content_class FROM play_log WHERE station_id=? AND deleted_at IS NULL AND played_at >= ? AND played_at < ? ORDER BY played_at").all(sid, simStart - 2 * 86400, simStart);

  const runs = [];
  const t4 = { snapshots: 0, changed: [], deleted: [] };
  const genRows = (genTs) => w.prepare("SELECT * FROM generated_schedule WHERE station_id=? AND generated_at=? AND deleted_at IS NULL ORDER BY scheduled_at, id").all(sid, genTs);
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
    runs.push({ label, genTs: g.genTs, rows: genRows(g.genTs), relaxed: g.ctx.relaxed.length, breakDrift: g.ctx.breakDrift.length, enforce: g.ctx.enforceSeparation });
    return g;
  };

  const tg0 = RealDate.now();
  await doGenerate(DAYS + 1, "Generate week");
  const genMs = RealDate.now() - tg0; const ta0 = RealDate.now();

  // ── air it ──
  const goLives = [];
  let floorPlays = 0, missedStamped = 0, regenDone = false;
  const prof = { reader: 0, logPlay: 0, stamp: 0 };
  const regenTs = (() => { const d = new FakeDate(simStart * 1000); d.setDate(d.getDate() + REGEN_AT.day); d.setHours(REGEN_AT.hour, REGEN_AT.minute, 0, 0); let t = Math.floor(d.getTime() / 1000); if (t < simStart) t += 86400; return t; })();
  let guard = 0;
  while (nowSec() < simEnd && guard++ < 200000) {
    if (!regenDone && nowSec() >= regenTs) { regenDone = true; await doGenerate(1, "Regenerate on air " + fmt(nowSec())); }
    let tq = RealDate.now();
    const r = P.loggen.readLogAnchored(w, sid, 20);
    prof.reader += RealDate.now() - tq;
    let item = null, offLog = false;
    if (r.mode === "exhausted" || r.mode === "error" || !r.items.length) {
      const fill = P.loggen.fillQueue(w, sid, 20);
      item = fill.items && fill.items[0];
      offLog = true;
      if (!item) { setNow(nowSec() + 60); continue; }      // starved: a minute of silence, then retry
      floorPlays++;
    } else {
      if (r.missedRowIds.length) {
        const ph = r.missedRowIds.map(() => "?").join(",");
        // engine.js:1445, verbatim
        const info = w.prepare(`UPDATE generated_schedule SET state='missed' WHERE id IN (${ph}) AND station_id=? AND state='pending'`).run(...r.missedRowIds, sid);
        missedStamped += Number(info.changes || 0);
      }
      item = r.items[0];
    }
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
    const row = item.schedId != null ? w.prepare("SELECT id, scheduled_at, category_id, clock_id, content_class, song_id FROM generated_schedule WHERE id=?").get(item.schedId) : null;
    prof.stamp += RealDate.now() - tq;
    goLives.push({ ts: t, schedId: item.schedId ?? null, row, title: item.title, filePath: item.filePath, contentClass: item.contentClass || (row && row.content_class) || "MUSIC", offLog, mode: r.mode, playUuid: playId });
    setNow(t + actualS);
  }

  // ── check ──
  const res = { station: F.sid, window: `${fmt(simStart)} → ${fmt(simEnd)}`, generateSec: Math.round(genMs / 1000), airSec: Math.round((RealDate.now() - ta0) / 1000), airProfileMs: prof, goLives: goLives.length, floorPlays, missedStamped, runs: runs.map(r => ({ label: r.label, rows: r.rows.length, relaxedByGenerate: r.relaxed, breakDriftByGenerate: r.breakDrift, enforceSeparation: r.enforce })) };

  // on-air timeline: history + simulated plays (MUSIC)
  const simPlays = w.prepare("SELECT id, title, artist, file_path, played_at, content_class, scheduled_log_id, category_code FROM play_log WHERE station_id=? AND session_id='scheduler-gate' ORDER BY played_at, id").all(sid);
  const air = new C.Timeline();
  for (const p of histPlays) if (isMusicPlay(p)) air.add(playEvent(F, p));
  const simEvents = [];
  for (const p of simPlays) if (isMusicPlay(p)) { const ev = playEvent(F, p); air.add(ev); simEvents.push(ev); }

  // T1 on air: every simulated play against what aired before it
  const t1Air = [];
  for (const ev of simEvents) for (const b of C.breaches(air, ev, F.rules, { sides: "before" })) t1Air.push({ at: fmt(ev.ts), rule: b.rule, key: b.key, measuredMin: b.measuredMin, settingMin: b.settingMin });
  res.T1_onAir = { violations: t1Air.length, byRule: countBy(t1Air, "rule"), examples: t1Air.slice(0, 8) };

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
    const kept = w.prepare("SELECT * FROM generated_schedule WHERE station_id=? AND deleted_at IS NULL AND state='pending' AND scheduled_at >= ? AND scheduled_at < ? AND (generated_at IS NULL OR generated_at != ?)").all(sid, run.genTs - 4 * 3600, run.genTs + (DAYS + 2) * 86400, run.genTs);
    for (const k of kept) if (isMusicRow(k) && !runIds.has(k.id)) tl.add(rowEvent(F, k));
    // full log after the commit for the T1 in-log check
    const full = new C.Timeline();
    for (const p of allPlaysAt.all(sid, run.genTs - 2 * 86400, run.genTs)) if (isMusicPlay(p)) full.add(playEvent(F, p));   // rules reach ≤ 1 day
    for (const k of kept) if (isMusicRow(k)) full.add(rowEvent(F, k));
    const runEvents = run.rows.filter(isMusicRow).map(r => [r, rowEvent(F, r)]);
    for (const [, ev] of runEvents) full.add(ev);
    for (const [, ev] of runEvents) for (const b of C.breaches(full, ev, F.rules)) {
      const pair = [ev.ref, b.other.ref].sort().join("~") + "|" + b.rule + "|" + b.key;
      if (!t1Log.has(pair)) t1Log.set(pair, { at: fmt(Math.min(ev.ts, b.other.ts)), rule: b.rule, key: b.key, measuredMin: b.measuredMin, settingMin: b.settingMin, run: run.label });
    }
    // T2: walk this run's rows in order; each music row re-derived against what came before it
    for (const [r, ev] of runEvents) {
      const hour = new RealDate(r.scheduled_at * 1000).getHours();
      const pool = F.pool(r.category_id, hour);
      const d = C.rederivePick(tl, pool, r.scheduled_at, F.rules);
      t2.checked++;
      const placedPasses = !C.breaches(tl, { ...ev, ts: r.scheduled_at }, F.rules).length;
      if (!d.passing.length) t2.nothingPassedButPlaced++;
      if (!placedPasses) {
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
  res.T2 = { checked: t2.checked, placedBreakingARule: t2.nBreaking, notTheLongestWaiting: t2.nNotLongest, slotsWhereNothingPassedButASongWasPlaced: t2.nothingPassedButPlaced, unscheduledSlots: 0, examplesBreaking: t2.notPassing.slice(0, 5), examplesNotLongest: t2.notLongest.slice(0, 5) };

  // T3: the count proof over the simulated week, per clock category
  const pools = new Map();
  for (const cat of F.clockCats) pools.set(cat, new Set(F.songs.filter(s => !s.deleted_at && s.category_id === cat && s.rotation_status !== "inactive" && (s.content_class == null || s.content_class === "MUSIC")).map(s => C.recordingKey(s.file_path || s.file_key)).filter(Boolean)));
  const proof = new C.CountProof(pools);
  const tAir = new C.Timeline();
  for (const p of histPlays) if (isMusicPlay(p)) tAir.add(playEvent(F, p));
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
      const probe = C.makeEvent({ ts: g.ts, file: so.file_path || so.file_key, artist: so.artist, title: so.title, kind: "probe", ref: null, noRepeatHours: so.no_repeat_hours }, F.split);
      const b = C.breaches(tAir, probe, F.rules, { sides: "before" });
      return b.length ? `${b[0].rule} ${b[0].measuredMin}/${b[0].settingMin} min` : null;
    });
    tAir.add(ev);
  }
  const spreads = [...proof.maxSpread.entries()].map(([c, v]) => ({ category: F.catName.get(c) || c, songs: pools.get(c).size, maxSpread: v }));
  res.T3 = { failures: proof.failures.length, d1Exceptions: proof.exceptions.length, maxSpreadByCategory: spreads, examples: proof.failures.slice(0, 5).map(f => ({ at: fmt(f.ts), category: F.catName.get(f.cat), aired: f.aired, countBefore: f.countBefore, lowest: f.minCount, unblockedLowerCountSongs: f.passedOverCount })) };

  // T4: aired rows untouched by Generate / regenerate
  res.T4 = { nonPendingRowsSnapshotted: t4.snapshots, deleted: t4.deleted.length, changed: t4.changed.length,
    examples: [...t4.deleted.slice(0, 4).map(d => ({ what: "DELETED", by: d.label, row: `${fmt(d.row.scheduled_at)} ${d.row.title} [${d.row.state}${d.row.played_at ? " at " + fmt(d.row.played_at) : ""}]` })),
               ...t4.changed.slice(0, 4).map(d => ({ what: "CHANGED", by: d.label, row: `${fmt(d.before.scheduled_at)} ${d.before.title}`, fields: Object.keys(d.before).filter(k => String(d.before[k]) !== String(d.after[k])) }))] };

  // T8: never ahead of the clock
  const ahead = goLives.filter(g => g.row && hourStartOf(g.row.scheduled_at) > g.ts + EARLY_START_WINDOW_S);
  res.T8 = { goLives: goLives.length, rowsAiredBeforeTheirHour: ahead.length, maxAheadMin: ahead.length ? Math.round(Math.max(...ahead.map(g => hourStartOf(g.row.scheduled_at) - g.ts)) / 60) : 0,
    offLogPlays: floorPlays, examples: ahead.slice(0, 5).map(g => ({ aired: fmt(g.ts), rowFor: fmt(g.row.scheduled_at), title: g.title })),
    // every one, for checking by hand: the row id, when it was scheduled, when the reader aired it, and what
    // the reader said about the moment (mode ahead / on-time / behind)
    all: ahead.slice(0, 3000).map(g => ({ rowId: g.schedId, scheduledAt: g.row.scheduled_at, airedAt: g.ts, aheadMin: Math.round((g.row.scheduled_at - g.ts) / 60), mode: g.mode, title: g.title })),
    largest: ahead.length ? (() => { const m = ahead.reduce((a, b) => (hourStartOf(b.row.scheduled_at) - b.ts > hourStartOf(a.row.scheduled_at) - a.ts ? b : a)); return { rowId: m.schedId, scheduledAt: m.row.scheduled_at, airedAt: m.ts, scheduled: fmt(m.row.scheduled_at), aired: fmt(m.ts), title: m.title, mode: m.mode }; })() : null };

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
function measureReader(w, P, sid, calls = 15) {
  setNow(Math.ceil(RealDate.now() / 1000 / 3600) * 3600);
  const ms = [];
  for (let i = 0; i < calls; i++) {
    const t0 = process.hrtime.bigint();
    try { P.loggen.readLogAnchored(w, sid, 20); } catch {}
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  fakeNowMs = null;
  ms.sort((a, b) => a - b);
  return { calls, medianMs: +ms[Math.floor(calls / 2)].toFixed(1), maxMs: +ms[calls - 1].toFixed(1), limitMs: READER_LIMIT_MS, pollIntervalMs: 250,
    generatedScheduleRows: w.prepare("SELECT count(*) n FROM generated_schedule WHERE station_id=?").get(sid).n };
}

// ── T5: started early (automation at 12:25, the log starts at 3 PM) ───────────────────────────────
async function scenarioStartedEarly(w, P, F) {
  const sid = F.sid;
  const d = new FakeDate(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 2); // a clean future day
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
  return { station: sid, day: fmt(dayStart), eveningRowsInLog: evening, eveningRowsAiredBefore3PM: consumed.length, examples: consumed.slice(0, 5) };
}

// ── T10: a row that breaks separation is in the log; does it air? ─────────────────────────────────
async function scenarioViolatorInLog(w, P, F) {
  const sid = F.sid;
  if (F.rules.songMin == null) return { station: sid, ran: false, why: "song separation is off on this station" };
  const d = new FakeDate(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 4);
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
      src.split("\n").forEach((line, i) => { if (re.test(line) && !/^\s*(\/\/|\*)/.test(line)) out.push(`${f}:${i + 1}`); });
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
  t15.findings = t15.enforceSeparationRead.length + t15.lastPlayedAtReadByPick.length + t15.maxSameCategoryRead.length + t15.noRepeatHoursRead.length
    + t15.breakLengthFit.length + t15.bakedRuleDefaults.length + t15.bakedTimingNumbers.length + (t15.settingsRegistry.startsWith("ABSENT") ? 1 : 0) + (t15.isHardRead.length ? 0 : 1);
  t15.isHardNote = t15.isHardRead.length ? "is_hard is read" : "is_hard (STRICT) is read by NO picker — the STRICT button decides nothing";

  const t16 = {
    orderByRandom: hits(/ORDER BY RANDOM\(\)/i, null),
    pickers: {
      "generate-core: first compliant from ORDER BY RANDOM + _lrpFallback": hits(/function _legacyPickMusic|function _lrpFallback|const selectMusic/, ["electron/generate-core.js"]),
      "scheduler-core: pickForCategory / planHour": hits(/function pickForCategory|function planHour/, ["audiod/scheduler-core.js"]),
      "separation-enforce: pickEnforced": hits(/function pickEnforced/, ["electron/separation-enforce.js"]),
      "loggen (daemon): pickFromClock / pickTier / fillQueueEnforced": hits(/function pickFromClock|function pickTier|function fillQueueEnforced/, ["audiod/loggen.js"]),
      "src/audio/loggen.ts (renderer, imported by App.tsx; runs in daemon mode: UNVERIFIED)": files["src/audio/loggen.ts"] ? hits(/ORDER BY RANDOM|function pick/i, ["src/audio/loggen.ts"]) : [],
      "src/audio/separationEnforce.ts (renderer)": files["src/audio/separationEnforce.ts"] ? hits(/function pick|export function/i, ["src/audio/separationEnforce.ts"]) : [],
    },
  };
  t16.modulesThatChooseSongs = Object.values(t16.pickers).filter(a => a.length).length;
  return { T15: t15, T16: t16 };
}

function countBy(arr, k) { const m = {}; for (const x of arr) { const v = x[k] == null ? "null" : String(x[k]); m[v] = (m[v] || 0) + 1; } return m; }

// ── pass / fail ───────────────────────────────────────────────────────────────────────────────────
function verdicts(sim, t5, t10, hist, stat) {
  const v = [];
  const add = (t, pass, line) => v.push({ test: t, pass, line });
  for (const s of sim) {
    const st = `station ${s.station}`;
    add("T1", s.T1_onAir.violations === 0 && s.T1_inLog.violations === 0, `${st}: ${s.T1_onAir.violations} separation violations on air, ${s.T1_inLog.violations} in the log (${JSON.stringify(s.T1_onAir.byRule)} / ${JSON.stringify(s.T1_inLog.byRule)})`);
    add("T2", s.T2.placedBreakingARule === 0 && s.T2.notTheLongestWaiting === 0, `${st}: of ${s.T2.checked} picks, ${s.T2.placedBreakingARule} broke a rule and ${s.T2.notTheLongestWaiting} were not the longest-waiting song that passed; 0 UNSCHEDULED slots exist (${s.T2.slotsWhereNothingPassedButASongWasPlaced} slots had no passing song and got one anyway)`);
    add("T3", s.T3.failures === 0, `${st}: ${s.T3.failures} go-lives pushed a category past spread 1 while a lower-count song was free (D1 exceptions: ${s.T3.d1Exceptions}); worst spread ${Math.max(0, ...s.T3.maxSpreadByCategory.map(c => c.maxSpread))}`);
    add("T4", s.T4.deleted === 0 && s.T4.changed === 0, `${st}: of ${s.T4.nonPendingRowsSnapshotted} non-pending rows, Generate deleted ${s.T4.deleted} and changed ${s.T4.changed}`);
    add("T8", s.T8.rowsAiredBeforeTheirHour === 0, `${st}: ${s.T8.rowsAiredBeforeTheirHour} of ${s.T8.goLives} go-lives aired a row before its hour began (up to ${s.T8.maxAheadMin} min early); ${s.T8.offLogPlays} off-log floor plays`);
    add("T11", s.T11_sim.playsWithoutLogRowId === 0 && s.T11_sim.musicPlaysWithoutCategory === 0, `${st} (simulated): ${s.T11_sim.playsWithoutLogRowId} of ${s.T11_sim.logPlays ?? s.T11_sim.plays} plays from log rows carry no link to their row, ${s.T11_sim.musicPlaysWithoutCategory} music plays no category`);
    if (s.T18.timedBreaksAired === 0) add("T18", null, `station ${s.station}: not applicable — this station's clocks have no timed breaks`);
    else add("T18", s.T18.outsideTolerance === 0, `${st}: ${s.T18.outsideTolerance} of ${s.T18.timedBreaksAired} timed breaks started outside ±${BREAK_TOL_S} s; of the ${s.T18.airedInOwnHour} aired inside their own hour, ${s.T18.inOwnHourOutsideTolerance} were off (up to ${s.T18.inOwnHourMaxLateSec} s late, ${s.T18.inOwnHourMaxEarlySec} s early)`);
  }
  for (const h of hist) if (h.plays) add("T11", h.playsWithoutLogRowId === 0 && h.musicPlaysWithoutCategory === 0 && h.logRowsStampedWithNoPlayWithin10s === 0, `station ${h.station} (this machine's record, ${h.window}, ${h.hoursWithPlays} hours with plays): ${h.playsWithoutLogRowId}/${h.plays} plays without a log row id, ${h.musicPlaysWithoutCategory} music plays without category, ${h.logRowsStampedWithNoPlayWithin10s} rows stamped aired with no play, ${h.sweeperPlays} sweeper plays vs ${h.sweeperRowsStampedAired} sweeper rows stamped`);
  for (const s of sim) if (s.T19) add("T19", s.T19.maxMs <= s.T19.limitMs, `station ${s.station}: the reader takes ${s.T19.medianMs} ms a call (max ${s.T19.maxMs} ms, ${s.T19.calls} calls, ${s.T19.generatedScheduleRows} log rows) against a limit of ${s.T19.limitMs} ms, inside the ${s.T19.pollIntervalMs} ms air loop`);
  for (const t of t5) add("T5", t.eveningRowsAiredBefore3PM === 0, `station ${t.station}: automation at 12:25 with the log starting at 3 PM — ${t.eveningRowsAiredBefore3PM} evening rows aired before 3 PM (of ${t.eveningRowsInLog})`);
  for (const t of t10) if (t.ran) add("T10", !t.violatorAirsNext, `station ${t.station}: "${t.song}" placed again right after it aired (song rule ${t.songRuleMin} min) — ${t.violatorAirsNext ? `the reader AIRS it next, ${t.gapMin} min after it aired` :"not aired: the reader chose " + t.readerChose}`);
  if (stat) add("T15", stat.T15.findings === 0, `${stat.T15.findings} findings: registry ${stat.T15.settingsRegistry.split(" ")[0]}; enforce_separation read at ${stat.T15.enforceSeparationRead.length} places; last_played_at by the pick at ${stat.T15.lastPlayedAtReadByPick.length}; no_repeat_hours at ${stat.T15.noRepeatHoursRead.length}; max_same_category at ${stat.T15.maxSameCategoryRead.length}; break length fit at ${stat.T15.breakLengthFit.length}; baked rule defaults at ${stat.T15.bakedRuleDefaults.length}; baked timing numbers at ${stat.T15.bakedTimingNumbers.length}; ${stat.T15.isHardNote}`);
  if (stat) add("T16", stat.T16.modulesThatChooseSongs === 1 && stat.T16.orderByRandom.length === 0, `${stat.T16.modulesThatChooseSongs} modules choose songs; ORDER BY RANDOM() at ${stat.T16.orderByRandom.length} places`);
  return v;
}

function ratchetMetrics(sim, stat) {
  const m = stat ? { static: { T15_findings: stat.T15.findings, T16_pickers: stat.T16.modulesThatChooseSongs, T16_random: stat.T16.orderByRandom.length } } : {};
  for (const s of sim) m["station:" + s.uuid] = {
    T1_onAir: s.T1_onAir.violations, T1_inLog: s.T1_inLog.violations, T2_breaking: s.T2.placedBreakingARule, T2_notLongest: s.T2.notTheLongestWaiting,
    T3_failures: s.T3.failures, T4_touched: s.T4.deleted + s.T4.changed, T8_ahead: s.T8.rowsAiredBeforeTheirHour, T11_unlinked: s.T11_sim.playsWithoutLogRowId, T18_off: s.T18.outsideTolerance,
    T19_readerMs: s.T19 ? Math.ceil(s.T19.medianMs) : null,
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
const ORDER = ["T1", "T2", "T3", "T4", "T5", "T8", "T10", "T11", "T15", "T16", "T18", "T19"];
const table = (v) => ORDER.flatMap(t => v.filter(y => y.test === t).map(x => `${x.pass === null ? "N/A " : x.pass ? "PASS" : "FAIL"}  ${t.padEnd(4)} ${x.line}`)).join("\n");

// ── child: ONE station of ONE database ────────────────────────────────────────────────────────────
async function runChild() {
  const src = dbPaths[0], sid = ONLY_STATIONS[0];
  const tag = path.basename(path.dirname(src)) + "-st" + sid;
  const aPath = copyDb(src, tag + "-sim"), bPath = copyDb(src, tag + "-scen");
  const A = wrapDb(new DatabaseSync(aPath)), B = wrapDb(new DatabaseSync(bPath));
  const out = { db: src, station: sid };
  try {
    const st = A.prepare("SELECT id, name, uuid FROM stations WHERE id=?").get(sid);
    const F = stationFacts(A, sid);
    console.log(`  station ${sid} ${st.name}: rules song ${F.rules.songMin ?? "off"} / artist ${F.rules.artistMin ?? "off"} / title ${F.rules.titleMin ?? "off"} min; per-song no-repeat-hours on ${F.songs.filter(x => !x.deleted_at && x.no_repeat_hours != null && F.clockCats.has(x.category_id)).length} songs`);
    // this machine's own record (T11) and the reader's call time (T19) are read before the copy is touched
    const hist = { ...historyRecord(A, F, Math.floor(RealDate.now() / 1000) - 7 * 86400), name: st.name };
    const t19 = measureReader(A, bindProduct(A), sid);
    // The copies only (a copy that is deleted afterwards needs no durability; ANALYZE changes plans, never
    // results; history rows > 2 days old that nothing decides from are removed — see the run report's model).
    for (const X of [A, B]) { X.exec("PRAGMA synchronous=OFF"); X.exec("PRAGMA journal_mode=MEMORY"); }
    const cut = Math.floor(RealDate.now() / 1000) - 2 * 86400;
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
    fakeNowMs = null;
    Object.assign(out, { name: st.name, uuid: st.uuid, sim: r, t5, t10, hist });
  } finally {
    A.raw.close(); B.raw.close();
    if (!flag("--keep-copies")) { for (const p of [aPath, bPath]) { try { fs.rmSync(p); } catch {} } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
    else console.log(`    copies kept: ${aPath} ${bPath}`);
  }
  const v = verdicts([out.sim], [out.t5], [out.t10], [out.hist], null);
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
  if (!dbPaths.length) { console.log("NO DATABASE FOUND — nothing to test. Pass --db <copy>."); process.exit(2); }
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
      const args = [__filename, "--child", "--db", src, "--stations", String(st.id), "--run-dir", runDir, "--days", String(DAYS), "--seed", String(SEED), "--reader-limit-ms", String(READER_LIMIT_MS)];
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
