'use strict';
// scripts/test-uuid-refs-gate.js — TWO MACHINES, NUMBERED DIFFERENTLY, ON THEIR OWN TEST STATIONS.
//
// Jeff, 2026-10-19: "Test on the test stations with deliberately mismatched numbering in both directions, including
// edits made on each side." And, standing: "Stop testing my real stations … The gate builds its OWN test stations from
// scratch on a blank database."
//
// Two in-memory databases — machine A ("OVEVENTS") and machine B ("OV") — carry the app's real schema: structure only,
// read from an installed database opened READ-ONLY (no row is copied, nothing is written to it). The same test station
// and categories are built across them through the real sync engines and an in-memory backend that stores and relays
// exactly what the real one does (server_seq order, ref_uuids verbatim, own mutations echoed back). Every write goes
// through the app's own sanctioned writers (sync handlers), so each one is journalled exactly as in the app.
//
//   PHASE 1 — before the fix (both machines on the old wire): the numbering is pushed out of step IN BOTH DIRECTIONS
//            (each machine makes a row the other has not first: "Early tracks" twice, an artist each side), then
//            songs are filed on each side, one is re-filed on the other side, a cue point is edited on the side that
//            holds a wrong category (that edit re-sends the wrong number), a category is renamed, the jukebox setting
//            is saved as numbers. The defect must REPRODUCE: wrong categories and artists on both machines.
//   PHASE 2 — the upgrade: A first (its re-file fixes what A assigned and WAITS for B's numbering), then B (resolves
//            everything through A's numbering), then A again. Every song lands where it was filed, on both machines;
//            every move is reported; running it again moves nothing. A message still in flight on the old wire from
//            an upgraded machine is translated through its published numbering.
//   PHASE 3 — after the fix: new categories, assignments, re-assignments and cue edits on each side; a child that
//            arrives before its parent is never written as a foreign number.
//
// Run: npm run test:uuid-refs   (Electron's Node — better-sqlite3 is built for it)
//      [--schema <path-to-an-installed-openair.db>]   default: the first profile database under %LOCALAPPDATA%\Ether
// docs/sync-uuid-references-2026-10-19.md

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const MW = require(path.join(ROOT, 'electron/sync/mutation-writer'));
const { SyncEngine } = require(path.join(ROOT, 'electron/sync/sync-engine'));
const { EtherTransport } = require(path.join(ROOT, 'electron/sync/transport'));
const { REGISTRY } = require(path.join(ROOT, 'electron/sync/synced-tables'));
const NUM = require(path.join(ROOT, 'electron/sync/id-numbering'));
const REPAIR = require(path.join(ROOT, 'electron/sync/uuid-ref-repair'));
const H = {
  stations: require(path.join(ROOT, 'electron/sync/handlers/stations')),
  categories: require(path.join(ROOT, 'electron/sync/handlers/categories')),
  artists: require(path.join(ROOT, 'electron/sync/handlers/artists')),
  songs: require(path.join(ROOT, 'electron/sync/handlers/songs')),
  kv: require(path.join(ROOT, 'electron/sync/handlers/station_config_kv')),
};

// ── results ─────────────────────────────────────────────────────────────────────────────────────────────────────
let failures = 0, passes = 0;
const out = [];
const log = (s) => { out.push(s); console.log(s); };
function check(id, label, ok, detail) {
  if (ok) { passes++; log(`  PASS ${id} ${label}`); }
  else { failures++; log(`  FAIL ${id} ${label}${detail ? `\n         ${detail}` : ''}`); }
}

// ── the schema source (read-only) ───────────────────────────────────────────────────────────────────────────────
function schemaSource() {
  const i = process.argv.indexOf('--schema');
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  const prof = path.join(process.env.LOCALAPPDATA || '', 'Ether', 'profiles');
  try {
    for (const d of fs.readdirSync(prof)) {
      if (d.includes('.retired') || d.startsWith('_')) continue;
      const f = path.join(prof, d, 'openair.db');
      if (fs.existsSync(f)) return f;
    }
  } catch { /* none */ }
  return null;
}
const SRC = schemaSource();
if (!SRC) { console.error('NO SCHEMA SOURCE — pass --schema <an installed openair.db> (opened read-only).'); process.exit(2); }

