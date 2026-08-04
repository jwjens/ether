'use strict';
// CI LEAK-GUARD — station UUID re-key (v4.5.0). MANDATORY in CI.
// Station identity that crosses a boundary must be the station UUID, never a per-machine integer id
// (docs/station-uuid-rekey-build-plan-2026-07-07.md; census docs/station-id-census-2026-07-07.md).
//
// This is a RATCHET during the phased migration: it counts emit/relay calls that still carry an integer
// `stationId` in their args across the boundary-emitter files, and:
//   • FAILS if the count RISES above BASELINE  → a new leak / regression.
//   • FAILS if the count FALLS below BASELINE   → a channel migrated; lower BASELINE (no silent slack).
// Each phase migrates channels to `stationUuid` and lowers BASELINE. **BASELINE must be 0 by Phase 3** —
// at which point any integer-station payload fails the build.
//
// Forward-whole-frames invariant (enforced per-channel in Phase 1+): relays must forward the daemon frame
// WHOLE (never reconstruct/strip fields, as main.js:349 did with the VU levels bug). Once the levels
// channel is migrated, add a specific assertion here that the levels relay does not rebuild the frame.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FILES = ['audiod/ether-audiod.js', 'electron/main.js', 'electron/preload.js'];
const EMIT_WITH_STATIONID = /(broadcast|sendToAllWindows|webContents\.send)\([^)]*\bstationId\b/g;

// Integer-station emit-calls remaining. LOWER as each phase migrates a channel to stationUuid.
// TARGET: 0 by Phase 3. Baseline captured 2026-07-07 (Phase 0).
const BASELINE = 13;   // 14 → 13 (2026-08-04): a channel migrated; ratchet lowered, never raised.

let total = 0;
const hits = [];
for (const rel of FILES) {
  let src;
  try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
  src.split('\n').forEach((line, i) => {
    const m = line.match(EMIT_WITH_STATIONID);
    if (m) { total += m.length; hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 110)}`); }
  });
}

console.log(`[leak-guard] integer-station emit-calls: ${total}  (baseline ${BASELINE}, target 0 by Phase 3)`);

if (total > BASELINE) {
  console.error(`\n❌ LEAK-GUARD FAILED: ${total} integer-station emit-calls > baseline ${BASELINE}.`);
  console.error(`   A station frame that crosses a boundary must carry stationUuid, not an integer stationId.`);
  hits.forEach(h => console.error('   ' + h));
  process.exit(1);
}
if (total < BASELINE) {
  console.error(`\n⚠ BASELINE STALE: found ${total} (< baseline ${BASELINE}) — migration progressed.`);
  console.error(`   Lower BASELINE to ${total} in scripts/test-station-identity-leak.js so the ratchet can't slip back.`);
  process.exit(1);
}
console.log('✅ leak-guard OK — no new integer-station leaks; baseline holds.');
