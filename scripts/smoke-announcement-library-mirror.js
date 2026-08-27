'use strict';
// scripts/smoke-announcement-library-mirror.js — the announcement writer keeps the library in step.
//
// docs/library-current-state.md (Option 1, ruled 2026-08-27)
//
// The panels are filtered views over `library_asset`, so a view can only show what the writer put
// there. Step 4a proved what happens when a reader is flipped and no writer exists: rotation read a
// snapshot frozen at v50. This asserts the writer that makes the panel read safe.
//
// What it pins:
//   • create  → an ANNOUNCEMENT asset row appears, sharing the announcement's uuid
//   • update  → the asset follows the title and file_path
//   • delete  → the asset is soft-deleted too, so the panel stops showing it
//   • both tables JOURNAL, so peers converge — and the asset mutation is a CHILD of the
//     announcement's, because they are written inside one transaction
//   • a no-op update journals nothing new
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/smoke-announcement-library-mirror.js

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const ANN = require(path.join(__dirname, '..', 'electron', 'sync', 'handlers', 'announcements.js'));

const dbPath = path.join(os.tmpdir(), `ether-annmirror-${process.pid}.db`);
try { fs.unlinkSync(dbPath); } catch {}
const db = new Database(dbPath);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('=== smoke-announcement-library-mirror ===');

// Build the schema the way every other smoke does: baseline + the numbered chain, fail-soft.
db.prepare('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)').run();
require(path.join(__dirname, 'schema-v0-baseline.js'))(db);
{
  const RE = /^migrate-.+-phase-sync-(\d+)\.js$/;
  const applied = new Set(db.prepare('SELECT version FROM schema_version').all().map(r => r.version));
  const scripts = [];
  for (const f of fs.readdirSync(__dirname)) { const m = RE.exec(f); if (m) scripts.push({ v: +m[1], file: f }); }
  scripts.sort((a, b) => a.v - b.v);
  for (const { v, file } of scripts) {
    if (applied.has(v)) continue;
    try { require(path.join(__dirname, file)).applyMigration(db); } catch (e) { /* fail-soft, as the app does */ }
  }
}
try { db.prepare("INSERT OR IGNORE INTO client_identity (id, client_id, created_at) VALUES (1,'smoke','2026-01-01')").run(); } catch {}
try { db.prepare("INSERT OR IGNORE INTO stations (id, name, uuid, created_at, updated_at) VALUES (2,'Test Station','st-uuid-2','2026-01-01','2026-01-01')").run(); } catch {}

const muts  = (t) => db.prepare('SELECT * FROM mutations WHERE table_name = ? ORDER BY rowid').all(t);
const asset = (u) => db.prepare('SELECT * FROM library_asset WHERE uuid = ?').get(u);

console.log('\n── create: the announcement lands in the library, typed ──');
const a = ANN.announcementsCreate(db, {
  station_id: 2, title: 'CLOSING IN 15 MINUTES',
  file_path: 'C:\\audio\\closing-15.mp3', trigger_time: '20:45:00',
  days: '1,2,3,4,5', is_active: 1,
});
check('the announcement was created', !!a && a.title, 'CLOSING IN 15 MINUTES');
const la = asset(a.uuid);
check('an asset row exists for it', !!la, true);
check('typed ANNOUNCEMENT', la && la.type, 'ANNOUNCEMENT');
check('SHARES the announcement uuid — the join every reader uses', la && la.uuid, a.uuid);
check('title carried', la && la.title, 'CLOSING IN 15 MINUTES');
check('file_path carried', la && la.file_path, 'C:\\audio\\closing-15.mp3');

console.log('\n── both tables journal, and the asset is a CHILD of the announcement ──');
check('announcements journalled an insert', muts('announcements').map(m => m.op), ['insert']);
check('library_asset journalled an insert', muts('library_asset').map(m => m.op), ['insert']);
// The mutations PK is `id`, not `mutation_id` — the parent link points at the announcement's id.
check('the asset mutation is a child of the announcement mutation',
  muts('library_asset')[0].parent_mutation_id, muts('announcements')[0].id);
check('install-scoped → the asset mutation carries NO station_id', muts('library_asset')[0].station_id, null);
check('station-scoped → the announcement mutation carries its station', String(muts('announcements')[0].station_id), '2');

console.log('\n── update: the library follows ──');
ANN.announcementsUpdate(db, a.uuid, { title: 'CLOSING IN 10 MINUTES' });
check('asset title updated', asset(a.uuid).title, 'CLOSING IN 10 MINUTES');
check('and it journalled', muts('library_asset').map(m => m.op), ['insert', 'update']);

console.log('\n── a no-op update must not journal (the station_config_kv lesson) ──');
ANN.announcementsUpdate(db, a.uuid, { trigger_time: '20:50:00' });   // asset fields unchanged
check('asset journalled nothing new', muts('library_asset').length, 2);

console.log('\n── delete: the panel stops showing it ──');
ANN.announcementsDelete(db, a.uuid, 2);
check('asset is soft-deleted', !!asset(a.uuid).deleted_at, true);
check('and it journalled a delete', muts('library_asset').map(m => m.op), ['insert', 'update', 'delete']);
check('a type-filtered read no longer returns it',
  db.prepare("SELECT COUNT(*) n FROM library_asset WHERE type='ANNOUNCEMENT' AND deleted_at IS NULL").get().n, 0);

console.log('\n── a BLANK title still lands findably in the library ──');
// `announcements.title` is NOT NULL, so null is impossible — but an empty string passes the
// constraint and is what a half-filled form actually produces. The library must not show a
// nameless row, so the filename stands in.
const b = ANN.announcementsCreate(db, { station_id: 2, title: '', file_path: 'C:\\audio\\bare.mp3' });
check('it got a usable title from the filename', asset(b.uuid).title, 'bare.mp3');

console.log('\n── `songs` is not touched by any of this ──');
check('songs row count unchanged', db.prepare('SELECT COUNT(*) n FROM songs').get().n, 0);
check('no SONG-typed assets were created', db.prepare("SELECT COUNT(*) n FROM library_asset WHERE type='SONG'").get().n, 0);

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');

db.close();
try { fs.unlinkSync(dbPath); } catch {}
process.exit(fail === 0 ? 0 : 1);
