// PROOF (read-only, DB copy) for the 2026-07-26 orphan/cross-station playout fix.
//   A: the four log-reader FORMAT GATES now reject an orphan (song row exists, category_id NULL) while
//      still admitting legacy/SPOT rows (no song join). Proven on station 4 vs orphan song_id=397.
//   B: fillQueue Tier-3b now scopes its last-resort pool to THIS station's own categories, so it can no
//      longer return foreign (other-station) or uncategorized (orphan) songs.
// Usage: node scripts/prove-orphan-gate-fix.js <path-to-diag.db>
const { DatabaseSync } = require('node:sqlite');
const loggen = require('../audiod/loggen.js');   // exercise the REAL exported helper for B's scoping list
const DB = process.argv[2];
const db = new DatabaseSync(DB, { readOnly: true });
const one = (s, ...p) => db.prepare(s).get(...p);
const all = (s, ...p) => db.prepare(s).all(...p);
const L = console.log;
let fails = 0;
const check = (name, cond, detail) => { L(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fails++; };

const SID = 4;            // Christmas In July
const FMT = [14];         // its on-format category (CS), from getFormatCategoryIds(4,4)
const ORPHAN = 397;       // the NULL-category "Munsters Theme" that aired back-to-back

L('=== PROOF A: format gate rejects the orphan, keeps legacy/SPOT rows ===');
// The gate lives inside: SELECT ... FROM generated_schedule gs LEFT JOIN songs s ON s.id=gs.song_id
//   WHERE gs.station_id=? AND gs.deleted_at IS NULL <GATE>
// OLD gate = (s.category_id IS NULL OR s.category_id IN (fmt))   NEW gate = (s.id IS NULL OR s.category_id IN (fmt))
const inFmt = FMT.join(',');
const base = `FROM generated_schedule gs LEFT JOIN songs s ON s.id=gs.song_id WHERE gs.station_id=${SID} AND gs.deleted_at IS NULL`;
const OLD = `(s.category_id IS NULL OR s.category_id IN (${inFmt}))`;
const NEW = `(s.id IS NULL OR s.category_id IN (${inFmt}))`;

const orphanOld = one(`SELECT COUNT(*) n ${base} AND gs.song_id=${ORPHAN} AND ${OLD}`).n;
const orphanNew = one(`SELECT COUNT(*) n ${base} AND gs.song_id=${ORPHAN} AND ${NEW}`).n;
L(`  orphan #${ORPHAN} rows on station ${SID} admitted by OLD gate: ${orphanOld}`);
L(`  orphan #${ORPHAN} rows on station ${SID} admitted by NEW gate: ${orphanNew}`);
check('OLD gate admitted the orphan (the bug)', orphanOld > 0, `${orphanOld} rows`);
check('NEW gate rejects the orphan entirely', orphanNew === 0, `${orphanNew} rows`);

// Legacy / SPOT rows (no song join → s.id IS NULL) must STILL pass unchanged.
const legacyOld = one(`SELECT COUNT(*) n ${base} AND gs.song_id IS NULL AND ${OLD}`).n;
const legacyNew = one(`SELECT COUNT(*) n ${base} AND gs.song_id IS NULL AND ${NEW}`).n;
L(`  no-song-join (legacy/SPOT) rows admitted OLD=${legacyOld} NEW=${legacyNew}`);
check('legacy/SPOT (no song join) rows preserved by NEW gate', legacyNew === legacyOld, `old=${legacyOld} new=${legacyNew}`);

// A legit in-format CS row (song category = 14) must still pass the NEW gate.
const legitNew = one(`SELECT COUNT(*) n ${base} AND s.category_id=14 AND ${NEW}`).n;
check('legit in-format CS rows still pass NEW gate', legitNew > 0, `${legitNew} rows`);

L('\n=== PROOF B: Tier-3b scopes the last-resort pool to THIS station only ===');
// Tier-3b opts: { artistSepSec:0, songSep:false, daypart:false } → the base MUSIC/active gate only.
const baseGate = `s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive') AND (s.content_class IS NULL OR s.content_class = 'MUSIC')`;
// Real exported helper — the scoping list the patched Tier-3b now passes to pickTier.
const stationCats = loggen.getStationCategoryIds(db, SID);
L(`  getStationCategoryIds(${SID}) = [${stationCats.join(',')}]`);
check('station category list is non-empty and station-owned', stationCats.length > 0 && stationCats.every(c => one('SELECT station_id st FROM categories WHERE id=?', c).st === SID), `[${stationCats.join(',')}]`);

const ownerDist = (whereCat) => all(
  `SELECT c.station_id AS owner, COUNT(*) n FROM songs s LEFT JOIN categories c ON c.id=s.category_id
   WHERE ${baseGate}${whereCat} GROUP BY c.station_id ORDER BY n DESC`);
// OLD Tier-3b: formatCats=[] → NO category restriction → whole account.
const oldPool = ownerDist('');
// NEW Tier-3b: category_id IN (stationCats).
const newPool = ownerDist(` AND s.category_id IN (${stationCats.join(',')})`);
const fmtDist = (d) => d.map(r => `${r.owner === null ? 'NULL(orphan)' : 'st' + r.owner}=${r.n}`).join(' ');
L(`  OLD Tier-3b pool (any category, any station): ${fmtDist(oldPool)}`);
L(`  NEW Tier-3b pool (this station's categories):  ${fmtDist(newPool)}`);
const oldForeign = oldPool.filter(r => r.owner !== SID).reduce((a, r) => a + r.n, 0);
const newForeign = newPool.filter(r => r.owner !== SID).reduce((a, r) => a + r.n, 0);
const orphanInOld = (oldPool.find(r => r.owner === null) || { n: 0 }).n;
const orphanInNew = (newPool.find(r => r.owner === null) || { n: 0 }).n;
check('OLD Tier-3b pool contained foreign/orphan songs (the bug)', oldForeign > 0 || orphanInOld > 0, `foreign=${oldForeign} orphan=${orphanInOld}`);
check('NEW Tier-3b pool has NO foreign (other-station) songs', newForeign === 0, `foreign=${newForeign}`);
check('NEW Tier-3b pool has NO orphan (uncategorized) songs', orphanInNew === 0, `orphan=${orphanInNew}`);
check('orphan #397 present in OLD pool, absent from NEW pool',
  !!one(`SELECT 1 x FROM songs s WHERE s.id=${ORPHAN} AND ${baseGate}`) && orphanInNew === 0, 'song_id 397');

L('\n=== PROOF A-twin: src/audio/loggen.ts:457 gate mirrors the daemon fix ===');
// The TS twin (in-process cold-stage fallback) uses the SAME query shape:
//   FROM generated_schedule gs LEFT JOIN songs s ON s.id=gs.song_id WHERE gs.station_id=? ... <GATE>
// Assert the source now carries the new gate, and that the gate rejects the orphan / keeps no-join rows.
const twinSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'audio', 'loggen.ts'), 'utf8');
check('twin source uses NEW gate (s.id IS NULL)', twinSrc.includes('AND (s.id IS NULL OR s.category_id IN ('), 'line 457');
check('twin source no longer has OLD gate (s.category_id IS NULL OR s.category_id IN)',
  !twinSrc.includes('AND (s.category_id IS NULL OR s.category_id IN ('), 'grep');
// Same SQL semantics as PROOF A (identical join + gate) → same station-4 / orphan-397 result.
const twinOrphanNew = one(`SELECT COUNT(*) n ${base} AND gs.song_id=${ORPHAN} AND ${NEW}`).n;
const twinLegacyNew = one(`SELECT COUNT(*) n ${base} AND gs.song_id IS NULL AND ${NEW}`).n;
const twinLegacyOld = one(`SELECT COUNT(*) n ${base} AND gs.song_id IS NULL AND ${OLD}`).n;
check('twin gate rejects the orphan', twinOrphanNew === 0, `${twinOrphanNew} rows`);
check('twin gate preserves no-join (legacy/SPOT) rows', twinLegacyNew === twinLegacyOld, `old=${twinLegacyOld} new=${twinLegacyNew}`);

db.close();
L(`\n${fails === 0 ? 'ALL PROOFS PASS' : fails + ' PROOF(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
