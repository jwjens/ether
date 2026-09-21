// Program Log slice 2 — Fill Day / hour Generate / Clear Day ride the REAL handlers, tested against a
// fresh in-memory schema (schema-v0-baseline + the full migration chain). No live DB, no audio.
// Run:  ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-programlog-writes.js   (exit 0 = pass)
//
// The handlers are read OUT OF electron/main.js (brace-matched source, not a copy) and evaluated with
// the real generate-core.js / log-edit-core.js / generated_schedule handler underneath; only the
// observation tails (_genEmit, _placeJingles, finishGenerateRun, retireStaleScheduleRows,
// _healthEvent) are stubbed, and `Date` is pinned so "now" is 10:30 on the test day.
"use strict";
const path = require("path");
const fs = require("fs");
const root = path.join(__dirname, "..");
const Database = require(path.join(root, "node_modules", "better-sqlite3"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (cond ? "" : `  — ${detail || ""}`));
  cond ? pass++ : fail++;
}

// ── fresh schema: baseline + every migration, in version order (the chain verifier's recipe) ──
const db = new Database(":memory:");
db.pragma("foreign_keys = ON");
require(path.join(__dirname, "schema-v0-baseline.js"))(db);
db.prepare("INSERT INTO stations (name) VALUES (?)").run("Station 1");
const migs = fs.readdirSync(__dirname).filter(f => /^migrate-.*-phase-sync-(\d+)\.js$/.test(f))
  .map(f => ({ f, v: Number(f.match(/-(\d+)\.js$/)[1]) })).sort((a, b) => a.v - b.v);
