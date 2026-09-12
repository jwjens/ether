'use strict';
// scripts/verify-migration-against-snapshot.js
//
// Run a migration against a REAL customer database snapshot and prove what it did.
//
// WHY. verify-transformer-chain.js runs the chain on a FRESH database — v0 baseline through v59 on an
// empty file. That proves the SQL is valid. It does not prove the migration survives a station's
// actual data: 755 MB, years of rows, columns added by builds nobody remembers, and whatever shape a
// catalogue move left behind. Those are different questions and a clean fresh-chain run has never
// been evidence for the second one.
//
// THE ORIGINAL IS NEVER OPENED FOR WRITING. It is copied first, every check runs against the copy,
// and the original's size and mtime are recorded before and compared after — so "we did not touch it"
// is a measurement in the output rather than a promise in a comment.
//
// Usage:
//   cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/verify-migration-against-snapshot.js \
//       --snapshot "P:\\openair.db.ov-20260911.db" --version 59
//
// Exit 0 = every assertion held.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const Database = require('better-sqlite3');

// ── args ─────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const SNAPSHOT = argOf('--snapshot');
const VERSION  = parseInt(argOf('--version'), 10);
const KEEP     = argv.includes('--keep');

if (!SNAPSHOT || !Number.isFinite(VERSION)) {
  console.error('usage: --snapshot <path to a .db> --version <N> [--keep]');
  process.exit(2);
}

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const info = (m) => console.log(`        ${m}`);
const rule = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

// ── locate the migration ─────────────────────────────────────────────────────────────────────────
const scriptsDir = __dirname;
const MIGRATION_RE = new RegExp(`^migrate-.+-phase-sync-${VERSION}\\.js$`);
const migFile = fs.readdirSync(scriptsDir).find((f) => MIGRATION_RE.test(f));
if (!migFile) { console.error(`no migration script for version ${VERSION}`); process.exit(2); }
const mig = require(path.join(scriptsDir, migFile));

// The tables a migration touches. v59 exports its own list; anything else must say so or we cannot
// report per-table numbers and say so plainly rather than inventing them.
const TABLES = Array.isArray(mig.TABLES) ? mig.TABLES : null;

rule(`MIGRATION v${VERSION} — ${migFile}`);
info(`snapshot:  ${SNAPSHOT}`);

