// scripts/test-record-phase1.js — Phase 1 of docs/scheduler-rotation-playout-design.md: WHAT AIRED IS THE RECORD.
//
// The real engine (audiod/engine.js DaemonEngine) and the real log reader (audiod/loggen.js) play a two-hour evening
// from a log on a COPY of this machine's database, with the sound card simulated. It reproduces the 10/16 conditions:
// songs really run longer than planned (the station drifts behind the log), the log is regenerated under the cued
// decks (calendar re-cues), the X is pressed on Up Next and on a cued deck. Then it checks:
//
//   T10r  no log row goes to air twice (the 10/16 replays), and no `row-aired-twice` alert is raised
//   T11   every go-live is ONE play with its row's uuid, its category, its content class and this machine, and its row
//         is stamped with the second it went live; every sweeper that fired is stamped 'played'
//   T12   a row removed with the X never airs and is not back after 10 refills; a cued row taken off with the X
//         leaves the deck and the log
//   T4t   no aired row is rewritten during the evening (log_row_changes stays empty), and the trigger does catch
//         a rewrite of an aired row (one deliberate UPDATE → one row → one `aired-row-changed` alert)
//   T4g   Generate's own window delete (main.js _commitDayRows, lifted and run as-is) leaves aired rows alone
//   NS    a go-live whose write fails is retried until it lands, and a write that never lands is a `not-stamped` alert
//
// What is real: the engine's refill, re-cue, preload, rotate, go-live record, X, sweeper stamps; the reader; playlog's
// recordGoLive; the v63 migration and its triggers; _commitDayRows. What is simulated: the sound card, the clock, the
// 250 ms poll (a step when the song's real length is over) and the engine's two arm timers after a rotate (refill,
// then cue the next two decks — what _armAfterRotate does, without real-time waits).
//
//   node scripts/test-record-phase1.js [--db <openair.db>] [--station 2] [--engine-dir <a checkout of another engine>]
//   --engine-dir runs the SAME evening through another copy of audiod/ + electron/ (e.g. 6558e57) — the before receipt.
// Never the live file: the database is copied with VACUUM INTO from a read-only handle and deleted afterwards.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const { DatabaseSync } = require("node:sqlite");

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.join(__dirname, "..");
const ENGINE_ROOT = opt("--engine-dir", null) ? path.resolve(opt("--engine-dir")) : ROOT;
const SID = Number(opt("--station", 2));
const SRC = opt("--db", (() => {
  const prof = path.join(process.env.LOCALAPPDATA || "", "Ether", "profiles");
  for (const d of (fs.existsSync(prof) ? fs.readdirSync(prof) : [])) {
    if (d.includes(".retired") || d.startsWith("_")) continue;
    const f = path.join(prof, d, "openair.db"); if (fs.existsSync(f)) return f;
  }
  return null;
})());
if (!SRC) { console.log("no database found; pass --db <copy>"); process.exit(2); }

// ── the clock ─────────────────────────────────────────────────────────────────────────────────────────────────
const RealDate = Date;
const T0 = (() => { const d = new RealDate(); d.setDate(d.getDate() + 3); d.setHours(18, 0, 0, 0); return Math.floor(d.getTime() / 1000); })();
let NOW = T0 * 1000;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}
global.Date = FakeDate;
const nowS = () => Math.floor(NOW / 1000);
const hhmm = (sec) => new RealDate(sec * 1000).toTimeString().slice(0, 8);