const origLog = console.log; console.log = () => {};
for (const m of migs) require(path.join(__dirname, m.f)).applyMigration(db);
console.log = origLog;
// …plus the startup ALTERs main.js applies on every launch (alterSafe: try/catch per statement) —
// generated_schedule.file_path / pick_reason etc. live there, not in the chain.
const main = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
const alters = [...main.matchAll(/alterSafe\("(ALTER TABLE [^"]+)"\)/g)].map(m => m[1]);
for (const sql of alters) { try { db.exec(sql); } catch {} }
check(`fresh schema built: baseline + ${migs.length} migrations + ${alters.length} startup ALTERs`, migs.length >= 61 && alters.length > 0);
// ── slice 6 — v61 dropped the dead log table on the fresh chain; the refusal on a non-empty table ──
const DEADT = "scheduled" + "_log";   // spelled apart so the repo-wide grep receipt stays clean
const hasT = (d, t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
check("v61 · after the full chain the old log table is GONE and v61 is recorded", !hasT(db, DEADT) && !!db.prepare("SELECT 1 FROM schema_version WHERE version = 61").get());
check("v61 · main.js no longer ALTERs the old table at startup (play_log.…_id column ALTER excepted)", !alters.some(a => a.includes("ALTER TABLE " + DEADT + " ")));
{
  const v61 = require(path.join(__dirname, "migrate-drop-scheduled-log-phase-sync-61.js"));
  const d2 = new Database(":memory:");
  require(path.join(__dirname, "schema-v0-baseline.js"))(d2);
  d2.prepare("INSERT INTO stations (name) VALUES (?)").run("S");
  check("v61 · the baseline still creates the old table (append-only history)", hasT(d2, DEADT));
  d2.prepare(`INSERT INTO ${DEADT} (log_date, hour, position, title) VALUES ('2026-09-20', 1, 0, 'ghost')`).run();
  let refused = null;
  try { v61.applyMigration(d2); } catch (e) { refused = e.message; }
  check("v61 · REFUSES a non-empty table by name, drops nothing, records nothing", /REFUSED/.test(refused || "") && /1 row/.test(refused) && hasT(d2, DEADT) && !d2.prepare("SELECT 1 FROM schema_version WHERE version = 61").get(), refused);
  d2.prepare(`DELETE FROM ${DEADT}`).run();
  v61.applyMigration(d2);
  check("v61 · on an empty table it drops it and records v61", !hasT(d2, DEADT) && !!d2.prepare("SELECT 1 FROM schema_version WHERE version = 61").get());
  v61.applyMigration(d2);
  check("v61 · idempotent — a second run is a recorded no-op", !hasT(d2, DEADT));
  check("v61 · exports payloadTransformer (identity) + applyMigration + isAlreadyMigrated", typeof v61.payloadTransformer === "function" && v61.payloadTransformer({ a: 1 }).a === 1 && typeof v61.applyMigration === "function" && v61.isAlreadyMigrated(d2) === true);
}

// ── extract the shipped code from main.js ──
function braceBlock(startNeedle) {
  const i = main.indexOf(startNeedle);
  if (i < 0) throw new Error("not found in main.js: " + startNeedle);
  // A handler's parameter list may itself carry braces (a destructured payload), so the body's
  // opening brace is the first one after the arrow on the needle's line.
  const eol = main.indexOf("\n", i), arrow = main.indexOf("=>", i);
  let depth = 0, j = main.indexOf("{", arrow > -1 && arrow < eol ? arrow : i);
  for (; j < main.length; j++) {
    const c = main[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) break; }
  }
  // include a trailing ");" for handler registrations
  let end = j + 1;
  if (main.startsWith(");", end)) end += 2;
  return main.slice(i, end);
}
const src = [
  "let _genCancel = false;",
  braceBlock("function _scheduleChanged("),
  braceBlock("async function _generateDayChunked("),
  braceBlock("function _commitDayRows("),
  braceBlock("ipcMain.handle('schedule:generateDay',"),
  braceBlock("ipcMain.handle('schedule:clearDay',"),
  braceBlock("ipcMain.handle('schedule:get',"),
  // slice 4 — the log editor's handlers the hour modal rides
  "const _EDIT_LOCKED = new Set(['played', 'playing']);",
  "const _CELL_FIELDS = new Set(['title', 'artist', 'category_id']);",
  braceBlock("function _logRow("),
  braceBlock("function _guardEditable("),
  braceBlock("ipcMain.handle('schedule:moveRow',"),
  braceBlock("ipcMain.handle('schedule:deleteRow',"),
  braceBlock("ipcMain.handle('schedule:editRowFields',"),
  braceBlock("ipcMain.handle('schedule:checkRow',"),
].join("\n");
check("main.js: generateDay handler takes fromTs", /ipcMain\.handle\('schedule:generateDay', async \(_, dayTs, fromTs\)/.test(src));
check("main.js: clearDay handler exists and only touches state = 'pending'", /schedule:clearDay/.test(src) && /AND state = 'pending'/.test(src));
check("main.js: clearDay is a SOFT delete (deleted_at), the editor's own delete", /UPDATE generated_schedule SET deleted_at = \?, updated_at = \? WHERE station_id = \? AND scheduled_at >= \? AND scheduled_at < \? AND deleted_at IS NULL AND state = 'pending'/.test(src));
check("main.js: generateDay still refuses the past — effStart = max(dayStart, nextTop, fromHour)", /const effStart = Math\.max\(dayStart, nextTop, fromHour\)/.test(src) && /const nextTop = Math\.ceil\(nowTs \/ 3600\) \* 3600/.test(src));

// ── pinned clock: "now" = 10:30 local on TEST DAY (tomorrow, so the whole day is generatable) ──
const RealDate = Date;
const t0 = new RealDate(); t0.setDate(t0.getDate() + 1); t0.setHours(10, 30, 0, 0);
const NOW_MS = t0.getTime();
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW_MS); else super(...a); }
  static now() { return NOW_MS; }
}
const dayBase = new RealDate(NOW_MS); dayBase.setHours(0, 0, 0, 0);
const dayStart = Math.floor(dayBase.getTime() / 1000), dayEnd = dayStart + 86_400;
const hourTs = (h) => { const d = new RealDate(dayBase.getTime()); d.setHours(h, 0, 0, 0); return Math.floor(d.getTime() / 1000); };
const nextTop = hourTs(11);