// ── 0. the original, recorded ────────────────────────────────────────────────────────────────────
const before = fs.statSync(SNAPSHOT);
info(`original:  ${before.size.toLocaleString()} bytes, mtime ${before.mtime.toISOString()}`);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-mig-verify-'));
const COPY = path.join(workDir, path.basename(SNAPSHOT));
rule('STEP 0 — copy, so the original is never opened for writing');
const t0 = Date.now();
fs.copyFileSync(SNAPSHOT, COPY);
info(`copied to ${COPY} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const side of ['-wal', '-shm']) {
  if (fs.existsSync(SNAPSHOT + side)) { fs.copyFileSync(SNAPSHOT + side, COPY + side); info(`copied sidecar ${side}`); }
}

const db = new Database(COPY, { fileMustExist: true });
const one  = (sql, ...a) => db.prepare(sql).get(...a);
const all  = (sql, ...a) => db.prepare(sql).all(...a);
const cols = (t) => { try { return all(`PRAGMA table_info(${t})`).map(r => r.name); } catch { return []; } };
const tableExists = (t) => !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", t);
const count = (t) => { try { return one(`SELECT COUNT(*) n FROM ${t}`).n; } catch { return null; } };

// ── 1. integrity, before ─────────────────────────────────────────────────────────────────────────
rule('STEP 1 — integrity check BEFORE');
const integBefore = one('PRAGMA integrity_check');
const integBeforeVal = integBefore && (integBefore.integrity_check ?? Object.values(integBefore)[0]);
if (integBeforeVal === 'ok') pass('integrity_check = ok');
else fail(`integrity_check = ${integBeforeVal} — the snapshot is damaged BEFORE any migration ran`);

const fkBefore = all('PRAGMA foreign_key_check');
if (fkBefore.length === 0) pass('foreign_key_check clean');
else info(`foreign_key_check reported ${fkBefore.length} row(s) — pre-existing, recorded not judged`);

// ── 2. the state before ──────────────────────────────────────────────────────────────────────────
rule('STEP 2 — state BEFORE');
const verBefore = all('SELECT version FROM schema_version ORDER BY version').map(r => r.version);
info(`schema_version: ${verBefore.length} row(s), max ${Math.max(...verBefore)}`);
if (!verBefore.includes(VERSION)) pass(`v${VERSION} is NOT yet recorded — this snapshot has not seen it`);
else fail(`v${VERSION} is already recorded in this snapshot — re-run would not be a first run`);

const rowsBefore = {};
const colsBefore = {};
if (TABLES) {
  for (const t of TABLES) {
    if (!tableExists(t)) { info(`${t.padEnd(20)} ABSENT on this install`); rowsBefore[t] = null; continue; }
    rowsBefore[t] = count(t);
    colsBefore[t] = cols(t);
    info(`${t.padEnd(20)} ${String(rowsBefore[t]).padStart(8)} rows · ${colsBefore[t].length} columns`);
  }
} else {
  info('this migration exports no TABLES list; per-table numbers cannot be reported');
}

// A whole-database row census, so "the migration added no rows and dropped none" is measurable
// across the schema rather than only on the five tables it names.
const allTables = all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name);
const censusBefore = {};
for (const t of allTables) censusBefore[t] = count(t);
info(`census: ${allTables.length} tables, ${Object.values(censusBefore).reduce((a, b) => a + (b || 0), 0).toLocaleString()} rows total`);

// ── 3. run it ────────────────────────────────────────────────────────────────────────────────────
rule('STEP 3 — apply the migration');
const tRun = Date.now();
try {
  mig.applyMigration(db);
  pass(`applyMigration completed in ${((Date.now() - tRun) / 1000).toFixed(2)}s`);
} catch (e) {
  fail(`applyMigration THREW: ${e.message}`);
}

// ── 4. integrity, after ──────────────────────────────────────────────────────────────────────────
rule('STEP 4 — integrity check AFTER');
const integAfter = one('PRAGMA integrity_check');
const integAfterVal = integAfter && (integAfter.integrity_check ?? Object.values(integAfter)[0]);
if (integAfterVal === 'ok') pass('integrity_check = ok');
else fail(`integrity_check = ${integAfterVal} — the migration damaged the database`);

// ── 5. columns and fill ──────────────────────────────────────────────────────────────────────────
rule('STEP 5 — the columns, and what is in them');
const fillAfter = {};
if (TABLES) {
  for (const t of TABLES) {
    if (!tableExists(t)) { info(`${t.padEnd(20)} ABSENT — correctly skipped`); continue; }
    const c = cols(t);

    // WHICH COLUMNS DID IT ACTUALLY ADD? DIFFED, NOT ASSUMED.
    //
    // This block hard-coded `file_key`, because it was written for v59. Run against v60 — which adds
    // requester_token — it reported "file_key MISSING after the migration" and printed DO NOT SHIP
    // over a migration that was entirely correct. A guard that cries wolf is worse than no guard:
    // the next real failure gets waved through by whoever remembers this one. The tool now asks the
    // database what changed instead of assuming it already knows.
    const added = c.filter((x) => !(colsBefore[t] || []).includes(x));
    if (added.length === 0) { fail(`${t}: the migration added no column to this table`); continue; }
    pass(`${t}: added ${added.join(', ')}`);

    const total = count(t);
    fillAfter[t] = {};
    for (const col of added) {
      // How much of the new column is filled. A BACKFILLED column shows a number; a purely additive
      // one shows 0. Both are reported as the fact they are, and neither is judged here — what is
      // correct depends on the migration, and the migration says so in its own header.
      const filled = one(`SELECT COUNT(*) n FROM ${t} WHERE "${col}" IS NOT NULL AND "${col}" != ''`).n;
      fillAfter[t][col] = filled;
      info(`${(t + '.' + col).padEnd(34)} filled ${String(filled).padStart(7)} of ${String(total).padStart(7)} row(s)`);

      // A column meant to hold a BASENAME must never hold a directory — that is file_path's defect,
      // and the check is worth keeping wherever the name says it applies.
      if (/key$|basename/i.test(col)) {
        const withSep = one(`SELECT COUNT(*) n FROM ${t} WHERE "${col}" LIKE '%/%' OR "${col}" LIKE '%\\%'`).n;
        if (withSep === 0) pass(`${t}.${col}: no value contains a path separator`);
        else fail(`${t}.${col}: ${withSep} value(s) contain a directory — that is a path, not an identity`);
      }

      // If the migration backfills FROM file_path, every row that has one should have a value.
      if (filled > 0 && (colsBefore[t] || []).includes('file_path')) {
        const withPath = one(`SELECT COUNT(*) n FROM ${t} WHERE file_path IS NOT NULL AND file_path != ''`).n;
        if (filled === withPath) pass(`${t}.${col}: every row with a file_path got a value`);
        else fail(`${t}.${col}: ${withPath - filled} row(s) have a file_path but no ${col}`);
      }
    }
  }
}

// ── 6. nothing gained or lost ────────────────────────────────────────────────────────────────────
rule('STEP 6 — row counts, before vs after');
let drifted = 0;
for (const t of allTables) {
  const a = count(t);
  if (a !== censusBefore[t]) {
    drifted++;
    const delta = (a ?? 0) - (censusBefore[t] ?? 0);
    if (t === 'schema_version' && delta === 1) info(`${t.padEnd(24)} ${censusBefore[t]} → ${a}  (+1, the version record — expected)`);
    else fail(`${t}: ${censusBefore[t]} → ${a} (${delta > 0 ? '+' : ''}${delta}) — a schema migration must not change row counts`);
  }
}
if (drifted <= 1) pass('no table gained or lost rows except schema_version');
info(`checked ${allTables.length} tables`);

// ── 7. idempotence ───────────────────────────────────────────────────────────────────────────────
rule('STEP 7 — run it a SECOND time');
const snapBeforeRerun = {};
for (const t of allTables) snapBeforeRerun[t] = count(t);
const verCountBefore = one("SELECT COUNT(*) n FROM schema_version WHERE version = ?", VERSION).n;

try {
  mig.applyMigration(db);
  pass('second applyMigration completed without throwing');
} catch (e) {
  fail(`second applyMigration THREW: ${e.message}`);
}

let rerunDrift = 0;
for (const t of allTables) if (count(t) !== snapBeforeRerun[t]) {
  rerunDrift++;
  fail(`${t}: row count changed on the second run (${snapBeforeRerun[t]} → ${count(t)})`);
}
if (rerunDrift === 0) pass('the second run changed no row counts');

const verCountAfter = one("SELECT COUNT(*) n FROM schema_version WHERE version = ?", VERSION).n;
if (verCountAfter === verCountBefore) pass(`schema_version has exactly ${verCountAfter} row for v${VERSION} after two runs`);
else fail(`schema_version gained a duplicate v${VERSION} row (${verCountBefore} → ${verCountAfter})`);

if (TABLES) {
  for (const t of TABLES) {
    if (!fillAfter[t]) continue;
    for (const [col, was] of Object.entries(fillAfter[t])) {
      const now = one(`SELECT COUNT(*) n FROM ${t} WHERE "${col}" IS NOT NULL AND "${col}" != ''`).n;
      if (now === was) pass(`${t}.${col}: fill unchanged by the second run (${now})`);
      else fail(`${t}.${col}: fill changed on re-run (${was} → ${now})`);
    }
  }
}

if (typeof mig.isAlreadyMigrated === 'function') {
  if (mig.isAlreadyMigrated(db)) pass('isAlreadyMigrated() reports true afterwards');
  else fail('isAlreadyMigrated() still reports false after a successful migration');
}

const integFinal = one('PRAGMA integrity_check');
const integFinalVal = integFinal && (integFinal.integrity_check ?? Object.values(integFinal)[0]);
if (integFinalVal === 'ok') pass('integrity_check = ok after two runs');
else fail(`integrity_check = ${integFinalVal} after the second run`);

db.close();

// ── 8. the original, untouched ───────────────────────────────────────────────────────────────────
rule('STEP 8 — the ORIGINAL, re-measured');
const after = fs.statSync(SNAPSHOT);
info(`original:  ${after.size.toLocaleString()} bytes, mtime ${after.mtime.toISOString()}`);
if (after.size === before.size && after.mtime.getTime() === before.mtime.getTime()) {
  pass('the original snapshot is byte-for-byte the size and mtime it was — never opened for writing');
} else {
  fail('THE ORIGINAL CHANGED — size or mtime differs. Stop and investigate.');
}
for (const side of ['-wal', '-shm']) {
  if (fs.existsSync(SNAPSHOT + side)) fail(`a ${side} sidecar exists beside the ORIGINAL — something opened it`);
}

if (KEEP) info(`copy kept at ${COPY}`);
else { try { fs.rmSync(workDir, { recursive: true, force: true }); info('working copy removed'); } catch {} }

rule(failures === 0
  ? `VERDICT: PASS — v${VERSION} is safe to run against this database.`
  : `VERDICT: FAIL — ${failures} check(s) failed. DO NOT SHIP.`);
process.exit(failures === 0 ? 0 : 1);