function blankFromSchema() {
  const db = new Database(':memory:');
  const src = new Database(SRC, { readonly: true, fileMustExist: true });
  try {
    const objs = src.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END").all();
    for (const o of objs) { try { db.exec(o.sql); } catch { /* FTS shadow tables etc. */ } }
    for (const r of src.prepare('SELECT version FROM schema_version').all()) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(r.version);
  } finally { src.close(); }
  return db;
}
const colsOf = (db, t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));

// ── the backend double: what ether-backend /sync/push + /sync/pull do, in memory ───────────────────────────────
class Backend {
  constructor() { this.rows = []; this.seq = 0; this.seen = new Map(); this.held = null; this.dropped = null; }
  transport() {
    const be = this;
    return new (class extends EtherTransport {
      async push(b) {
        for (const m of b.batch) {
          if (be.rows.some(r => r.id === m.id)) continue;            // ON CONFLICT (license, id) DO NOTHING
          const row = JSON.parse(JSON.stringify(m));
          if (be.dropped && be.dropped(row)) continue;                // never delivered (lost on the way)
          if (be.held && be.held(row)) { be.heldRows.push(row); continue; }
          row.server_seq = ++be.seq;
          be.rows.push(row);
        }
        return { accepted: b.batch.map(m => m.id), rejected: [] };
      }
      async pull({ client_id }) {
        const last = be.seen.get(client_id) || 0;
        const mutations = be.rows.filter(r => r.server_seq > last).map(r => JSON.parse(JSON.stringify(r)));
        be.seen.set(client_id, be.seq);
        return { mutations, server_hlc: '0' };
      }
      async healthCheck() { return { ok: true, latencyMs: 0 }; }
    })();
  }
  /** Hold back mutations matching `pred` (delivered later by release()) — out-of-order delivery. */
  hold(pred) { this.held = pred; this.heldRows = []; }
  /** Lose mutations matching `pred` for good (null to stop). */
  drop(pred) { this.dropped = pred; }
  release() { for (const row of this.heldRows) { row.server_seq = ++this.seq; this.rows.push(row); } this.held = null; this.heldRows = []; }
}

// ── the PRE-FIX wire, verbatim: references only for station tables (OVEVENTS had the flag on for halloVeen) ─────
function legacyEnrich(wire) {
  const entry = REGISTRY[wire.table_name];
  if (!entry || entry.scope !== 'station') return wire;
  const refs = { station_id: 'stations', ...(entry.refs || {}) };
  for (const k of Object.keys(refs)) if (!(entry.refs || {})[k] && k !== 'station_id') delete refs[k];
  const src = wire.payload_after || wire.payload_before || {};
  const refUuids = {};
  for (const [col, refTable] of Object.entries(refs)) {
    // The pre-fix registry had no refs on categories (overlay columns) — keep the old shape exactly: station only there.
    if (wire.table_name === 'categories' && col !== 'station_id') continue;
    const localId = src[col];
    if (localId == null) continue;
    const physical = (REGISTRY[refTable] && REGISTRY[refTable].tableName) || refTable;
    const row = this._db.prepare(`SELECT uuid FROM ${physical} WHERE id = ?`).get(localId);
    if (row?.uuid) refUuids[col] = row.uuid;
  }
  wire.ref_uuids = refUuids;
  wire.station_uuid = refUuids.station_id ?? null;
  return wire;
}

