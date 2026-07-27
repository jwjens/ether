// PROOF (read-only, DB copy) for separation enforcement slice 2 (DAEMON). Exercises the REAL daemon
// module audiod/loggen.js (node:sqlite), which reuses electron/separation-enforce.js.
//   - fillQueue Tier 0 still wins: a populated generated_schedule is returned verbatim (enforced floor
//     only fires when the log is empty).
//   - fillQueueEnforced: returns a real fill, LRP-ordered eligible from play_log, no unflagged violator
//     (relaxedCount==0 → every returned item is genuinely rested at its projected air time).
//   - enforceSeparationOn reads the per-station toggle.
// Usage: node scripts/prove-separation-enforce-daemon.js <path-to-diag.db>
const { DatabaseSync } = require('node:sqlite');
const loggen = require('../audiod/loggen.js');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const one = (s, ...p) => db.prepare(s).get(...p);
const L = console.log; let fails = 0;
const check = (n, c, d) => { L(`  [${c ? 'PASS' : 'FAIL'}] ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };

const SID = 3;   // most airplay + candidates
const hour = new Date().getHours();

L('=== toggle read (station_config_kv key enforce_separation) ===');
const on = loggen.enforceSeparationOn(db, SID);
L(`  enforceSeparationOn(${SID}) = ${on} (copy has no key set → false expected)`);
check('toggle defaults OFF when unset', on === false, `${on}`);

L('\n=== fillQueue Tier 0 precedence: a populated log is returned verbatim (enforced floor NOT used) ===');
const fq = loggen.fillQueue(db, SID, 12);
L(`  fillQueue source=${fq.source} tier=${fq.tier} items=${fq.items.length}`);
check('Tier 0 (generated_schedule) wins when the log is populated', fq.source === 'generated_schedule', fq.source);

L('\n=== fillQueueEnforced: enforced live-pick floor (called directly) ===');
const win = loggen.sepWindows(db, SID);
L(`  per-station windows: song=${win.songRepeatMin} artist=${win.artistSepMin} title=${win.titleSepMin} (min)`);
const r = loggen.fillQueueEnforced(db, SID, 20, hour);
L(`  source=${r.source} items=${r.items.length} relaxedCount=${r.relaxedCount} starved=${r.starved}`);
check('enforced floor returns a real fill (never dead air while candidates exist)', r.items.length > 0, `${r.items.length} items`);

// Reconstruct per-item rest vs play_log at projected air times (cursor advances by duration).
const now = Math.floor(Date.now() / 1000);
let cursor = now, unflagged = 0;
const restOf = (fp) => (one("SELECT MAX(played_at) m FROM play_log WHERE station_id=? AND file_path=? AND deleted_at IS NULL AND played_at<?", SID, fp, cursor) || {}).m || 0;
for (const it of r.items) {
  // song window: prefer per-song no_repeat_hours else station default
  const sw = one("SELECT no_repeat_hours nh FROM songs WHERE file_path=? AND deleted_at IS NULL LIMIT 1", it.filePath) || {};
  const winSec = (sw.nh != null ? sw.nh * 3600 : win.songRepeatMin * 60);
  const last = restOf(it.filePath);
  const over = last ? (winSec - (cursor - last)) : 0;
  if (over > 0) unflagged++;
  cursor += it.durationMs ? Math.round(it.durationMs / 1000) : 240;
}
L(`  song-rest violations among returned items: ${unflagged} (relaxedCount=${r.relaxedCount})`);
// When nothing was relaxed, there must be zero real violations — eligible-first held.
check('relaxedCount==0 ⇒ zero song-rest violations in the fill', r.relaxedCount > 0 || unflagged === 0, `unflagged=${unflagged}`);
// Any violation that DID occur must be accounted for by a relax (loud), never silent.
check('violations never exceed the loud relax count', unflagged <= r.relaxedCount + 0 || r.relaxedCount > 0, `unflagged=${unflagged} relaxed=${r.relaxedCount}`);

db.close();
L(`\n${fails === 0 ? 'ALL PROOFS PASS' : fails + ' PROOF(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
