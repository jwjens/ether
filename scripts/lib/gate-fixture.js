// scripts/lib/gate-fixture.js — the scheduler gate's OWN stations, built from nothing on a blank database.
//
// Jeff, 2026-10-18: "Stop testing my real stations. Stations get deleted and created; my programming is not the test
// subject. The gate builds its OWN test stations from scratch on a blank database: known songs/artists, known rules,
// known clocks and shows, made to hit every case."
//
// The schema (structure only, no rows) is taken from an installed database when one is given — so the gate runs on the
// schema the app really has — and the app's own migration chain is then applied by the caller. Without one, the
// shipped baseline (scripts/schema-v0-baseline.js) is used and the chain brings it up to date. No real station,
// song, rule or play is ever copied.
//
// THE FIXTURES (deterministic; every number here is a fixture, not a product setting):
//   FX-EVENING  one show 15:00–22:00 (no programming outside it: silence there is correct, never reported)
//     rules: song 120 · artist 60 · title 120 min
//     BIG   40 songs, 22 artists (some "A & B" credits, some "(Live)"/"- From …" title variants of each other)
//     SMALL  5 songs by 2 artists, in every third slot → more SMALL slots than its rules allow → UNSCHEDULED
//     two BIG songs carry per-song no-repeat hours (6 h)
//   FX-ALLDAY   one show all day, two timed spot breaks (:20, :40), a spot category with 4 spots
//     rules: song 90 · artist 45 · title off
//     GOLD  60 songs, 35 artists, one recording on TWO song rows (a duplicate under two paths)
//     NEW   15 songs, 12 artists
//   Two days of play history before the run for both (round-robin through the categories, inside show hours).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const FIXTURE_DAY0 = new Date(2026, 10, 2, 0, 0, 0, 0);   // the history ends here; the run starts the next midnight
const uid = (s) => { const h = crypto.createHash("sha1").update("ether-gate-fixture:" + s).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

function blankFromSchema(srcDbPath, outPath) {
  const out = new DatabaseSync(outPath);
  if (srcDbPath && fs.existsSync(srcDbPath)) {
    const src = new DatabaseSync(srcDbPath, { readOnly: true });
    try {
      const objs = src.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END").all();
      for (const o of objs) { try { out.exec(o.sql); } catch { /* an FTS shadow table etc. */ } }
      // the schema's own version record is structure, not programming: the chain reads it to know what is applied
      try { for (const r of src.prepare("SELECT version FROM schema_version").all()) out.prepare("INSERT OR IGNORE INTO schema_version (version) VALUES (?)").run(r.version); } catch {}
    } finally { src.close(); }
    return { out, schemaFrom: "the installed schema (structure only)" };
  }
  const baseline = require(path.join(__dirname, "..", "schema-v0-baseline.js"));
  const shim = { prepare: (q) => out.prepare(q), exec: (q) => out.exec(q), pragma: () => {}, transaction: (fn) => (...a) => fn(...a) };
  baseline(shim);
  return { out, schemaFrom: "scripts/schema-v0-baseline.js" };
}

function cols(db, t) { try { return new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name)); } catch { return new Set(); } }
function insert(db, table, row) {
  const have = cols(db, table);
  const keys = Object.keys(row).filter(k => have.has(k));
  const r = db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => row[k]));
  return Number(r.lastInsertRowid);
}