// ── a machine ──────────────────────────────────────────────────────────────────────────────────────────────────
const backend = new Backend();
function machine(name, clientId) {
  const db = blankFromSchema();
  const now = new Date().toISOString();
  const ci = colsOf(db, 'client_identity');
  db.prepare(`INSERT INTO client_identity (${['id', 'client_id', 'created_at'].filter(c => ci.has(c)).join(',')}) VALUES (${ci.has('id') ? '1,' : ''}?,?)`).run(clientId, now);
  db.prepare("INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, ?)").run(`0:0:${clientId}`, now);
  const M = { name, clientId, db, stationId: null, stationUuid: null };
  M.engine = new SyncEngine(db, backend.transport(), {
    getStationId: () => (M.stationId != null ? String(M.stationId) : null),
    getStationUuid: () => M.stationUuid,
    uuidIdentity: true,
    localAudioDir: () => null,
  });
  M.legacy = true;
  M.engine._enrichWire = function (w) { return M.legacy ? legacyEnrich.call(this, w) : SyncEngine.prototype._enrichWire.call(this, w); };
  return M;
}
/** Every write and sync on a machine runs as that machine (the writer caches the client id per process). */
function on(M, fn) { MW._resetForTest(); return fn(M.db); }
async function onAsync(M, fn) { MW._resetForTest(); return fn(M.db); }
async function sync(...ms) {
  for (let pass = 0; pass < 2; pass++) {
    for (const M of ms) await onAsync(M, () => M.engine.push());
    for (const M of ms) await onAsync(M, () => M.engine.pull());
  }
}

// ── writes through the sanctioned writers ──────────────────────────────────────────────────────────────────────
const catByCode = (M, code) => M.db.prepare('SELECT * FROM categories WHERE code = ? AND station_id = ? AND deleted_at IS NULL').get(code, M.stationId);
function newCategory(M, code, name) { on(M, db => H.categories.categoriesCreate(db, { station_id: M.stationId, code, name })); return catByCode(M, code); }
function artist(M, name) { on(M, db => H.artists.artistsFindOrCreateByName(db, name)); return M.db.prepare('SELECT * FROM artists WHERE name = ?').get(name); }
function newSong(M, title, catCode, artistName) {
  const uuid = crypto.randomUUID();
  const cat = catByCode(M, catCode);
  const ar = artistName ? artist(M, artistName) : null;
  on(M, db => H.songs.songsCreate(db, { uuid, title, file_path: `C:/fixture/${title}.mp3`, category_id: cat.id, artist_id: ar ? ar.id : null, duration_ms: 180000,
    genre: 'Fixture', bpm: 120, energy: 3, cue_in_ms: 250, intro_end_ms: 9000, cart_id: 'C-' + title.slice(0, 4) }));
  return uuid;
}
function refile(M, songUuid, catCode) { const cat = catByCode(M, catCode); on(M, db => H.songs.songsUpdate(db, songUuid, { category_id: cat.id })); }
function editCue(M, songUuid, ms) { on(M, db => H.songs.songsUpdate(db, songUuid, { cue_in_ms: ms })); }

// ── reading the truth by uuid ──────────────────────────────────────────────────────────────────────────────────
const songCatUuid = (M, su) => M.db.prepare('SELECT c.uuid u FROM songs s LEFT JOIN categories c ON c.id = s.category_id WHERE s.uuid = ?').get(su)?.u ?? null;
const songArtistUuid = (M, su) => M.db.prepare('SELECT a.uuid u FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.uuid = ?').get(su)?.u ?? null;
const songArtistName = (M, su) => M.db.prepare('SELECT a.name n FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.uuid = ?').get(su)?.n ?? null;
const intended = new Map();   // song uuid → { cat: category uuid, artist: artist uuid } — what the operator last chose
function wrongOn(M) {
  const bad = [];
  for (const [su, want] of intended) {
    const c = songCatUuid(M, su), a = songArtistUuid(M, su);
    if (c !== want.cat || (want.artist !== undefined && a !== want.artist)) bad.push({ su, cat: c, want });
  }
  return bad;
}

