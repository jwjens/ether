'use strict';
// Phase-1b proof: a JIN-tagged track is INVISIBLE to the music selector + artist-separation math, but
// VISIBLE in the library and recorded in play_log (logged, flagged). Mirrors the exact filter SQL wired
// into loggen.js / main.js generator / the separation subquery / reporting. In-memory DB — no live DB.
const path = require('path');
const D = require(path.join('C:', 'openair', 'node_modules', 'better-sqlite3'));
const db = new D(':memory:');
let n = 0; const ok = (m) => console.log(`  [${++n}] ${m} ✓`); const fail = (m) => { console.error('❌ FAIL:', m); process.exit(1); };

db.exec(`
  CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT, station_id INTEGER, deleted_at INTEGER);
  CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, artist_id INTEGER, category_id INTEGER, file_path TEXT,
    rotation_status TEXT DEFAULT 'active', daypart_mask INTEGER DEFAULT 127, no_repeat_hours INTEGER DEFAULT 2,
    content_class TEXT DEFAULT 'MUSIC', station_id INTEGER, deleted_at INTEGER);
  CREATE TABLE play_log (id INTEGER PRIMARY KEY, title TEXT, artist TEXT, file_path TEXT, station_id INTEGER,
    played_at INTEGER, deleted_at INTEGER, content_class TEXT DEFAULT 'MUSIC');
`);
const SID = 1;
db.prepare("INSERT INTO artists (id,name,station_id) VALUES (1,'The Testers',?)").run(SID);
db.prepare("INSERT INTO songs (id,title,artist_id,category_id,file_path,content_class,station_id) VALUES (1,'Real Song',1,10,'/m/song.mp3','MUSIC',?)").run(SID);
db.prepare("INSERT INTO songs (id,title,artist_id,category_id,file_path,content_class,station_id) VALUES (2,'Station ID Jingle',1,10,'/j/jingle.mp3','JIN',?)").run(SID);

// 1) music selector (loggen baseConditions + main.js stmtCandidates filter): MUSIC only
const cands = db.prepare(`SELECT s.id FROM songs s WHERE s.category_id=? AND (s.rotation_status IS NULL OR s.rotation_status!='inactive') AND (s.content_class IS NULL OR s.content_class='MUSIC')`).all(10);
if (cands.some(r => r.id === 2)) fail('JIN appeared in the music candidate selector');
if (!cands.some(r => r.id === 1)) fail('MUSIC song missing from the selector');
ok('music selector returns MUSIC, EXCLUDES the JIN (never pulled into a music slot)');

// 2) library visibility
const lib = db.prepare("SELECT id,content_class FROM songs WHERE station_id=? AND deleted_at IS NULL").all(SID);
if (!lib.some(r => r.id === 2 && r.content_class === 'JIN')) fail('JIN not visible in the library query');
ok('JIN IS visible in the library (id 2, content_class=JIN)');

// 3) artist-separation: a JIN play must NOT block a music song by the same artist
const now = Math.floor(Date.now() / 1000);
db.prepare("INSERT INTO play_log (title,artist,file_path,station_id,played_at,content_class) VALUES ('Station ID Jingle','The Testers','/j/jingle.mp3',?,?, 'JIN')").run(SID, now);
const blocked = db.prepare(`SELECT s2.artist_id FROM play_log pl JOIN songs s2 ON s2.file_path=pl.file_path
  WHERE pl.station_id=? AND pl.deleted_at IS NULL AND pl.played_at > (unixepoch()-3600) AND s2.artist_id IS NOT NULL
    AND (s2.content_class IS NULL OR s2.content_class='MUSIC')`).all(SID);
if (blocked.some(r => r.artist_id === 1)) fail('JIN play entered artist-separation math (blocked the artist)');
ok('JIN play does NOT enter artist-separation (music by the same artist stays eligible)');

// 4) reporting: music count excludes the JIN play; raw play_log still records it
const musicPlays = db.prepare("SELECT COUNT(*) c FROM play_log WHERE station_id=? AND (content_class IS NULL OR content_class='MUSIC')").get(SID).c;
if (musicPlays !== 0) fail(`music reporting counted the JIN play (expected 0, got ${musicPlays})`);
const allPlays = db.prepare("SELECT COUNT(*) c FROM play_log WHERE station_id=?").get(SID).c;
if (allPlays !== 1) fail('JIN play missing from raw play_log');
ok('music reporting excludes the JIN (0 music plays) but play_log records it (1 total) — logged + flagged');

console.log('\n✅ CONTENT-CLASS EXCLUSION — ALL CHECKS PASS (invisible to music math, visible in library + play_log)');