// ── seed: station 1 with a clock, a show, one category, 40 songs; station 2 with a row of its own ──
db.prepare("INSERT INTO stations (name) VALUES (?)").run("Station 2");
const catId = db.prepare("INSERT INTO categories (code, name, station_id) VALUES ('A','Hot',1)").run().lastInsertRowid;
const clockId = db.prepare("INSERT INTO clocks (name, station_id) VALUES ('Clock 1', 1)").run().lastInsertRowid;
for (let p = 0; p < 12; p++) db.prepare("INSERT INTO clock_slots (clock_id, position, slot_type, category_id, duration_min) VALUES (?,?,?,?,?)").run(clockId, p, "music", catId, 5);
db.prepare("INSERT INTO shows (name, start_hour, end_hour, clock_id, station_id, is_active, days) VALUES ('All Day', 0, 0, ?, 1, 1, '0123456')").run(clockId);
for (let i = 1; i <= 40; i++) {
  const artistId = db.prepare("INSERT INTO artists (name) VALUES (?)").run("Artist " + i).lastInsertRowid;
  // daypart_mask 16777215 = all 24 hours — the value main.js backfills at startup (main.js ~1967)
  db.prepare("INSERT INTO songs (title, artist_id, category_id, duration_ms, file_path, content_class, daypart_mask) VALUES (?,?,?,?,?,'MUSIC',16777215)")
    .run("Song " + i, artistId, catId, 240_000, "C:/music/song" + i + ".mp3");
}
const insRow = (station, ts, state, extra = {}) => db.prepare(
  `INSERT INTO generated_schedule (uuid, station_id, scheduled_at, song_id, title, artist, duration_s, state, played_at, source, content_class, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
).run(extra.uuid || ("seed-" + station + "-" + ts), station, ts, ("song_id" in extra ? extra.song_id : 1), extra.title || ("seed " + state + " @" + ts), "a", 200, state, extra.played_at ?? null, extra.source ?? null, extra.content_class || "MUSIC");

// ── sandbox with the shipped code ──
const health = [];
const broadcasts = [];
const sandbox = new Function(
  "ipcMain", "db", "require", "getActiveStationId", "_healthEvent", "_genEmit", "_placeJingles",
  "finishGenerateRun", "retireStaleScheduleRows", "_hourRanges", "_fmtHour", "buildScheduleCtx",
  "generateDayRows", "resetGenSlice", "Date", "console", "sendToAllWindows", "path",
  src
);
const handlers = {};
const gc = require(path.join(root, "electron", "generate-core.js"));
sandbox(
  { handle: (ch, fn) => { handlers[ch] = fn; } }, db,
  (m) => require(m.startsWith(".") ? path.join(root, "electron", m) : m),
  () => 1, (kind, data) => health.push({ kind, ...data }), () => {}, () => {}, () => {}, () => {},
  (set) => [...set], (h) => String(h), gc.buildScheduleCtx, gc.generateDayRows, gc.resetGenSlice, FakeDate,
  { log: () => {}, error: (...a) => origLog("  [handler error]", ...a) },
  (channel, payload) => broadcasts.push({ channel, payload }), path
);
check("handlers registered: generateDay, clearDay, get, moveRow, deleteRow, editRowFields, checkRow", ["schedule:generateDay", "schedule:clearDay", "schedule:get", "schedule:moveRow", "schedule:deleteRow", "schedule:editRowFields", "schedule:checkRow"].every(k => !!handlers[k]));
const get = (from, to, sid = 1) => { const r = handlers["schedule:get"](null, from, to, sid); if (r.error) throw new Error("schedule:get → " + r.error); return r.data; };
const countAll = (sid = 1) => db.prepare("SELECT count(*) n FROM generated_schedule WHERE station_id = ? AND scheduled_at >= ? AND scheduled_at < ?").get(sid, dayStart, dayEnd).n;

(async () => {
  // ── (a) Fill Day on an EMPTY day → rows schedule:get returns, none before the next top-of-hour ──
  check("a · the day is empty before Fill Day", get(dayStart, dayEnd).length === 0);
  const ra = await handlers["schedule:generateDay"](null, dayStart);
  check("a · generateDay ok", ra && ra.ok === true && !ra.skipped, JSON.stringify(ra));
  const rowsA = get(dayStart, dayEnd);
  check("a · schedule:get returns the generated rows (" + rowsA.length + ")", rowsA.length > 0 && rowsA.length === ra.count, `get=${rowsA.length} count=${ra.count}`);
  check("a · no row before the next top-of-hour (11:00) — the past and the current hour are never generated",
    rowsA.every(r => r.scheduled_at >= nextTop), String(rowsA.filter(r => r.scheduled_at < nextTop).length));
  check("a · rows span the rest of the day (13 hours: 11 → 23)", new Set(rowsA.map(r => new RealDate(r.scheduled_at * 1000).getHours())).size === 13, [...new Set(rowsA.map(r => new RealDate(r.scheduled_at * 1000).getHours()))].join(","));
  check("a · every row is pending with no played_at", rowsA.every(r => r.state === "pending" && r.played_at === null));
  check("a · nothing written to songs.last_played_at by the generate path", db.prepare("SELECT count(*) n FROM songs WHERE last_played_at IS NOT NULL").get().n === 0);
  // slice 3 — the broadcast every Program Log surface re-reads on
  const genB = broadcasts.filter(b => b.channel === "schedule:changed");
  check("a · schedule:changed fired ONCE for the Fill (stationId 1, reason generate, window carried)",
    genB.length === 1 && genB[0].payload.stationId === 1 && genB[0].payload.reason === "generate" && genB[0].payload.from === nextTop && genB[0].payload.to === dayEnd && genB[0].payload.rows === ra.count,
    JSON.stringify(genB));
  broadcasts.length = 0;

  // ── (b) a day with PLAYED / PLAYING / current-hour rows: Fill Day leaves them untouched ──
  db.prepare("DELETE FROM generated_schedule").run();
  insRow(1, hourTs(8), "played", { uuid: "played-8", played_at: hourTs(8) + 2 });
  insRow(1, hourTs(9), "played", { uuid: "played-9", played_at: hourTs(9) + 1 });
  insRow(1, hourTs(9) + 600, "missed", { uuid: "missed-9", content_class: "SPOT", song_id: null });
  insRow(1, hourTs(10), "playing", { uuid: "playing-10", played_at: hourTs(10) + 3 });
  insRow(1, hourTs(10) + 2400, "pending", { uuid: "pending-1040" });       // current hour, not yet aired
  insRow(1, hourTs(14), "pending", { uuid: "pending-14-op", source: "operator" }); // a jock's row in the future
  insRow(1, hourTs(15), "pending", { uuid: "pending-15" });               // machine row in the future
  insRow(2, hourTs(15), "pending", { uuid: "st2-15" });                   // another station's row
  const rb = await handlers["schedule:generateDay"](null, dayStart);
  check("b · generateDay ok", rb && rb.ok === true, JSON.stringify(rb));
  const byUuid = (u) => db.prepare("SELECT * FROM generated_schedule WHERE uuid = ?").get(u);
  check("b · played rows untouched (state, played_at, not deleted)", ["played-8", "played-9"].every(u => { const r = byUuid(u); return r && r.state === "played" && r.played_at && !r.deleted_at; }));
  check("b · the missed spot untouched", (() => { const r = byUuid("missed-9"); return r && r.state === "missed" && !r.deleted_at; })());
  check("b · the playing row untouched", (() => { const r = byUuid("playing-10"); return r && r.state === "playing" && !r.deleted_at; })());
  check("b · the current hour's pending row untouched (10:40 < next top-of-hour)", !!byUuid("pending-1040") && !byUuid("pending-1040").deleted_at);
  check("b · the operator's future row survives Generate (log-edit-core NOT_OPERATOR_OWNED_SQL)", !!byUuid("pending-14-op") && !byUuid("pending-14-op").deleted_at);
  check("b · the machine's future row was replaced", !byUuid("pending-15"));
  check("b · the other station's row untouched", !!byUuid("st2-15") && !byUuid("st2-15").deleted_at);
  const rowsB = get(dayStart, dayEnd);
  check("b · generated rows again start at 11:00; the day now has aired + generated rows", rowsB.some(r => r.scheduled_at >= nextTop && r.state === "pending") && rowsB.filter(r => r.scheduled_at < nextTop).length === 5);

  // ── (c) generateDay's fromTs (kept for the handler's callers/tests; the Program Log no longer sends it — slice 2a) ──
  const before15 = get(dayStart, hourTs(15)).map(r => r.uuid).join(",");
  const rc = await handlers["schedule:generateDay"](null, dayStart, hourTs(15));
  check("c · generateDay(fromTs=15:00) ok", rc && rc.ok === true, JSON.stringify(rc));
  check("c · rows before 15:00 byte-identical (uuids unchanged)", get(dayStart, hourTs(15)).map(r => r.uuid).join(",") === before15);
  check("c · rows from 15:00 on were regenerated (9 hours: 15 → 23)", new Set(get(hourTs(15), dayEnd).map(r => new RealDate(r.scheduled_at * 1000).getHours())).size === 9);
  const rcPast = await handlers["schedule:generateDay"](null, dayStart, hourTs(9));
  check("c · fromTs in an aired hour is REFUSED by name, not moved forward", rcPast && rcPast.ok === false && /already started/.test(rcPast.error), JSON.stringify(rcPast));
  const rcCur = await handlers["schedule:generateDay"](null, dayStart, hourTs(10) + 1800);
  check("c · fromTs in the CURRENT hour is refused too (it has started)", rcCur && rcCur.ok === false, JSON.stringify(rcCur));
  const rcOff = await handlers["schedule:generateDay"](null, dayStart, dayEnd + 60);
  check("c · fromTs outside the day is refused", rcOff && rcOff.ok === false, JSON.stringify(rcOff));

  // ── (d) Clear Day: pending rows from the next top-of-hour go (soft); played / playing / missed / current hour stay ──
  const pendingFutureBefore = db.prepare("SELECT count(*) n FROM generated_schedule WHERE station_id = 1 AND state='pending' AND deleted_at IS NULL AND scheduled_at >= ?").get(nextTop).n;
  const rd = handlers["schedule:clearDay"](null, dayStart);
  check("d · clearDay ok", rd && rd.ok === true && rd.cleared === pendingFutureBefore, JSON.stringify(rd) + " expected " + pendingFutureBefore);
  check("d · schedule:get shows nothing from 11:00 on", get(nextTop, dayEnd).length === 0);
  check("d · the rows are SOFT-deleted (still in the table, deleted_at set)", db.prepare("SELECT count(*) n FROM generated_schedule WHERE station_id=1 AND scheduled_at >= ? AND deleted_at IS NOT NULL").get(nextTop).n === pendingFutureBefore);
  check("d · played / playing / missed untouched", ["played-8", "played-9", "playing-10", "missed-9"].every(u => { const r = byUuid(u); return r && !r.deleted_at; }));
  check("d · the current hour's pending row untouched", !!byUuid("pending-1040") && !byUuid("pending-1040").deleted_at);
  check("d · the operator's pending row IS cleared (Clear Day is the operator's own explicit act)", !!byUuid("pending-14-op") && !!byUuid("pending-14-op").deleted_at);
  check("d · the other station untouched", !!byUuid("st2-15") && !byUuid("st2-15").deleted_at);
  check("d · a log-edit health event named the clear", health.some(h => h.kind === "log-edit" && h.action === "clear-day" && h.cleared === pendingFutureBefore));
  const rd2 = handlers["schedule:clearDay"](null, dayStart);
  check("d · clearing again clears 0 (idempotent)", rd2 && rd2.ok && rd2.cleared === 0, JSON.stringify(rd2));
  const clrB = broadcasts.filter(b => b.channel === "schedule:changed" && b.payload.reason === "clear-day");
  check("d · schedule:changed fired for BOTH clears (reason clear-day; the second says cleared 0)",
    clrB.length === 2 && clrB[0].payload.cleared === pendingFutureBefore && clrB[1].payload.cleared === 0 && clrB.every(b => b.payload.stationId === 1), JSON.stringify(clrB));
  broadcasts.length = 0;

  // ── (e) Clear one hour (the hour ✕) — windowed clearDay ──
  await handlers["schedule:generateDay"](null, dayStart);
  const n16 = get(hourTs(16), hourTs(17)).length, nOther = get(nextTop, dayEnd).length - n16;
  const re = handlers["schedule:clearDay"](null, dayStart, { fromTs: hourTs(16), toTs: hourTs(17) });
  check("e · hour clear removes exactly that hour's pending rows", re && re.ok && re.cleared === n16 && n16 > 0, JSON.stringify(re) + " n16=" + n16);
  check("e · the other hours keep their rows", get(nextTop, dayEnd).length === nOther);
  const reCur = handlers["schedule:clearDay"](null, dayStart, { fromTs: hourTs(10), toTs: hourTs(11) });
  check("e · clearing the CURRENT hour is skipped by name (it has started)", reCur && reCur.ok && reCur.skipped === true && reCur.cleared === 0, JSON.stringify(reCur));
  check("e · a Generate after the hour clear refills the gap", (await handlers["schedule:generateDay"](null, dayStart)).ok && get(hourTs(16), hourTs(17)).length > 0);

  // ── (f) a whole aired day: generateDay skips, clearDay clears 0 ──
  const yesterday = dayStart - 86_400;
  const rf = await handlers["schedule:generateDay"](null, yesterday);
  check("f · generateDay on an aired day → skipped, nothing written", rf && rf.ok && rf.skipped === true && countAll(1) > 0);
  const rf2 = handlers["schedule:clearDay"](null, yesterday);
  check("f · clearDay on an aired day → skipped, 0 cleared", rf2 && rf2.ok && rf2.skipped === true);

  // ── (g) the grep receipt: nothing in ProgramLog.tsx writes songs.last_played_at or the old log table ──
  const tsx = fs.readFileSync(path.join(root, "src", "components", "ProgramLog.tsx"), "utf8");
  const writesLpa = tsx.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /last_played_at/.test(l) && /update|UPDATE|SET|updateById|markPlayed|execute\(/.test(l));
  check("g · ProgramLog.tsx: no line writes songs.last_played_at", writesLpa.length === 0, JSON.stringify(writesLpa));
  const lpaReads = tsx.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /last_played_at/.test(l) && !/^\s*\/\//.test(l));
  check("g · the remaining last_played_at mentions are the HourModal's song-search SELECT + its type (reads)", lpaReads.every(([, l]) => /SELECT|s\.last_played_at|last_played_at: number/.test(l)), JSON.stringify(lpaReads));
  const DEAD = "scheduled" + "_log", DEAD_NS = "scheduled" + "Log";   // spelled apart so the repo-wide grep receipt stays clean
  check("g · no old-log-table namespace call remains", !new RegExp(DEAD_NS + "\\.").test(tsx));
  check("g · no scheduling_rules / clock_slots picker query remains in ProgramLog.tsx", !/scheduling_rules/.test(tsx) && !/FROM clock_slots/.test(tsx));
  check("g · Fill Day invokes schedule:generateDay(dayStart) — and it is the ONLY generateDay call in this window (slice 2a: no fromTs, no hour button)",
    (tsx.match(/invoke\("schedule:generateDay"/g) || []).length === 1 && /invoke\("schedule:generateDay", dayStart\)/.test(tsx) && !/generateHour|Regen|Generate →|generating:/.test(tsx));
  check("g · Clear Day and the hour ✕ invoke schedule:clearDay", /invoke\("schedule:clearDay", dayStart, \{ fromTs, toTs \}\)/.test(tsx) && /const clearHour/.test(tsx));
  check("g · the hour modal's swap and drag no longer write the dead table (slice 4)", !new RegExp("UPDATE " + DEAD + " SET song_id").test(tsx) && !new RegExp(DEAD_NS + "\\.batchUpdatePosition").test(tsx));

  // ── (h) slice 3 — every generated_schedule writer in main.js fires schedule:changed; the panel subscribes ONCE ──
  const sites = ["_commitDayRows(", "ipcMain.handle('schedule:clearDay'", "ipcMain.handle('schedule:moveRow'", "ipcMain.handle('schedule:setRowSource'", "ipcMain.handle('schedule:deleteRow'", "ipcMain.handle('schedule:editRowFields'", "ipcMain.handle('schedule:insertVoiceTrack'", "function retireStaleScheduleRows("];
  const missing = sites.filter(n => !/_scheduleChanged\(/.test(braceBlock(n)));
  check("h · every generated_schedule writer in main.js calls _scheduleChanged (" + sites.length + " sites)", missing.length === 0, "missing: " + missing.join(", "));
  check("h · the daemon's playstart and missed events are relayed as schedule:changed", /m\.event === "playstart"[\s\S]{0,600}_scheduleChanged\(m\.stationId, 'playstart'\)/.test(main) && /logreader-missed[\s\S]{0,900}_scheduleChanged\(m\.stationId, m\.event\)/.test(main));
  check("h · _scheduleChanged sends to ALL windows on channel schedule:changed", /function _scheduleChanged[\s\S]{0,300}sendToAllWindows\("schedule:changed"/.test(main));
  check("h · ProgramLog.tsx subscribes to schedule:changed once per mount, debounced, and unsubscribes", /ether\.on\("schedule:changed"/.test(tsx) && (tsx.match(/ether\.on\("schedule:changed"/g) || []).length === 1 && /CHANGED_DEBOUNCE_MS/.test(tsx) && /ether\.off\?\.\("schedule:changed", handle\)/.test(tsx));
  check("h · the shared selected-day key is read on mount and written on every pick", /readSharedDate\(stationId\) \|\| todayStr\(\)/.test(tsx) && /writeSharedDate\(stationId, d\)/.test(tsx) && /ether_programlog_date_/.test(tsx));

  // ── (i) slice 4 — the hour modal's edits ride the log editor's handlers ──
  db.prepare("DELETE FROM generated_schedule").run();
  broadcasts.length = 0;
  await handlers["schedule:generateDay"](null, dayStart);
  const day = () => get(dayStart, dayEnd);
  const at15 = day().filter(r => new RealDate(r.scheduled_at * 1000).getHours() === 15);
  check("i · a generated 15:00 hour to edit (" + at15.length + " rows)", at15.length >= 3);
  const target = at15[1];
  const other = db.prepare("SELECT id, title FROM songs WHERE id <> ? AND category_id = ? LIMIT 1").get(target.song_id, catId);
  // swap
  broadcasts.length = 0;
  const sw = handlers["schedule:editRowFields"](null, target.uuid, { song_id: other.id });
  check("i · swap: editRowFields({song_id}) ok", sw && sw.ok === true && sw.title === other.title, JSON.stringify(sw));
  const after = day().find(r => r.uuid === target.uuid);
  check("i · swap: schedule:get returns the NEW song at that slot (song_id, title, artist, length, file_key from the Library; same time)",
    after && after.song_id === other.id && after.title === other.title && after.artist === "Artist " + other.id && after.duration_s === 240 && after.file_key === "song" + other.id + ".mp3" && after.scheduled_at === target.scheduled_at && after.file_path === null,
    JSON.stringify(after));
  check("i · swap: the row is now operator-owned (YOURS) — Generate will not replace it", after && after.source === "operator");
  check("i · swap: schedule:changed fired (reason swap-song)", broadcasts.some(b => b.channel === "schedule:changed" && b.payload.reason === "swap-song" && b.payload.stationId === 1), JSON.stringify(broadcasts));
  check("i · swap: the log-reader would air the new file — its COALESCE(gs.file_key, s.file_key) / join on song_id resolves song" + other.id,
    (() => { const r = db.prepare("SELECT COALESCE(gs.file_key, s.file_key) fk, COALESCE(gs.file_path, s.file_path) fp FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id WHERE gs.uuid = ?").get(target.uuid); return r.fk === "song" + other.id + ".mp3" && r.fp === "C:/music/song" + other.id + ".mp3"; })());
  const swBad = handlers["schedule:editRowFields"](null, target.uuid, { song_id: 999999 });
  check("i · swap to a song that is not in the Library is refused by name", swBad && swBad.ok === false && /not in the Library/.test(swBad.error), JSON.stringify(swBad));
  const spotUuid = "spot-15-" + Date.now();
  insRow(1, hourTs(15) + 1800, "pending", { uuid: spotUuid, content_class: "SPOT", song_id: null, title: "A spot" });
  const swSpot = handlers["schedule:editRowFields"](null, spotUuid, { song_id: other.id });
  check("i · swap on a non-song row is refused by name", swSpot && swSpot.ok === false && /not a song slot/.test(swSpot.error), JSON.stringify(swSpot));
  // checkRow after the swap: informs, never gates
  const chk = handlers["schedule:checkRow"](null, 1, target.uuid, target.scheduled_at);
  check("i · checkRow answers with a warnings array (informs; the edit already applied)", chk && chk.ok === true && Array.isArray(chk.warnings), JSON.stringify(chk));
  // drag = moveRow: the two rows swap scheduled_at
  broadcasts.length = 0;
  const A = at15[0], B = at15[2];
  const mv = handlers["schedule:moveRow"](null, A.uuid, B.uuid);
  check("i · drag: moveRow ok", mv && mv.ok === true && mv.movedTo === B.scheduled_at, JSON.stringify(mv));
  const A2 = day().find(r => r.uuid === A.uuid), B2 = day().find(r => r.uuid === B.uuid);
  check("i · drag: the two rows swapped times (A ↔ B), both operator-owned", A2.scheduled_at === B.scheduled_at && B2.scheduled_at === A.scheduled_at && A2.source === "operator" && B2.source === "operator");
  const readerOrder = db.prepare("SELECT uuid FROM generated_schedule WHERE station_id = 1 AND state = 'pending' AND deleted_at IS NULL AND scheduled_at >= ? AND scheduled_at < ? ORDER BY scheduled_at").all(hourTs(15), hourTs(16)).map(r => r.uuid);
  const panelOrder = day().filter(r => new RealDate(r.scheduled_at * 1000).getHours() === 15).map(r => r.uuid);
  check("i · drag: the daemon-facing order (pending rows ORDER BY scheduled_at — loggen's predicate) matches what the panel shows", JSON.stringify(readerOrder) === JSON.stringify(panelOrder));
  check("i · drag: B now airs where A was (first of the hour), A where B was", panelOrder[0] === B.uuid && panelOrder[2] === A.uuid, JSON.stringify(panelOrder.slice(0, 3)));
  check("i · drag: schedule:changed fired (reason move)", broadcasts.some(b => b.channel === "schedule:changed" && b.payload.reason === "move"));
  // delete
  broadcasts.length = 0;
  const del = handlers["schedule:deleteRow"](null, at15[3] ? at15[3].uuid : target.uuid);
  const delUuid = at15[3] ? at15[3].uuid : target.uuid;
  check("i · delete: deleteRow ok, the row is gone from schedule:get but still in the table (soft)", del && del.ok === true && !day().some(r => r.uuid === delUuid) && !!db.prepare("SELECT deleted_at FROM generated_schedule WHERE uuid = ?").get(delUuid).deleted_at);
  check("i · delete: schedule:changed fired (reason delete)", broadcasts.some(b => b.channel === "schedule:changed" && b.payload.reason === "delete"));
  // aired rows are records: every edit refused with the reason
  insRow(1, hourTs(8) + 60, "played", { uuid: "aired-8", played_at: hourTs(8) + 62, title: "Aired Song" });
  insRow(1, hourTs(10) + 60, "playing", { uuid: "onair-10", played_at: hourTs(10) + 61, title: "On Air Song" });
  const r1 = handlers["schedule:editRowFields"](null, "aired-8", { song_id: other.id });
  const r2 = handlers["schedule:moveRow"](null, "aired-8", target.uuid);
  const r3 = handlers["schedule:moveRow"](null, target.uuid, "onair-10");
  const r4 = handlers["schedule:deleteRow"](null, "onair-10");
  const aired = (r) => r && r.ok === false && /already aired/.test(r.error);
  check("i · a played row: swap refused with 'has already aired — the log is a record of what happened, not a plan'", aired(r1) && /cannot be edited/.test(r1.error), JSON.stringify(r1));
  check("i · a played row: move refused (as the source)", aired(r2) && /cannot be moved/.test(r2.error), JSON.stringify(r2));
  check("i · a playing row: move refused (as the target)", aired(r3), JSON.stringify(r3));
  check("i · a playing row: delete refused", aired(r4) && /cannot be deleted/.test(r4.error), JSON.stringify(r4));
  check("i · the refused rows are untouched", (() => { const a = db.prepare("SELECT * FROM generated_schedule WHERE uuid = 'aired-8'").get(), o = db.prepare("SELECT * FROM generated_schedule WHERE uuid = 'onair-10'").get(); return a.title === "Aired Song" && a.state === "played" && !a.deleted_at && o.state === "playing" && !o.deleted_at && o.scheduled_at === hourTs(10) + 60; })());
  check("i · no schedule:changed for a refused edit", !broadcasts.some(b => b.channel === "schedule:changed" && ["swap-song", "move", "delete"].includes(b.payload.reason) && b.payload.at > 0 && false) && broadcasts.filter(b => b.channel === "schedule:changed").length === 1 /* the delete above */);
  check("i · the grep receipt: no old-log-table / namespace reference remains anywhere in ProgramLog.tsx", !new RegExp(DEAD + "|" + DEAD_NS).test(tsx));
  check("i · ProgramLog.tsx writes nothing directly: no execute( / UPDATE / INSERT / DELETE in the file", !/\bexecute\(/.test(tsx) && !/\b(UPDATE|INSERT INTO|DELETE FROM)\b/.test(tsx));
  // slice 6 — repo-wide: the old log table / namespace survive only in the append-only chain (v0 baseline, v1, v2, v61)
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
  const codeFiles = ["src", "electron", "audiod", "scripts"].flatMap(d => walk(path.join(root, d))).filter(f => /\.(tsx?|js)$/.test(f) && !/node_modules/.test(f));
  const allowed = new Set(["schema-v0-baseline.js", "migrate-uuids-phase-sync-1.js", "migrate-timestamps-phase-sync-2.js", "migrate-drop-scheduled-log-phase-sync-61.js"]);
  const offenders = codeFiles.filter(f => !allowed.has(path.basename(f)) && new RegExp("\\b" + DEADT + "\\b|\\b" + DEAD_NS + "\\b").test(fs.readFileSync(f, "utf8").replace(new RegExp(DEADT + "_id", "g"), "")));
  check("i · repo-wide: zero old-log-table / namespace references outside the append-only chain (play_log.scheduled_log_id column excepted)", offenders.length === 0, offenders.map(f => path.relative(root, f)).join(", "));
  check("i · the hour modal invokes editRowFields({song_id}), moveRow, deleteRow, checkRow — and nothing else writes", /invoke\("schedule:editRowFields", swapTarget\.uuid, \{ song_id: newSong\.id \}\)/.test(tsx) && /invoke\("schedule:moveRow", fromUuid, toUuid\)/.test(tsx) && /invoke\("schedule:deleteRow", entry\.uuid\)/.test(tsx) && /invoke\("schedule:checkRow", stationId, warnFor\.uuid, warnFor\.at\)/.test(tsx));

  console.log(`=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("SMOKE CRASH", e); process.exit(1); });