// ── the copy ──────────────────────────────────────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ether-record-test-"));
const COPY = path.join(TMP, "record.db");
{ const ro = new DatabaseSync(SRC, { readOnly: true }); try { ro.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`); } finally { ro.close(); } }
const db = new DatabaseSync(COPY);
db.exec("PRAGMA synchronous=OFF");
// better-sqlite3's db.transaction(), which the migration and main.js's code call
db.transaction = (fn) => (...a) => { db.exec("SAVEPOINT t"); try { const r = fn(...a); db.exec("RELEASE t"); return r; } catch (e) { db.exec("ROLLBACK TO t"); db.exec("RELEASE t"); throw e; } };
// v63 from THIS tree, on both runs, so the trigger watches the old engine too
// (old history rows are pruned from the copy first — before the triggers exist, so the pruning is not a "change")
db.exec("DELETE FROM generated_schedule WHERE station_id=" + SID + " AND state IS NOT NULL AND state != 'pending' AND scheduled_at < " + (T0 - 2 * 86400));
require(path.join(ROOT, "scripts", "migrate-play-record-phase-sync-63.js")).applyMigration(db);
db.exec("ANALYZE");

const { DaemonEngine } = require(path.join(ENGINE_ROOT, "audiod", "engine.js"));
const playlog = require(path.join(ENGINE_ROOT, "audiod", "playlog.js"));
const NEW = typeof playlog.recordGoLive === "function";
const machine = (() => { try { const r = db.prepare("SELECT client_id FROM client_identity LIMIT 1").get(); return r && r.client_id ? String(r.client_id).toLowerCase() : null; } catch { return null; } })();
console.log(`engine: ${ENGINE_ROOT}${NEW ? "" : "  (no recordGoLive: the engine before Phase 1)"}\nstation ${SID}, evening ${new RealDate(T0 * 1000).toLocaleString()}, machine ${machine}`);

// ── the station's log for the evening ─────────────────────────────────────────────────────────────────────────
const cats = db.prepare(`SELECT DISTINCT cs.category_id c FROM clock_slots cs WHERE cs.station_id=? AND cs.slot_type='music' AND cs.category_id IS NOT NULL AND cs.deleted_at IS NULL`).all(SID).map(r => r.c);
const songs = db.prepare(`SELECT s.id, s.title, a.name artist, s.file_path, s.duration_ms, s.category_id FROM songs s LEFT JOIN artists a ON a.id=s.artist_id
  WHERE s.deleted_at IS NULL AND s.file_path IS NOT NULL AND s.duration_ms > 60000 AND (s.content_class IS NULL OR s.content_class='MUSIC')
    AND s.category_id IN (${cats.map(() => "?").join(",") || "NULL"}) ORDER BY s.id LIMIT 80`).all(...cats);
if (songs.length < 30) { console.log("not enough songs with a file in this station's clock categories:", songs.length); process.exit(2); }
const spot = db.prepare("SELECT title, file_path, length_sec FROM spots WHERE station_id=? AND deleted_at IS NULL AND file_path IS NOT NULL LIMIT 1").get(SID);
// The evening's log replaces whatever is pending for the station from now on (on the copy).
db.prepare("UPDATE generated_schedule SET deleted_at='record-test' WHERE station_id=? AND (state IS NULL OR state='pending') AND deleted_at IS NULL").run(SID);
const REAL_LEN = new Map();
const iso = new RealDate().toISOString();
const ins = db.prepare(`INSERT INTO generated_schedule (scheduled_at, song_id, title, artist, file_path, file_key, duration_s, category_id, station_id, uuid, state, content_class, created_at, updated_at, generated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`);
let uq = 0;
const addRow = (ts, s, cls = "MUSIC") => {
  const r = ins.run(ts, s.id ?? null, s.title, s.artist || "", s.file_path, path.basename(s.file_path || ""), s.planned, s.category_id ?? null, SID, `rec-${SID}-${T0}-${uq++}`, cls, iso, iso, nowS());
  return Number(r.lastInsertRowid);
};
let cursor = 0;
function buildHours(fromTs, toTs, offset) {
  const ids = [];
  let t = fromTs;
  while (t < toTs) {
    if (spot && (t - T0) % 1800 < 200 && !ids.some(x => x.spotAt === Math.floor(t / 1800))) {
      const sp = { title: spot.title, artist: "", file_path: spot.file_path, planned: spot.length_sec || 30 };
      REAL_LEN.set(spot.file_path, sp.planned);
      ids.push({ id: addRow(t, sp, "SPOT"), spotAt: Math.floor(t / 1800) }); t += sp.planned; continue;
    }
    const s0 = songs[(offset + cursor++) % songs.length];
    const planned = Math.round(s0.duration_ms / 1000);
    REAL_LEN.set(s0.file_path, planned + (cursor % 3 === 0 ? 25 : 0));      // every third song really runs 25 s long
    const s = { ...s0, planned };
    ids.push({ id: addRow(t, s) });
    t += planned;
  }
  return ids;
}
buildHours(T0, T0 + 2 * 3600, 0);
// one sweeper row bound to a seam (at its incoming song's own time, as _placeJingles writes it), to check its stamp
const swpSeam = db.prepare("SELECT id, scheduled_at FROM generated_schedule WHERE station_id=? AND state='pending' AND deleted_at IS NULL AND content_class='MUSIC' AND scheduled_at >= ? ORDER BY scheduled_at LIMIT 1").get(SID, T0 + 600);
const swpRow = addRow(swpSeam.scheduled_at, { title: "record-test sweeper", artist: "", file_path: songs[0].file_path, planned: 3 }, "SWP");

// ── the sound card ────────────────────────────────────────────────────────────────────────────────────────────
const card = { A: {}, B: {}, C: {} };
for (const d of "ABC") card[d] = { status: "idle", file: "", title: "", pos: 0 };
const lives = [], alerts = [];
const e = new DaemonEngine(SID, db, (ev, p) => {
  if (ev === "playstart") lives.push({ t: nowS(), deck: p.deck, title: p.title, file: p.filePath, row: e.deckSchedId[p.deck] ?? null });
  if (ev === "alert") alerts.push(p);
});
e._log = () => {};
e._load = (d, fp, title) => { card[d] = { status: "loaded", file: fp, title, pos: 0 }; return true; };
e._play = (d) => { if (!card[d].file) return false; card[d].status = "playing"; card[d].pos = 0; e.liveDeck = d; e.segueTriggered && e.segueTriggered.delete(d); return true; };
e._stop = (d) => { card[d] = { status: "idle", file: "", title: "", pos: 0 }; };
e._state = () => { const m = (d) => ({ status: card[d].status, file_path: card[d].file, title: card[d].title, position_sec: card[d].pos }); return { deckA: m("A"), deckB: m("B"), deckC: m("C") }; };
e._dur = (fp) => REAL_LEN.get(fp) || 0;
e._resolveLocal = (fp) => fp || null;
e._observeFit = () => {};
e._projectedSeamTs = () => nowS();
e._armAfterRotate = () => {};                 // armed by hand below, without the real-time timers
e._started = true; e.continuous = true; e.segueOverlap = 0; e.crossfadeDuration = 0;

const flush = async () => { for (let i = 0; i < 6; i++) { await e.advanceP; await new Promise(r => setImmediate(r)); } };
const refill = async () => { await e._refillFromLog({ force: true }); await flush(); };
const arm = async (live) => {
  const order = ["A", "B", "C"]; const i = order.indexOf(live);
  await refill(); await e.preload(order[(i + 1) % 3], 0); await e.preload(order[(i + 2) % 3], 1); await flush();
};
const syncIdle = (d) => { if (card[d].status === "idle") e._setDeck(d, { status: "idle", title: "", artist: "", filePath: "", positionSec: 0 }); };
const consume = (d) => { if (typeof e._consumeDeckEntry === "function") e._consumeDeckEntry(d); else if (e.queue.length) e.dequeue(); };

// ── the X ─────────────────────────────────────────────────────────────────────────────────────────────────────
const xed = [];
function pressX(which) {
  const pending = e.queue.filter(q => !e.boundQids.has(q.qid) && q.schedId != null);
  let target = null;
  if (which === "pending") target = pending[2];
  if (which === "cued") {
    const d = ["A", "B", "C"].find(x => e.deckReady.has(x) && e._deckState(x).status !== "playing");
    const qid = d && e.deckQid ? e.deckQid[d] : null;
    target = qid ? e.queue.find(q => q.qid === qid) : (d ? e.queue.find(q => e.boundQids.has(q.qid)) : null);
  }
  if (!target) { xed.push({ which, skipped: "no target" }); return; }
  const ok = e.intentRemove(target.qid);
  xed.push({ which, row: target.schedId, title: target.title, ok });
}

// ── the evening ───────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  await refill();
  await e.preload("A", 0); await flush();
  e._play("A"); e._setDeck("A", { status: "playing", positionSec: 0 }); e.deckReady.delete("A"); consume("A"); e._fireStart("A");
  await arm("A");
  const END = T0 + 2 * 3600 - 300;
  let did = { x1: false, x2: false, regen: false, sweeper: false };
  let guard = 0;
  while (nowS() < END && guard++ < 5000) {
    const live = ["A", "B", "C"].find(d => card[d].status === "playing");
    if (!live) { await e._advance("watchdog-recover", () => e._resumePlayout()); await flush(); continue; }
    const len = REAL_LEN.get(card[live].file) || 180;
    // events during the song
    if (!did.x1 && nowS() >= T0 + 1200) { did.x1 = true; pressX("pending"); await flush(); }
    if (!did.x2 && nowS() >= T0 + 1800) { did.x2 = true; pressX("cued"); await flush(); }
    if (!did.sweeper && e.deckSchedId[live] === swpSeam.id) {
      did.sweeper = true;   // the sweeper fired over the seam into its song (its own path: _logJinglePlay)
      e._logJinglePlay({ title: "record-test sweeper", artist: "", channels: ["CART"], jinDur: 3, filePath: songs[0].file_path, contentClass: "SWP", rowId: swpRow });
    }
    if (!did.regen && nowS() >= T0 + 3000) {
      // Regenerate under the cued decks (the 10/16 condition): the rest of the evening is replaced with other songs.
      did.regen = true;
      db.prepare("UPDATE generated_schedule SET deleted_at='record-test-regen' WHERE station_id=? AND state='pending' AND deleted_at IS NULL AND scheduled_at > ?").run(SID, nowS() + 120);
      buildHours(nowS() + 121, T0 + 2 * 3600, 37);
      await refill();
    }
    // play the song out, in 4 steps with a refill each (the 2 s refill, sampled)
    for (let k = 1; k <= 4; k++) { NOW += (len / 4) * 1000; card[live].pos = len * k / 4; e._setDeck(live, { positionSec: card[live].pos }); await refill(); }
    // the song ends: rotate to the next cued deck, as the poll would
    const to = e._nextRotateDeck(live);
    card[live].status = "idle"; card[live].file = ""; syncIdle(live);
    if (to) { e.handleRotate(live, to); await flush(); await arm(to); }
    else { await e._advance("watchdog-recover", () => e._resumePlayout()); await flush(); }
  }
  // 10 refills after the X
  for (let i = 0; i < 10; i++) { NOW += 2000; await refill(); }

  // ── checks ──
  const res = [];
  const ok = (name, pass, line) => { res.push({ name, pass, line }); };
  const rowLives = new Map();
  for (const l of lives) if (l.row != null) rowLives.set(l.row, (rowLives.get(l.row) || 0) + 1);
  const twice = [...rowLives.entries()].filter(([, n]) => n > 1);
  const twiceAlerts = alerts.filter(a => a.kind === "row-aired-twice").length;
  ok("T10r", twice.length === 0 && twiceAlerts === 0, `${lives.length} go-lives, ${rowLives.size} rows; rows that went to air more than once: ${twice.length}${twice.length ? " (" + twice.slice(0, 6).map(([r, n]) => `row ${r} ×${n}`).join(", ") + ")" : ""}; row-aired-twice alerts: ${twiceAlerts}`);

  const plays = db.prepare("SELECT * FROM play_log WHERE station_id=? AND played_at >= ? ORDER BY played_at, id").all(SID, T0);
  const v63 = plays.length && "row_uuid" in plays[0];
  let unlinked = 0, wrongMachine = 0, noCat = 0, badStamp = 0, checked = 0;
  for (const l of lives) {
    if (l.row == null) continue;
    checked++;
    const row = db.prepare("SELECT uuid, state, played_at, category_id, content_class FROM generated_schedule WHERE id=?").get(l.row);
    const p = plays.find(x => x.played_at === l.t && x.file_path === l.file);
    if (!p || !v63 || p.row_uuid !== (row && row.uuid)) unlinked++;
    if (p && v63 && p.machine_id !== machine) wrongMachine++;
    if (p && row && row.category_id != null && row.content_class === "MUSIC" && p.category_code == null) noCat++;
    if (!row || !(row.state === "played" || row.state === "playing") || row.played_at == null) badStamp++;
  }
  const swp = db.prepare("SELECT state, played_at FROM generated_schedule WHERE id=?").get(swpRow);
  ok("T11", unlinked === 0 && wrongMachine === 0 && noCat === 0 && badStamp === 0 && swp && swp.state === "played",
    `of ${checked} log go-lives: ${unlinked} plays without their row's uuid, ${wrongMachine} without this machine, ${noCat} music plays without category, ${badStamp} rows not stamped aired; the sweeper that fired is '${swp && swp.state}'`);

  const xRows = xed.filter(x => x.row != null);
  const xAired = xRows.filter(x => rowLives.has(x.row));
  const xBack = xRows.filter(x => e.queue.some(q => q.schedId === x.row));
  const xInLog = xRows.filter(x => { const r = db.prepare("SELECT deleted_at FROM generated_schedule WHERE id=?").get(x.row); return r && r.deleted_at == null; });
  ok("T12", xRows.length === 2 && xAired.length === 0 && xBack.length === 0 && xInLog.length === 0,
    `X pressed on ${xed.map(x => x.which + (x.row != null ? ` (row ${x.row} "${x.title}")` : " (" + (x.skipped || "?") + ")")).join(", ")}; aired anyway: ${xAired.length}; back in Up Next after 10 refills: ${xBack.length}; still in the log: ${xInLog.length}`);

  const changesDuring = db.prepare("SELECT count(*) n FROM log_row_changes").get().n;
  const aired = db.prepare("SELECT id, title FROM generated_schedule WHERE station_id=? AND state='played' AND scheduled_at >= ? LIMIT 1").get(SID, T0);
  let caught = 0, alertRaised = 0;
  if (aired) {
    db.prepare("UPDATE generated_schedule SET title = title || ' (edited)' WHERE id=?").run(aired.id);
    caught = db.prepare("SELECT count(*) n FROM log_row_changes").get().n - changesDuring;
    const HA = require(path.join(ROOT, "electron", "health-alerts.js"));
    alertRaised = HA.scanLogRowChanges(db, 0, () => {}).raised;
  }
  ok("T4t", changesDuring === 0 && caught === 1 && alertRaised >= 1, `aired rows rewritten during the evening: ${changesDuring}; a deliberate rewrite of an aired row was caught ${caught} time(s) and raised ${alertRaised} alert(s)`);

  // Generate's own delete, lifted from main.js and run as-is, over a window holding an aired row
  const MAIN = fs.readFileSync(path.join(ENGINE_ROOT, "electron", "main.js"), "utf8");
  const st = MAIN.indexOf("\nfunction _commitDayRows(");
  const m = /\r?\n\}\r?\n/.exec(MAIN.slice(st + 1));
  const src = MAIN.slice(st + 1, st + 1 + m.index + m[0].length);
  const { createRequire } = require("module");
  const commit = new Function("db", "require", "_scheduleChanged", "_healthEvent", "console", `${src}\nreturn _commitDayRows;`)(db, createRequire(path.join(ENGINE_ROOT, "electron", "main.js")), () => {}, () => {}, { log() {}, error() {}, warn() {} });
  const airedRows = db.prepare("SELECT id FROM generated_schedule WHERE station_id=? AND deleted_at IS NULL AND state IN ('played','playing','missed') AND scheduled_at >= ?").all(SID, T0).map(r => r.id);
  commit(SID, T0, T0 + 86400, []);
  const gone = airedRows.filter(id => !db.prepare("SELECT 1 FROM generated_schedule WHERE id=?").get(id));
  ok("T4g", airedRows.length > 0 && gone.length === 0, `Generate's window delete over the evening: ${airedRows.length} aired/retired rows in the window, ${gone.length} deleted`);

  // not-stamped: a failing write is retried, and one that never lands is an alert
  if (NEW) {
    const real = playlog.recordGoLive; let fails = 2;
    playlog.recordGoLive = (d, a) => (fails-- > 0 ? { ok: false, error: "SQLITE_BUSY (simulated)" } : real(d, a));
    const realTimeout = global.setTimeout; global.setTimeout = (fn) => realTimeout(fn, 0);
    const rowA = addRow(nowS() + 5, { id: songs[1].id, title: songs[1].title, artist: songs[1].artist, file_path: songs[1].file_path, planned: 200, category_id: songs[1].category_id });
    e.deckSchedId.A = rowA; e._setDeck("A", { title: songs[1].title, filePath: songs[1].file_path, durationSec: 200 });
    e._recordGoLive("A", e._deckState("A"));
    await new Promise(r => realTimeout(r, 50));
    const landed = db.prepare("SELECT state FROM generated_schedule WHERE id=?").get(rowA).state;
    fails = 1e9;
    const before = alerts.filter(a => a.kind === "not-stamped").length;
    const rowB = addRow(nowS() + 9, { id: songs[2].id, title: songs[2].title, artist: songs[2].artist, file_path: songs[2].file_path, planned: 200, category_id: songs[2].category_id });
    e.deckSchedId.B = rowB; e._setDeck("B", { title: songs[2].title, filePath: songs[2].file_path, durationSec: 200 });
    e._recordGoLive("B", e._deckState("B"));
    await new Promise(r => realTimeout(r, 1500));   // 60 retries on an immediate timer
    global.setTimeout = realTimeout; playlog.recordGoLive = real;
    const raised = alerts.filter(a => a.kind === "not-stamped").length - before;
    ok("NS", landed === "playing" && raised === 1, `a write that failed twice landed on the 3rd try (row '${landed}'); a write that never lands raised ${raised} not-stamped alert(s)`);
  } else ok("NS", false, "the engine before Phase 1 has no retry and no alert: a failed stamp is swallowed (engine.js _shadowStampPlayhead catch)");

  console.log("\n══ PHASE 1 — the record ══");
  for (const r of res) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(5)} ${r.line}`);
  const outDir = path.join(ROOT, "dist-electron", "gate-logs"); fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `record-phase1-${NEW ? "after" : "before"}-${new RealDate().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(out, JSON.stringify({ engine: ENGINE_ROOT, station: SID, T0, results: res, lives, alerts, xed }, null, 2));
  console.log("details:", out);
  try { db.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(res.every(r => r.pass) ? 0 : 1);
})().catch(err => { console.error("TEST ERROR:", err && err.stack || err); try { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(2); });