/** Build the fixture database at outPath. `migrate(dbWrapper)` is the caller's migration chain (main.js runMigrationChain). */
function buildFixtureDb(outPath, { schemaFrom, migrate } = {}) {
  const { out: db, schemaFrom: how } = blankFromSchema(schemaFrom, outPath);
  const w = { prepare: (q) => db.prepare(q), exec: (q) => db.exec(q), transaction: (fn) => (...a) => { db.exec("SAVEPOINT fx"); try { const r = fn(...a); db.exec("RELEASE fx"); return r; } catch (e) { db.exec("ROLLBACK TO fx"); db.exec("RELEASE fx"); throw e; } } };
  if (migrate) migrate(w);
  const iso = new Date(2026, 9, 1).toISOString();
  try { insert(db, "client_identity", { client_id: "fixture-machine-0000", created_at: iso }); } catch {}
  // The sync clock a fresh install seeds (scripts/migrate-mutations-phase-sync-3.js): infrastructure, not programming.
  try { db.prepare("INSERT OR IGNORE INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, unixepoch())").run("0:0:fixture-machine-0000"); } catch {}

  const stations = [];
  const mkStation = (key, name) => {
    const id = insert(db, "stations", { name, uuid: uid("station:" + key), is_active: 1, created_at: iso, updated_at: iso, scheduler_mode: "clock" });
    insert(db, "station_config_kv", { station_id: id, key: "log_reader_flip", value: "1", uuid: uid(key + ":flip"), created_at: iso, updated_at: iso });
    stations.push({ id, key, name, uuid: uid("station:" + key) });
    return id;
  };
  const artistIds = new Map();
  const artist = (name) => { if (!artistIds.has(name)) artistIds.set(name, insert(db, "artists", { name, uuid: uid("artist:" + name), created_at: iso, updated_at: iso })); return artistIds.get(name); };
  const category = (sid, code) => insert(db, "categories", { station_id: sid, code, name: code, uuid: uid(`cat:${sid}:${code}`), created_at: iso, updated_at: iso });
  const song = (catId, title, artistName, file, secs, extra = {}) => insert(db, "songs", {
    title, artist_id: artist(artistName), category_id: catId, file_path: "C:/fixture/" + file, file_key: file, duration_ms: secs * 1000,
    content_class: "MUSIC", daypart_mask: 16777215, no_repeat_hours: null, uuid: uid("song:" + catId + ":" + title + ":" + file), created_at: iso, updated_at: iso, ...extra });
  const rule = (sid, type, value, active = 1) => insert(db, "separation_rules", { station_id: sid, rule_type: type, value, is_active: active, is_hard: 1, scope: "station", uuid: uid(`rule:${sid}:${type}`), created_at: iso, updated_at: iso });
  const clock = (sid, name) => insert(db, "clocks", { station_id: sid, name, uuid: uid(`clock:${sid}:${name}`), created_at: iso, updated_at: iso });
  const slot = (sid, clockId, pos, type, catId, extra = {}) => insert(db, "clock_slots", { clock_id: clockId, position: pos, slot_type: type, category_id: catId, duration_min: 4, station_id: sid, uuid: uid(`slot:${clockId}:${pos}`), created_at: iso, updated_at: iso, ...extra });
  const show = (sid, name, start, end, clockId) => insert(db, "shows", { station_id: sid, name, start_hour: start, end_hour: end, days: "0123456", is_active: 1, clock_id: clockId, uuid: uid(`show:${sid}:${name}`), created_at: iso, updated_at: iso });

  // ── FX-EVENING ──
  const e = mkStation("evening", "FX-EVENING");
  rule(e, "song_separation_min", 120); rule(e, "artist_separation_min", 60); rule(e, "title_separation_min", 120);
  const eBig = category(e, "BIG"), eSmall = category(e, "SMALL");
  const eSongs = [];
  for (let i = 1; i <= 40; i++) {
    const a = i % 7 === 0 ? `Artist E${(i % 22) + 1} & Artist E${((i + 5) % 22) + 1}` : `Artist E${(i % 22) + 1}`;
    const t = i % 9 === 0 ? `Evening Song ${i - 1} (Live)` : i % 13 === 0 ? `Evening Song ${i - 2} - From The Fixture` : `Evening Song ${i}`;
    eSongs.push({ cat: eBig, id: song(eBig, t, a, `e-big-${i}.mp3`, 180 + (i * 17) % 90, i === 4 || i === 21 ? { no_repeat_hours: 6 } : {}), file: `C:/fixture/e-big-${i}.mp3`, title: t, artist: a });
  }
  for (let i = 1; i <= 5; i++) eSongs.push({ cat: eSmall, id: song(eSmall, `Small Song ${i}`, `Small Artist ${(i % 2) + 1}`, `e-small-${i}.mp3`, 200 + i * 11), file: `C:/fixture/e-small-${i}.mp3`, title: `Small Song ${i}`, artist: `Small Artist ${(i % 2) + 1}` });
  const eClock = clock(e, "Evening clock");
  for (let p = 0; p < 15; p++) slot(e, eClock, p, "music", p % 3 === 2 ? eSmall : eBig);
  // A SHOW CHANGE mid-evening: Evening Show 15–21, then Late Show 21–22 on its own clock (shows change on the hour; the
  // schema has no minutes for a show's start).
  show(e, "Evening Show", 15, 21, eClock);
  const lateClock = clock(e, "Late clock");
  for (let p = 0; p < 15; p++) slot(e, lateClock, p, "music", p % 2 ? eSmall : eBig);
  show(e, "Late Show", 21, 22, lateClock);

  // ── FX-ALLDAY ──
  const d = mkStation("allday", "FX-ALLDAY");
  rule(d, "song_separation_min", 90); rule(d, "artist_separation_min", 45); rule(d, "title_separation_min", 120, 0);
  const dGold = category(d, "GOLD"), dNew = category(d, "NEW");
  const dSongs = [];
  for (let i = 1; i <= 60; i++) { const a = `Artist D${(i % 35) + 1}`; dSongs.push({ cat: dGold, id: song(dGold, `Gold Song ${i}`, a, `d-gold-${i}.mp3`, 170 + (i * 23) % 110), file: `C:/fixture/d-gold-${i}.mp3`, title: `Gold Song ${i}`, artist: a }); }
  // one recording on two song rows, stored under two paths (the duplicate case)
  const dupFile = "d-gold-7.mp3";
  dSongs.push({ cat: dGold, id: insert(db, "songs", { title: "Gold Song 7 (duplicate row)", artist_id: artist("Artist D8"), category_id: dGold, file_path: "D:/other-folder/" + dupFile, file_key: dupFile, duration_ms: 170000 + ((7 * 23) % 110) * 1000, content_class: "MUSIC", daypart_mask: 16777215, no_repeat_hours: null, uuid: uid("song:dup"), created_at: iso, updated_at: iso }), file: "D:/other-folder/" + dupFile, title: "Gold Song 7 (duplicate row)", artist: "Artist D8" });
  for (let i = 1; i <= 15; i++) { const a = `New Artist ${(i % 12) + 1}`; dSongs.push({ cat: dNew, id: song(dNew, `New Song ${i}`, a, `d-new-${i}.mp3`, 190 + (i * 13) % 70), file: `C:/fixture/d-new-${i}.mp3`, title: `New Song ${i}`, artist: a }); }
  const spotCat = (() => { try { return insert(db, "spot_categories", { station_id: d, name: "FX spots", uuid: uid("spotcat"), created_at: iso, updated_at: iso }); } catch { return null; } })();
  for (let i = 1; i <= 4; i++) insert(db, "spots", { station_id: d, title: `Fixture Spot ${i}`, advertiser: "Fixture", file_path: `C:/fixture/spot-${i}.mp3`, length_sec: 30, is_active: 1, spot_category_id: spotCat, uuid: uid("spot:" + i), created_at: iso, updated_at: iso });
  const dClock = clock(d, "All-day clock");
  for (let p = 0; p < 14; p++) slot(d, dClock, p, "music", p % 4 === 3 ? dNew : dGold);
  for (const [k, minute] of [[0, 20], [1, 40]]) insert(db, "clock_breaks", { clock_id: dClock, minute, spot_category_id: spotCat, count: 2, sort_order: k, station_id: d, uuid: uid("break:" + minute), created_at: iso, updated_at: iso });
  show(d, "All Day", 0, 0, dClock);

  // ── two days of history, before the run ──
  const t0 = Math.floor(FIXTURE_DAY0.getTime() / 1000);
  const play = (sid, s, ts) => insert(db, "play_log", { title: s.title, artist: s.artist, deck: "A", deck_id: "A", duration_ms: 200000, session_id: "fixture-history", played_at: ts, station_id: sid, uuid: uid(`play:${sid}:${ts}`), created_at: iso, updated_at: iso, file_path: s.file, content_class: "MUSIC" });
  for (let day = 2; day >= 1; day--) {
    let i = day * 7;
    for (let ts = t0 - day * 86400 + 15 * 3600; ts < t0 - day * 86400 + 22 * 3600; ts += 230) play(e, eSongs[i++ % eSongs.length], ts);
    let j = day * 11;
    for (let ts = t0 - day * 86400; ts < t0 - (day - 1) * 86400; ts += 240) play(d, dSongs[j++ % dSongs.length], ts);
  }
  db.close();
  return { path: outPath, stations, schemaFrom: how, historyEnds: t0 };
}

module.exports = { buildFixtureDb, FIXTURE_DAY0 };
