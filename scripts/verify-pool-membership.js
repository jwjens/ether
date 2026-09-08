'use strict';
// scripts/verify-pool-membership.js — THE RECEIPT for migration v55.
//
// Jeff's condition: "the before/after Generate diff — run it and show me the placements are identical.
// I want to see it, not be told it."
//
// WHAT IT DOES
//   1. COPIES the live profile database to a scratch file. The live file is opened READ-ONLY, once, to
//      copy it. Nothing here ever writes the database Ether is using.
//   2. Replays a real generated day: for every music element in order, resolves that element's
//      assignment exactly as _placeJingles does (category → item / pool / station fallback, and the
//      active-hours gate on the seam's local hour), and picks a cut with the same least-recently-played
//      rotation and the same per-pool anti-repeat set.
//   3. Runs that replay TWICE against the same file — once through the pre-v55 candidate query, once
//      through the v55 join table, after applying the migration to the COPY.
//   4. Diffs the picks, seam by seam, and prints the first differences if there are any.
//
// WHY THE COMPARISON IS SOUND EVEN THOUGH THE REPLAY LOOP IS NOT main.js
//   The candidate query is THE REAL ONE — both sides call electron/sweeper-pool.js, the same module
//   _placeJingles calls. The surrounding loop is a faithful copy of the placement logic, and it is
//   IDENTICAL on both sides, so any way in which it differs from main.js affects both runs equally and
//   cancels out of the diff. What is isolated is exactly the one variable the migration changes.
//   It cannot prove the replay matches main.js; it proves the migration changes no placement.
//
//   node scripts/verify-pool-membership.js [sourceDb] [stationId]

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { preparePoolCandidates } = require(path.join(__dirname, '..', 'electron', 'sweeper-pool'));

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const SRC = process.argv[2] || path.join(localAppData, 'Ether', 'profiles', 'ETH-STN-BAA8-E056-6FC8', 'openair.db');
const SCRATCH = path.join(os.tmpdir(), `ether-v55-verify-${Date.now()}.db`);

const ALWAYS = 16777215;
const SWEEPER_DEFAULT_LEAD = 2;

function copyLive() {
  // Copy through a READ-ONLY handle so this can run while Ether is open. -wal/-shm are copied when
  // present so the copy carries committed-but-unflushed pages.
  if (!fs.existsSync(SRC)) { console.error('source DB not found:', SRC); process.exit(2); }
  const ro = new Database(SRC, { readonly: true, fileMustExist: true });
  ro.close();
  fs.copyFileSync(SRC, SCRATCH);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(SRC + ext)) fs.copyFileSync(SRC + ext, SCRATCH + ext);
  }
}

/** The placement replay. `force` selects which candidate shape to read through. */
function replay(db, stationId, force) {
  const reader = preparePoolCandidates(db, force);

  let fallbackCatId = null;
  try {
    const fb = db.prepare("SELECT value FROM station_config_kv WHERE key='overlay_fallback_category_id' AND station_id = ? AND deleted_at IS NULL").get(stationId);
    if (fb && fb.value) fallbackCatId = parseInt(fb.value, 10) || null;
  } catch {}

  const stmtAssign = db.prepare('SELECT overlay_kind, overlay_song_id, overlay_category_id, overlay_lead_in_sec, overlay_active_hours FROM categories WHERE id = ?');
  const stmtItem = db.prepare("SELECT s.id, s.title FROM songs s WHERE s.id = ? AND s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive') AND s.content_class IN ('SWP','JIN')");
  const stmtPoolType = db.prepare('SELECT type FROM jingle_categories WHERE id = ? AND deleted_at IS NULL');

  // A real generated day, in order — the same rows _placeJingles is handed.
  const music = db.prepare(
    "SELECT scheduled_at, song_id, category_id FROM generated_schedule" +
    " WHERE station_id = ? AND COALESCE(content_class,'MUSIC') = 'MUSIC' AND song_id IS NOT NULL" +
    " ORDER BY scheduled_at ASC").all(stationId);

  const poolCands = new Map();
  const usedByPool = new Map();
  const itemCache = new Map();
  const resolvePool = (poolId) => {
    let cands = poolCands.get(poolId);
    if (cands === undefined) {
      let type = 'SWP';
      try { const t = stmtPoolType.get(poolId); if (t && t.type) type = t.type; } catch {}
      cands = reader.all(poolId, type, stationId);
      poolCands.set(poolId, cands);
    }
    if (!cands.length) return null;
    let used = usedByPool.get(poolId);
    if (!used) { used = new Set(); usedByPool.set(poolId, used); }
    let pick = cands.find(x => !used.has(x.id));
    if (!pick) { used.clear(); pick = cands[0]; }
    used.add(pick.id);
    return pick;
  };

  const placements = [];
  for (const incoming of music) {
    const catId = incoming.category_id;
    if (catId == null) continue;
    let a = null; try { a = stmtAssign.get(catId); } catch {}
    let kind = a && a.overlay_kind ? a.overlay_kind : null;
    let poolId = a ? a.overlay_category_id : null;
    const itemId = a ? a.overlay_song_id : null;
    let leadOverride = a ? a.overlay_lead_in_sec : null;
    let activeHours = (a && a.overlay_active_hours != null) ? a.overlay_active_hours : ALWAYS;
    if (!kind) {
      if (fallbackCatId) { kind = 'pool'; poolId = fallbackCatId; leadOverride = null; activeHours = ALWAYS; }
      else continue;
    }
    const seamHour = new Date(incoming.scheduled_at * 1000).getHours();
    if (((activeHours >> seamHour) & 1) !== 1) continue;
    let pick = null;
    if (kind === 'item' && itemId != null) {
      if (itemCache.has(itemId)) pick = itemCache.get(itemId);
      else { try { pick = stmtItem.get(itemId); } catch { pick = null; } itemCache.set(itemId, pick); }
    } else if (kind === 'pool' && poolId != null) {
      pick = resolvePool(poolId);
    }
    if (!pick) continue;
    placements.push({
      at: incoming.scheduled_at,
      song_id: pick.id,
      title: pick.title,
      lead: leadOverride != null ? leadOverride : SWEEPER_DEFAULT_LEAD,
      pool: kind === 'pool' ? poolId : null,
    });
  }
  return { placements, shape: reader.shape, music: music.length };
}

