'use strict';
// scripts/prove-filekey-filepath.js — READ-ONLY. Sends nothing, deletes nothing.
//
// THE GATE BEFORE ANY DELETE: does `file_key` actually identify the same physical object as
// `file_path`? The sweep marks rows by file_key, but every local check that clears them (play_log)
// matches on file_path. If those two are not the same object, a "marked" row is a decision about
// one file justified by evidence about another.
//
// This does not assume they match. It compares them and reports where they do not. If it cannot
// prove the relationship for a row, that row is reported as UNPROVEN and must not be deleted.
//
// Also emits marked-for-deletion.json — the human-readable list, for review before anything is sent.
//
// Run: ELECTRON_RUN_AS_NODE=1 node_modules\.bin\electron scripts\prove-filekey-filepath.js <copy.db>

const path = require('path');
const fs = require('fs');
const sweep = require(path.join(__dirname, '..', 'electron', 'deletion-sweep.js'));

const dbPath = process.argv[2];
if (!dbPath) { console.error('pass a COPY of the DB (never the live file)'); process.exit(1); }
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(dbPath);
const hr = (t) => console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));

const basename = (p) => (p ? String(p).split(/[\\/]/).pop() : null);

hr('1 — How are file_key and file_path actually stored?');
const sample = db.prepare(`
  SELECT file_key, file_path FROM songs
   WHERE file_key IS NOT NULL AND TRIM(file_key) <> '' AND file_path IS NOT NULL
   LIMIT 5`).all();
for (const s of sample) {
  console.log(`  key : ${s.file_key}`);
  console.log(`  path: ${s.file_path}`);
  console.log(`  basename(path) === key ? ${basename(s.file_path) === s.file_key}\n`);
}

// Population-wide, over every song that has both.
const both = db.prepare(`
  SELECT id, title, file_key, file_path FROM songs
   WHERE file_key IS NOT NULL AND TRIM(file_key) <> '' AND file_path IS NOT NULL AND TRIM(file_path) <> ''`).all();
let exact = 0, differ = 0;
const differing = [];
for (const s of both) {
  if (basename(s.file_path) === s.file_key) exact++;
  else { differ++; differing.push(s); }
}
console.log(`songs with both fields: ${both.length}`);
console.log(`  basename(file_path) === file_key : ${exact}`);
console.log(`  DIFFERENT                        : ${differ}`);
if (differing.length) {
  console.log('\nExamples where they differ — these are NOT provably the same object:');
  for (const s of differing.slice(0, 12)) {
    console.log(`  "${s.title}"`);
    console.log(`     key      : ${s.file_key}`);
    console.log(`     basename : ${basename(s.file_path)}`);
  }
}

hr('2 — The marked rows, proven individually');
const marked = db.prepare("SELECT * FROM deletion_queue WHERE status = 'marked' ORDER BY id").all();
console.log(`marked rows: ${marked.length}`);

const report = [];
let proven = 0, unproven = 0;
for (const q of marked) {
  // The song row the queue came from. file_path may be NULL on `songs` (neuterSong nulls it), which
  // is why the queue captured its own copy at enqueue time.
  const song = db.prepare('SELECT id, title, file_key, file_path, deleted_at FROM songs WHERE file_key = ? ORDER BY id LIMIT 1').get(q.file_key);
  const qBase = basename(q.file_path);
  const ok = !!qBase && qBase === q.file_key;
  if (ok) proven++; else unproven++;
  report.push({
    file_key: q.file_key,
    title: song ? song.title : null,
    station_id: q.station_id,
    queue_file_path: q.file_path,
    basename_of_file_path: qBase,
    key_matches_basename: ok,
    verdict: ok ? 'PROVEN — same object' : 'UNPROVEN — do not delete',
    deleted_at: new Date(q.deleted_at * 1000).toISOString(),
    grace_expires_at: new Date(q.grace_expires_at * 1000).toISOString(),
    reason: q.reason,
  });
  console.log(`\n  "${song ? song.title : '(song row not found)'}"`);
  console.log(`     file_key : ${q.file_key}`);
  console.log(`     file_path: ${q.file_path}`);
  console.log(`     basename : ${qBase}`);
  console.log(`     ${ok ? 'PROVEN — file_key IS the basename of file_path' : 'UNPROVEN — key and path do not agree; DO NOT DELETE'}`);
}

hr('3 — Verdict');
console.log(`proven   : ${proven}`);
console.log(`UNPROVEN : ${unproven}`);
if (unproven > 0) {
  console.log('\nSTOP. At least one marked row cannot be proven to refer to the same physical object.');
  console.log('No DELETE may be sent for any row until that is resolved. Not guessing.');
}

const outFile = path.join(process.cwd(), 'marked-for-deletion.json');
fs.writeFileSync(outFile, JSON.stringify({
  generated: new Date().toISOString(),
  source_db: dbPath,
  mode: 'report-only — nothing has been deleted or sent',
  totals: { marked: marked.length, proven, unproven },
  files: report,
}, null, 2), 'utf8');
console.log(`\nWrote ${outFile}`);

db.close();
console.log('\nSTOPPING HERE by design — the marked list needs review before any DELETE is wired.');
