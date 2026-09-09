'use strict';
// COMMITTED ON PURPOSE — a receipt tool, excluded from the installer.
// scripts/verify-channel-on-migration.js — receipt for v58.
//
// Copies the live profile, migrates the COPY, and proves the one thing that matters about this
// column: EVERY EXISTING CHANNEL COMES OUT OPEN. The lamp has always rendered `?? true`, so every
// channel the operator has ever looked at is ON — a column that landed as 0 would cut every source
// channel on the first launch after the update, silently, on a machine that is on air.
//
// The live file is opened READ-ONLY once to prove it is readable, then copied. Nothing writes to it.
const fs = require('fs'), os = require('os'), path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const SRC = process.argv[2] || path.join(process.env.LOCALAPPDATA, 'Ether', 'profiles', 'ETH-STN-BAA8-E056-6FC8', 'openair.db');
const TMP = path.join(os.tmpdir(), `ether-v58-${Date.now()}.db`);

const ro = new Database(SRC, { readonly: true, fileMustExist: true }); ro.close();
fs.copyFileSync(SRC, TMP);
for (const e of ['-wal', '-shm']) if (fs.existsSync(SRC + e)) fs.copyFileSync(SRC + e, TMP + e);
console.log('source (READ-ONLY, never written):', SRC);
console.log('working copy:', TMP);

const db = new Database(TMP);
const cols = (t) => { try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); } catch { return []; } };
let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

console.log('\n--- BEFORE ---');
const beforeRows = db.prepare('SELECT COUNT(*) n FROM deck_configs').get().n;
const beforeSrc  = db.prepare("SELECT COUNT(*) n FROM deck_configs WHERE type='source' AND deleted_at IS NULL").get().n;
console.log(`  deck_configs rows: ${beforeRows}  (source channels: ${beforeSrc})`);
console.log(`  channel_on present: ${cols('deck_configs').includes('channel_on')}`);

console.log('\n--- applying migration v58 to the COPY ---');
require(path.join(__dirname, 'migrate-channel-on-phase-sync-58.js')).applyMigration(db);

console.log('\n--- AFTER ---');
check(cols('deck_configs').includes('channel_on'), 'deck_configs.channel_on exists');

const afterRows = db.prepare('SELECT COUNT(*) n FROM deck_configs').get().n;
check(afterRows === beforeRows, `no rows added or lost (${afterRows}, was ${beforeRows})`);

// THE ONE THAT MATTERS. Not "the default is 1" — that is what the DDL says. This asks the copy.
const off = db.prepare('SELECT COUNT(*) n FROM deck_configs WHERE channel_on = 0').get().n;
check(off === 0, `no channel came out CUT (channels with channel_on=0: ${off})`);

const nulls = db.prepare('SELECT COUNT(*) n FROM deck_configs WHERE channel_on IS NULL').get().n;
check(nulls === 0, `no channel came out UNKNOWN (channel_on IS NULL: ${nulls})`);

// Per-station, so a multi-station install cannot hide one station's channels being cut inside a
// healthy total.
console.log('\n--- per station ---');
for (const r of db.prepare(
  "SELECT station_id, COUNT(*) n, SUM(CASE WHEN channel_on=1 THEN 1 ELSE 0 END) open" +
  "  FROM deck_configs WHERE deleted_at IS NULL GROUP BY station_id ORDER BY station_id").all()) {
  const ok = r.n === r.open;
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  station ${r.station_id}: ${r.open}/${r.n} channels open`);
}

// The schema version must be recorded, or the chain re-runs this every boot.
const v = db.prepare('SELECT COUNT(*) n FROM schema_version WHERE version = 58').get().n;
check(v === 1, `schema_version 58 recorded exactly once (rows: ${v})`);

console.log('\n--- re-running (idempotence) ---');
require(path.join(__dirname, 'migrate-channel-on-phase-sync-58.js')).applyMigration(db);
const off2 = db.prepare('SELECT COUNT(*) n FROM deck_configs WHERE channel_on = 0').get().n;
check(off2 === 0, 'a second run still cuts nothing');
check(db.prepare('SELECT COUNT(*) n FROM deck_configs').get().n === beforeRows, 'a second run adds no rows');

db.close();
for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP + e); } catch {} }

console.log(`\n${fail === 0 ? 'PASS — column added, nothing cut, no data touched.' : 'FAIL — ' + fail + ' problem(s).'}`);
process.exit(fail === 0 ? 0 : 1);