(async () => {
  log(`uuid-refs gate — schema from ${SRC} (read-only, structure only)`);
  const A = machine('A (OVEVENTS)', 'aaaaaaaa-0000-4000-8000-00000000000a');
  const B = machine('B (OV)',       'bbbbbbbb-0000-4000-8000-00000000000b');

  // ════ PHASE 1 — before the fix ═════════════════════════════════════════════════════════════════════════════
  log('\nPHASE 1 — before the fix (old wire), numbering out of step in both directions');
  // Stations: A has another station first, so the shared test station is a different number on each machine.
  on(A, db => H.stations.stationsCreate(db, { name: 'GATE Other', uuid: crypto.randomUUID() }));
  on(B, db => H.stations.stationsCreate(db, { name: 'GATE B only', uuid: crypto.randomUUID() }));
  on(B, db => H.stations.stationsCreate(db, { name: 'GATE B only 2', uuid: crypto.randomUUID() }));
  const stUuid = crypto.randomUUID();
  on(A, db => H.stations.stationsCreate(db, { name: 'GATE halloVeen', uuid: stUuid }));
  A.stationUuid = B.stationUuid = stUuid;
  A.stationId = A.db.prepare('SELECT id FROM stations WHERE uuid = ?').get(stUuid).id;
  await sync(A, B);
  B.stationId = B.db.prepare('SELECT id FROM stations WHERE uuid = ?').get(stUuid)?.id;
  check('P1.0', 'the test station reached B under its own number', B.stationId != null && B.stationId !== A.stationId,
    `A=${A.stationId} B=${B.stationId}`);

  // B makes rows A has not seen; A makes rows B has not seen; then they sync — both numberings are now out of step.
  newCategory(B, 'EARLY-B', 'Early tracks');                 // "Early tracks" created twice
  artist(B, 'Little Shop Cast');
  newCategory(A, 'EARLY', 'Early tracks');
  newCategory(A, 'KIDS', 'Kids');
  newCategory(A, 'HVADULT', 'HV Adult');
  newCategory(A, 'MOVIETV', 'Movie & TV');
  newCategory(A, 'MOVIESDTK', 'Movie Soundtrack');
  artist(A, 'Kidz Bop Kids');
  newCategory(B, 'DISNEY', 'Disney Halloween');
  await sync(A, B);
  const offA = ['KIDS', 'HVADULT', 'MOVIETV', 'DISNEY', 'MOVIESDTK'].map(c => `${c}=${catByCode(A, c)?.id}`).join(' ');
  const offB = ['KIDS', 'HVADULT', 'MOVIETV', 'DISNEY', 'MOVIESDTK'].map(c => `${c}=${catByCode(B, c)?.id}`).join(' ');
  log(`    A numbers: ${offA}`);
  log(`    B numbers: ${offB}`);
  check('P1.1', 'the categories are numbered differently on the two machines (both directions)',
    ['KIDS', 'DISNEY'].every(c => catByCode(A, c) && catByCode(B, c) && catByCode(A, c).id !== catByCode(B, c).id));

  // Songs filed on each side (the Oct 19 import on A; Little Shop on B).
  const kidz = ['YUKON', 'Wolves', 'Witchy Woman', 'Witch Doctor'].map(t => newSong(A, t, 'KIDS', 'Kidz Bop Kids'));
  const shop = ['Prologue (Little Shop Of Horrors)', 'Suddenly Seymour'].map(t => newSong(B, t, 'MOVIESDTK', 'Little Shop Cast'));
  const disney = newSong(B, 'This Is Halloween', 'DISNEY', null);
  const adult = newSong(A, 'Thriller', 'HVADULT', null);
  // The artist row of a new import never reaches B (today's songs "arrived on OV without artist names").
  backend.drop(r => r.table_name === 'artists' && r.payload_after && r.payload_after.name === 'Lost Artist');
  const lost = newSong(A, 'Lost Song', 'KIDS', 'Lost Artist');
  await sync(A, B);
  backend.drop(null);
  intended.set(lost, { cat: catByCode(A, 'KIDS').uuid, artist: artist(A, 'Lost Artist').uuid });
  for (const su of kidz)  intended.set(su, { cat: catByCode(A, 'KIDS').uuid, artist: artist(A, 'Kidz Bop Kids').uuid });
  for (const su of shop)  intended.set(su, { cat: catByCode(B, 'MOVIESDTK').uuid, artist: artist(B, 'Little Shop Cast').uuid });
  intended.set(disney, { cat: catByCode(B, 'DISNEY').uuid, artist: null });
  intended.set(adult,  { cat: catByCode(A, 'HVADULT').uuid, artist: null });

  // Edits on each side: A re-files a Little Shop song (B filed it); B edits a cue on a Kidz Bop song while B holds the
  // WRONG category for it (that edit re-sends B's number to A); a category is renamed.
  refile(A, shop[1], 'MOVIETV');
  intended.get(shop[1]).cat = catByCode(A, 'MOVIETV').uuid;
  await sync(A, B);
  editCue(B, kidz[0], 1234);
  on(B, db => H.categories.categoriesUpdate(db, catByCode(B, 'KIDS').uuid, { name: 'Kids Hits' }));
  // The jukebox setting, saved as A's numbers (the pre-fix writer), synced to B.
  on(A, db => H.kv.stationConfigKvUpsertByKey(db, A.stationId, 'jukebox_categories', JSON.stringify([catByCode(A, 'KIDS').id, catByCode(A, 'DISNEY').id])));
  await sync(A, B);

  const badA1 = wrongOn(A), badB1 = wrongOn(B);
  log(`    wrong before the fix: A ${badA1.length}, B ${badB1.length} of ${intended.size} songs`);
  check('P1.4', 'the song whose artist never arrived shows no artist name (or the wrong one) on B', songArtistName(B, lost) !== 'Lost Artist',
    `B shows "${songArtistName(B, lost)}"`);
  check('P1.2', 'the defect reproduces on B (songs filed on A land wrong on B)', badB1.length > 0);
  check('P1.3', 'the defect reproduces on A (songs filed on B land wrong on A, and B\'s cue edit re-sends a wrong number)', badA1.length > 0);

  // ════ PHASE 2 — the upgrade ═════════════════════════════════════════════════════════════════════════════════
  log('\nPHASE 2 — the upgrade: A first, then B');
  A.legacy = false;
  on(A, db => NUM.publishNumbering(db));
  const rA1 = on(A, db => REPAIR.runRepair(db));
  log(`    A re-file #1: moved ${rA1.moved.length}, settings ${rA1.kvMoved.length}, waiting ${rA1.waiting.length}, missing ${rA1.missing.length}`);
  check('P2.1', 'A alone fixes what A assigned and WAITS on what B assigned (B has not published its numbering)',
    rA1.waiting.length > 0 && rA1.waiting.every(w => w.by === B.clientId));
  await sync(A, B);

  B.legacy = false;
  on(B, db => NUM.publishNumbering(db));
  await sync(A, B);
  const rB = on(B, db => REPAIR.runRepair(db));
  log(`    B re-file: moved ${rB.moved.length}, settings ${rB.kvMoved.length}, waiting ${rB.waiting.length}, missing ${rB.missing.length}`);
  check('P2.2', 'B resolves every assignment (A\'s through A\'s published numbering) — nothing waiting, nothing missing',
    rB.waiting.length === 0 && rB.missing.length === 0);
  const rA2 = on(A, db => REPAIR.runRepair(db));
  log(`    A re-file #2: moved ${rA2.moved.length}, waiting ${rA2.waiting.length}, missing ${rA2.missing.length}`);
  check('P2.3', 'A completes once B\'s numbering has arrived', rA2.waiting.length === 0 && rA2.missing.length === 0);

  const badA2 = wrongOn(A), badB2 = wrongOn(B);
  check('P2.4', 'every song is on the category (and artist) it was filed to, on A', badA2.length === 0, JSON.stringify(badA2.slice(0, 3)));
  check('P2.5', 'every song is on the category (and artist) it was filed to, on B', badB2.length === 0, JSON.stringify(badB2.slice(0, 3)));
  check('P2.4a', 'the missing artist was CREATED on B, under the same uuid, and the song shows its name',
    songArtistName(B, lost) === 'Lost Artist' && songArtistUuid(B, lost) === intended.get(lost).artist && rB.created.some(c => c.name === 'Lost Artist')
    && rB.moved.some(x => x.song === 'Lost Song' && x.reference === 'artist'));   // …and it is in the report
  check('P2.4b', 'the report lists every song whose ARTIST changed and every song whose CATEGORY changed',
    rB.moved.some(x => x.reference === 'artist') && rB.moved.some(x => x.reference === 'category') &&
    REPAIR.formatReport(rB).includes('ARTIST — ') && REPAIR.formatReport(rB).includes('CATEGORY — '));
  const movedA = rA1.moved.length + rA2.moved.length;
  check('P2.6', 'every move is reported: what was wrong is exactly what moved (A)',
    new Set([...rA1.moved, ...rA2.moved].map(x => x.song_uuid + x.reference)).size === movedA && movedA >= badA1.length);
  check('P2.7', 'every move is reported: what was wrong is exactly what moved (B)', rB.moved.length >= badB1.length);
  const kvB = JSON.parse(B.db.prepare("SELECT value FROM station_config_kv WHERE key = 'jukebox_categories' AND station_id = ?").get(B.stationId).value);
  check('P2.8', 'the jukebox setting on B now names A\'s chosen categories by uuid',
    JSON.stringify(kvB) === JSON.stringify([catByCode(B, 'KIDS').uuid, catByCode(B, 'DISNEY').uuid]), JSON.stringify(kvB));
  const again = [on(A, db => REPAIR.runRepair(db)), on(B, db => REPAIR.runRepair(db))];
  check('P2.9', 'running the re-file again moves nothing (A and B)', again.every(r => r.moved.length === 0 && r.kvMoved.length === 0));
  const reportText = REPAIR.formatReport(rB, { machineLabel: B.name });
  check('P2.10', 'the report lists each moved song by title', rB.moved.every(x => reportText.includes(x.song)));

  // An old-wire message still in flight from B after B has published: A reads it through B's numbering.
  B.legacy = true;
  refile(B, disney, 'HVADULT');
  intended.get(disney).cat = catByCode(B, 'HVADULT').uuid;
  await sync(A, B);
  B.legacy = false;
  check('P2.11', 'an old-wire message from an upgraded machine is read through its published numbering', wrongOn(A).length === 0,
    JSON.stringify(wrongOn(A).slice(0, 2)));

  // ════ PHASE 3 — after the fix ═══════════════════════════════════════════════════════════════════════════════
  log('\nPHASE 3 — after the fix: edits on each side');
  newCategory(A, 'NEWA', 'Made on A');
  newCategory(B, 'NEWB', 'Made on B');
  await sync(A, B);
  const s1 = newSong(B, 'Monster Mash', 'NEWA', 'Kidz Bop Kids');          // B files to A's new category, A's artist
  const s2 = newSong(A, 'Ghostbusters', 'NEWB', 'Little Shop Cast');       // A files to B's new category, B's artist
  intended.set(s1, { cat: catByCode(B, 'NEWA').uuid, artist: artist(B, 'Kidz Bop Kids').uuid });
  intended.set(s2, { cat: catByCode(A, 'NEWB').uuid, artist: artist(A, 'Little Shop Cast').uuid });
  await sync(A, B);
  // Each edit syncs before the next, as two operators at two machines do. (Two edits to the SAME song inside one sync
  // round are row-level last-writer-wins — the whole row travels — so the later one wins even for a column it did not
  // touch. That is the protocol's existing behaviour, independent of numbering; recorded in the design doc, not here.)
  refile(A, kidz[1], 'DISNEY'); intended.get(kidz[1]).cat = catByCode(A, 'DISNEY').uuid;
  await sync(A, B);
  refile(B, shop[0], 'KIDS');   intended.get(shop[0]).cat = catByCode(B, 'KIDS').uuid;
  await sync(A, B);
  editCue(A, shop[0], 500);     // A edits a song B just re-filed — re-sends A's number for B's choice
  await sync(A, B);
  editCue(B, kidz[1], 700);     // B edits a song A just re-filed — re-sends B's number for A's choice
  await sync(A, B);
  check('P3.1', 'after edits on both sides every song matches on A', wrongOn(A).length === 0, JSON.stringify(wrongOn(A).slice(0, 3)));
  check('P3.2', 'after edits on both sides every song matches on B', wrongOn(B).length === 0, JSON.stringify(wrongOn(B).slice(0, 3)));
  const stats = [A, B].map(M => M.engine._mergeEngine.refStats);
  log(`    references on arrival: A ${JSON.stringify(stats[0])}  B ${JSON.stringify(stats[1])}`);
  check('P3.3', 'new-wire messages translate by uuid (A and B received translated references)', stats.every(s => s.translated > 0));

  // A song arrives before its NEW artist's row: the artist is created on arrival, and the row that follows is the same one.
  backend.hold(r => r.table_name === 'artists');
  const s4 = newSong(A, 'Arrival Song', 'KIDS', 'Arrival Artist');
  intended.set(s4, { cat: catByCode(A, 'KIDS').uuid, artist: artist(A, 'Arrival Artist').uuid });
  await sync(A, B);
  check('P3.6', 'a song whose artist has not arrived yet gets the artist created on arrival (name shown)', songArtistName(B, s4) === 'Arrival Artist',
    `got "${songArtistName(B, s4)}"`);
  backend.release();
  await sync(A, B);
  const dupes = B.db.prepare("SELECT COUNT(*) n FROM artists WHERE name = 'Arrival Artist'").get().n;
  check('P3.7', 'when the artist row arrives it is the same artist — no duplicate', dupes === 1 && songArtistUuid(B, s4) === intended.get(s4).artist, `count ${dupes}`);
  // All metadata travels: the song's fields as written on A, read on B.
  const meta = (M, su) => M.db.prepare('SELECT genre, bpm, energy, cue_in_ms, intro_end_ms, cart_id FROM songs WHERE uuid = ?').get(su);
  check('P3.8', 'every song field arrives (genre, bpm, energy, cue, intro, cart number)', JSON.stringify(meta(A, s4)) === JSON.stringify(meta(B, s4)),
    `A ${JSON.stringify(meta(A, s4))} B ${JSON.stringify(meta(B, s4))}`);

  // A child that arrives before its parent: never written as a foreign number.
  backend.hold(r => r.table_name === 'categories');
  newCategory(B, 'LATE', 'Arrives late');
  const s3 = newSong(B, 'Late Song', 'LATE', null);
  await sync(A, B);
  const lateOnA = songCatUuid(A, s3);
  check('P3.4', 'a song whose category has not arrived is NOT filed under some other category on A', lateOnA === null, `got ${lateOnA}`);
  backend.release();
  await sync(A, B);
  check('P3.5', 'the late category itself arrives intact', !!catByCode(A, 'LATE'));

  log(`\n${passes} passed, ${failures} failed`);
  const dir = path.join(os.tmpdir(), 'ether-uuid-refs-gate');
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'result.txt'), out.join('\n') + '\n'); fs.writeFileSync(path.join(dir, 'report-B.txt'), reportText); } catch {}
  log(`(result and B's re-file report written to ${dir})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('GATE CRASHED:', e && e.stack || e); process.exit(1); });
