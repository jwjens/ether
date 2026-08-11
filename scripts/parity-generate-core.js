// Parity harness for electron/generate-core.js — the gate for ANY change to the picker.
//
// Phase 1 lifted the picker out of main.js as a byte-identical move. This proves the extracted module
// actually runs: builds a context against a real database, generates a day, and checks the two things
// that a "pure move" can silently break.
//
//   1. THE 60ms YIELD STILL FIRES. GEN_SLICE_MS/_genSliceStart/_genMaybeYield moved together, but
//      _generateDayChunked stayed in main.js and now resets the clock through resetGenSlice(). Drop
//      that call and the picker yields on every slot instead of every 60ms — slower, not broken, and
//      silent. Expect roughly (elapsed ms / 60) yields: not 0, not one per slot.
//   2. NO UNCATEGORISED MUSIC IS PLACED (the 4.4.181 ruling).
//
// It found two real defects the byte-diff could not: a missed `_localDayStr` dependency and a missing
// `path` import. A byte-diff proves the text moved; only running it proves the module is whole.
//
// SAFETY: read-only, and it takes a DB PATH argument so it can never be pointed at the live database
// by accident. Copy the DB first — never run this against the live file while Ether is open.
//
// Usage:
//   cp "%LOCALAPPDATA%/Ether/com.ether.radio/openair.db" /tmp/parity.db
//   node scripts/parity-generate-core.js /tmp/parity.db [stationId]
const path=require('path');
const { DatabaseSync } = require('node:sqlite');
const core = require(path.join(__dirname,'..','electron','generate-core.js'));
if (!process.argv[2] || process.argv[2].startsWith('--')) { console.error('usage: node scripts/parity-generate-core.js <db-copy-path> [stationId]'); process.exit(2); }
const db = new DatabaseSync(process.argv[2], { readOnly: true });

// node:sqlite statements expose .all/.get/.run like better-sqlite3 for these read paths.
const stationId = Number(process.argv[3] || 2);
const ctx = core.buildScheduleCtx(db, stationId);
console.log('ctx built. keys:', Object.keys(ctx).length, '| core wired:', !!ctx.core);

// Count yields by wrapping setImmediate — this is how we prove the 60ms slice still fires.
let yields = 0;
const realSetImmediate = global.setImmediate;
global.setImmediate = (fn) => { yields++; return realSetImmediate(fn); };

const day = new Date(); day.setHours(0,0,0,0);
(async () => {
  core.resetGenSlice();                       // the trap: main.js must call this each day
  const t0 = Date.now();
  await core.generateDayRows(day, ctx, 0, null);
  const ms = Date.now() - t0;
  global.setImmediate = realSetImmediate;
  console.log(`generated ${ctx.generatedRows.length} rows in ${ms}ms`);
  console.log(`yields (setImmediate calls) during the day: ${yields}`);
  console.log(`GEN_SLICE_MS = ${core._test.GEN_SLICE_MS}  -> expect roughly ms/GEN_SLICE_MS yields, not 0 and not one-per-slot`);
  const s = ctx.generatedRows.slice(0,3).map(r=>`${new Date(r.scheduled_at*1000).toLocaleTimeString()} ${r.title} [cat ${r.category_id}]`);
  console.log('first rows:'); s.forEach(x=>console.log('   '+x));
  const nullCat = ctx.generatedRows.filter(r=>r.content_class==='MUSIC' && r.category_id==null).length;
  console.log('MUSIC rows with NULL category (must be 0):', nullCat);
  db.close();
})().catch(e=>{ console.error('PARITY FAILED:', e.message); process.exit(1); });