function main() {
  console.log('=== verify-pool-membership — migration v55 ===');
  console.log('source (READ-ONLY, never written):', SRC);
  copyLive();
  console.log('working copy:', SCRATCH);

  const db = new Database(SCRATCH);
  const stations = db.prepare('SELECT id, name, is_active FROM stations WHERE deleted_at IS NULL ORDER BY id').all();
  const only = process.argv[3] ? [Number(process.argv[3])] : stations.map(s => s.id);

  // ── BEFORE: the pre-v55 shape, on the untouched copy ─────────────────────
  const before = new Map();
  for (const id of only) before.set(id, replay(db, id, 'legacy'));

  // ── MIGRATE the copy ─────────────────────────────────────────────────────
  // ── ROWS BEFORE ──────────────────────────────────────────────────────────
  const tableBefore = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sweeper_pool_member'").get();
  const rowsBefore = tableBefore ? db.prepare('SELECT COUNT(*) n FROM sweeper_pool_member').get().n : 0;
  console.log('');
  console.log('--- rows BEFORE ---');
  console.log(`  sweeper_pool_member: ${tableBefore ? rowsBefore + ' row(s)' : 'table does not exist'}`);
  console.log(`  songs.jingle_category_id set: ${db.prepare('SELECT COUNT(*) n FROM songs WHERE jingle_category_id IS NOT NULL').get().n} row(s)`);
  console.table(db.prepare(
    "SELECT jc.name AS pool, jc.station_id, st.name AS station, COUNT(s.id) AS cuts" +
    "  FROM jingle_categories jc LEFT JOIN stations st ON st.id = jc.station_id" +
    "  LEFT JOIN songs s ON s.jingle_category_id = jc.id" +
    " WHERE jc.deleted_at IS NULL GROUP BY jc.id ORDER BY jc.station_id").all());
  console.log('\n--- applying migration v55 to the COPY ---');
  require(path.join(__dirname, 'migrate-sweeper-pool-member-phase-sync-55.js')).applyMigration(db);

  const memberCount = db.prepare('SELECT COUNT(*) n FROM sweeper_pool_member WHERE deleted_at IS NULL').get().n;
  const legacyCount = db.prepare('SELECT COUNT(*) n FROM songs WHERE jingle_category_id IS NOT NULL AND uuid IS NOT NULL').get().n;
  console.log(`--- memberships: ${memberCount} in the join table, ${legacyCount} in the old column ---`);
  console.log('');
  console.log('--- rows AFTER ---');
  console.log(`  sweeper_pool_member: ${memberCount} row(s)`);
  console.log(`  songs.jingle_category_id set: ${legacyCount} row(s) (left in place, unread)`);
  // THE SPLIT, REPRODUCED — counted from the NEW table, joined the NEW way. If the backfill were
  // wrong this is where it would show, not in a count that merely echoes the source.
  console.table(db.prepare(
    "SELECT jc.name AS pool, jc.station_id, st.name AS station, COUNT(m.id) AS cuts" +
    "  FROM jingle_categories jc LEFT JOIN stations st ON st.id = jc.station_id" +
    "  LEFT JOIN sweeper_pool_member m ON m.pool_id = jc.id AND m.deleted_at IS NULL" +
    " WHERE jc.deleted_at IS NULL GROUP BY jc.id ORDER BY jc.station_id").all());

  // ── AFTER: the v55 shape, same file, same replay ─────────────────────────
  let failures = 0;
  console.log('\n--- placement diff, per station ---');
  for (const id of only) {
    const st = stations.find(s => s.id === id);
    const b = before.get(id);
    const a = replay(db, id, 'member');
    const n = Math.max(b.placements.length, a.placements.length);
    const diffs = [];
    for (let i = 0; i < n; i++) {
      const x = b.placements[i], y = a.placements[i];
      const key = (p) => p ? `${p.at}|${p.song_id}|${p.lead}|${p.pool}` : '(none)';
      if (key(x) !== key(y)) diffs.push({ i, before: key(x), after: key(y) });
    }
    const ok = diffs.length === 0 && b.placements.length === a.placements.length;
    if (!ok) failures++;
    console.log(
      `${ok ? 'IDENTICAL' : 'DIFFERS  '}  station ${id} ${JSON.stringify(st ? st.name : '?')}` +
      `  music=${b.music}  placements before=${b.placements.length} after=${a.placements.length}` +
      (diffs.length ? `  diffs=${diffs.length}` : ''));
    for (const d of diffs.slice(0, 5)) console.log(`    [${d.i}] before ${d.before}   after ${d.after}`);
  }

  // A sample, so the diff is not just a count. First few placements, both sides.
  const sampleId = only.find(id => before.get(id).placements.length) ?? only[0];
  if (before.get(sampleId) && before.get(sampleId).placements.length) {
    console.log(`\n--- first 5 placements on station ${sampleId}, both shapes ---`);
    const b = before.get(sampleId).placements;
    const a = replay(db, sampleId, 'member').placements;
    for (let i = 0; i < Math.min(5, b.length); i++) {
      const t = new Date(b[i].at * 1000).toLocaleTimeString();
      console.log(`  ${t}  legacy: ${b[i].song_id} ${JSON.stringify(b[i].title)}`);
      console.log(`  ${' '.repeat(t.length)}  member: ${a[i] ? a[i].song_id + ' ' + JSON.stringify(a[i].title) : '(none)'}`);
    }
  }

  // ── AND THE THING THE SLICE IS FOR ───────────────────────────────────────
  // Identical placements prove the migration is safe. They do not prove it is useful. Put ONE cut that
  // already sits in a pool into a SECOND station's pool as well, and show both pools return it — the
  // exact operation the old single-integer column made impossible.
  console.log('');
  console.log("--- capability: one cut, two stations' pools ---");
  try {
    const pools = db.prepare('SELECT id, name, station_id FROM jingle_categories WHERE deleted_at IS NULL ORDER BY station_id').all();
    const m = db.prepare('SELECT asset_uuid, pool_id FROM sweeper_pool_member WHERE deleted_at IS NULL LIMIT 1').get();
    const home = pools.find(p => p.id === m.pool_id);
    const other = pools.find(p => p.station_id !== home.station_id);
    const title = (db.prepare('SELECT title FROM songs WHERE uuid = ?').get(m.asset_uuid) || {}).title;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO sweeper_pool_member (pool_id, asset_uuid, station_id, sort_order, uuid, created_at, updated_at)
                VALUES (?, ?, ?, 0, ?, ?, ?)`)
      .run(other.id, m.asset_uuid, other.station_id, 'verify-two-pools', now, now);

    const inHome  = preparePoolCandidates(db, 'member').all(home.id,  'SWP', home.station_id);
    const inOther = preparePoolCandidates(db, 'member').all(other.id, 'SWP', other.station_id);
    const sid = (db.prepare('SELECT id FROM songs WHERE uuid = ?').get(m.asset_uuid) || {}).id;
    const a = inHome.some(x => x.id === sid), b = inOther.some(x => x.id === sid);
    console.log(`  cut ${JSON.stringify(title)}`);
    console.log(`    in ${JSON.stringify(home.name)} (station ${home.station_id}):  ${a ? 'YES' : 'NO'}   [${inHome.length} candidates]`);
    console.log(`    in ${JSON.stringify(other.name)} (station ${other.station_id}): ${b ? 'YES' : 'NO'}   [${inOther.length} candidates]`);
    console.log(`  ${a && b ? 'BOTH — one cut, two stations, neither taken from the other.'
                            : 'FAILED — the cut is not in both pools.'}`);
    if (!(a && b)) failures++;
  } catch (e) {
    console.log('  capability check could not run:', e.message);
    failures++;
  }

  db.close();
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(SCRATCH + ext); } catch {} }
  console.log(`\n${failures === 0 ? 'PASS — the migration changes no placement.' : 'FAIL — ' + failures + ' station(s) differ.'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
