// scripts/prove-two-computers.js — TWO COMPUTERS AIRING THE SAME STATION, proven with two separate databases and the
// REAL sync code against a LOCAL test server (Jeff, 2026-10-20: "Prove it with two separate databases and the real sync
// code against a local test server on OVEVENTS, nothing touching the real backend or any account.").
//
//   Server   = the REAL ether-backend sync router (ether-backend/src/routes/sync.js) on an in-memory Postgres (pg-mem),
//              listening on 127.0.0.1 only. No account, no real backend.
//   Computer A / B = two real Ether databases (schema-v0-baseline + every migration, as a fresh install builds it), each
//              with its own computer identity, the SAME stations (same uuids) under DIFFERENT local numbers, driven by
//              the REAL SyncScheduler (main engine + one pull engine per station), HttpTransport, MergeEngine, the
//              daemon's play writer (audiod/playlog.js), the song / user writers, restore-sync.js and plays-here.js.
//
//   ELECTRON_RUN_AS_NODE=1 electron scripts/prove-two-computers.js      (npm run prove:two-computers)
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const ROOT = path.join(__dirname, "..");
const BACKEND = process.env.ETHER_BACKEND_DIR || path.join(ROOT, "..", "ether-backend");
const Database = require("better-sqlite3");
const express = require(path.join(BACKEND, "node_modules", "express"));
const { newDb } = require(path.join(BACKEND, "node_modules", "pg-mem"));
process.env.SYNC_SERVER_ID = process.env.SYNC_SERVER_ID || "prove-two-computers";
const makeSyncRouter = require(path.join(BACKEND, "src", "routes", "sync"));

const { SyncScheduler } = require(path.join(ROOT, "electron", "sync", "sync-scheduler"));
const { SyncEngine } = require(path.join(ROOT, "electron", "sync", "sync-engine"));
const { HttpTransport } = require(path.join(ROOT, "electron", "sync", "transport-http"));
const playlog = require(path.join(ROOT, "audiod", "playlog.js"));
const Songs = require(path.join(ROOT, "electron", "sync", "handlers", "songs.js"));
const Users = require(path.join(ROOT, "electron", "sync", "handlers", "users.js"));
const RS = require(path.join(ROOT, "electron", "sync", "restore-sync.js"));
const { buildRestMaps } = require(path.join(ROOT, "electron", "separation-enforce.js"));

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${extra ? "  — " + extra : ""}`); } };
const section = (t) => console.log(`\n== ${t} ==`);

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ether-two-computers-"));
const HV = "43889edc-0000-4000-8000-0000000000aa";      // "HalloVeen (test)"
const KIDS = "752f4b9a-0000-4000-8000-0000000000bb";    // "Kids (test)" — never the active station on B
const CAT = { KIDS: "cat-kids-0000-4000-8000-000000000001", ADULT: "cat-adult-000-4000-8000-000000000002", UP: "cat-upbeat-00-4000-8000-000000000003" };

// ── a real Ether database, built the way a fresh install builds it ───────────────────────────────────────────────────
function buildDb(file, clientId, name, localNumbers) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  require(path.join(ROOT, "scripts", "schema-v0-baseline.js"))(db);
  db.prepare("INSERT INTO stations (name) VALUES ('Station 1')").run();
  const scripts = fs.readdirSync(path.join(ROOT, "scripts")).map(f => /^migrate-.+-phase-sync-(\d+)\.js$/.exec(f)).filter(Boolean)
    .map(m => ({ v: +m[1], f: m[0] })).sort((a, b) => a.v - b.v);
  const quiet = console.log; console.log = () => {};
  try { for (const { f } of scripts) { try { require(path.join(ROOT, "scripts", f)).applyMigration(db); } catch (e) { quiet(`  (migration ${f}: ${e.message})`); } } }
  finally { console.log = quiet; }
  db.prepare("UPDATE client_identity SET client_id = ?").run(clientId);
  if (!db.prepare("SELECT 1 FROM client_identity").get()) db.prepare("INSERT INTO client_identity (client_id) VALUES (?)").run(clientId);
  db.prepare("INSERT OR REPLACE INTO install_config_kv (key, value, uuid, created_at, updated_at) VALUES ('account_license_key', 'TEST-LICENSE', 'lk-uuid', 'x', 'x')").run();
  // The same two stations on both computers (same uuids), under DIFFERENT local numbers.
  for (let i = 0; i < localNumbers.pad; i++) db.prepare("INSERT INTO stations (name, uuid) VALUES (?, ?)").run(`pad ${i}`, `pad-${name}-${i}`);
  const hv = db.prepare("INSERT INTO stations (name, uuid, is_active) VALUES ('HalloVeen (test)', ?, 1)").run(HV).lastInsertRowid;
  const kids = db.prepare("INSERT INTO stations (name, uuid, is_active) VALUES ('Kids (test)', ?, 0)").run(KIDS).lastInsertRowid;
  for (const [k, u] of Object.entries(CAT)) db.prepare("INSERT INTO categories (station_id, code, name, uuid) VALUES (?, ?, ?, ?)").run(hv, k.toLowerCase(), k, u);
  return { db, hv: Number(hv), kids: Number(kids), clientId, name, file };
}

function scheduler(c, baseUrl) {
  const getDb = () => c.db;
  return new SyncScheduler(getDb, new HttpTransport(getDb, { baseUrl }), {
    getStationId: () => null, getStationUuid: () => null, uuidIdentity: true,
    stationUuids: () => c.db.prepare("SELECT uuid FROM stations WHERE deleted_at IS NULL AND uuid NOT LIKE 'pad-%' AND uuid IS NOT NULL").all().map(r => r.uuid),
    makeStationEngine: (conn, uuid, opts) => new SyncEngine(conn, new HttpTransport(getDb, { baseUrl, cursorKey: "sync_server_seq_station_" + uuid }), {
      ...opts, uuidIdentity: true, pullOnly: true, cursorKey: "sync_cursor_station_" + uuid,
      getStationId: () => { const r = conn.prepare("SELECT id FROM stations WHERE uuid = ?").get(uuid); return r ? String(r.id) : null; },
      getStationUuid: () => uuid,
    }),
  });
}
// One full sync cycle (push + every station's pull), exactly the scheduler's own tick.
async function cycle(s) { s._running = true; s._paused = false; s._tickCount = 0; await s._tick(); s._clearTimer(); s._running = false; }
async function settle(...ss) { for (let i = 0; i < 4; i++) for (const s of ss) await cycle(s); }

const asComputer = (name, fn) => { const h = os.hostname; os.hostname = () => name; try { return fn(); } finally { os.hostname = h; } };
const play = (c, stationId, title, at) => asComputer(c.name, () => playlog.logPlay(c.db, { stationId, title, artist: "A", deck: "A", durationMs: 180000, filePath: `C:/m/${title}.mp3`, playedAt: at }));
const catId = (c, uuid) => c.db.prepare("SELECT id FROM categories WHERE uuid = ?").get(uuid).id;
const catOf = (c, songUuid) => { const r = c.db.prepare("SELECT c.uuid u FROM songs s LEFT JOIN categories c ON c.id = s.category_id WHERE s.uuid = ?").get(songUuid); return r ? r.u : undefined; };

(async () => {
  // ── the local test server ──────────────────────────────────────────────────────────────────────────────────────────
  const pg = newDb();
  pg.public.none(`CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT)`);
  pg.public.none(`CREATE TABLE mutations (server_seq BIGSERIAL PRIMARY KEY, id TEXT, client_id TEXT, station_id TEXT, operator_id TEXT,
    license_key_id INTEGER, table_name TEXT, row_id TEXT, op TEXT, payload_before JSONB, payload_after JSONB, created_at TIMESTAMPTZ,
    hlc TEXT, parent_mutation_id TEXT, schema_version INTEGER, conflict_resolution JSONB, station_uuid TEXT, ref_uuids JSONB,
    CONSTRAINT mutations_lic_id UNIQUE (license_key_id, id))`);
  pg.public.none(`CREATE TABLE library_grants (id SERIAL PRIMARY KEY, owner_license_id INTEGER NOT NULL, grantee_license_id INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), revoked_at TIMESTAMPTZ)`);
  const { Pool } = pg.adapters.createPg();
  const pool = new Pool();
  await pool.query(`INSERT INTO licenses (id, email) VALUES (1, 'test-account')`);
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req, _res, next) => { req.license = { id: 1 }; next(); });   // one test account; no real auth, no real account
  app.use("/sync", makeSyncRouter(pool));
  app.get("/health", (_q, r) => r.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`local test server ${baseUrl} (pg-mem) · databases in ${DIR}`);

  const A = buildDb(path.join(DIR, "A.db"), "aaaaaaaa-0000-4000-8000-00000000000a", "COMPUTER-A", { pad: 0 });
  const B = buildDb(path.join(DIR, "B.db"), "bbbbbbbb-0000-4000-8000-00000000000b", "COMPUTER-B", { pad: 3 });
  const SA = scheduler(A, baseUrl), SB = scheduler(B, baseUrl);
  const now = Math.floor(Date.now() / 1000);

  section("1 · same station, different local numbers");
  check(`HalloVeen is station ${A.hv} on A and ${B.hv} on B; Kids ${A.kids} / ${B.kids}`, A.hv !== B.hv && A.kids !== B.kids);

  section("2 · plays sync, every play records which computer aired it");
  play(A, A.hv, "Monster Mash", now - 600);  play(A, A.hv, "Thriller", now - 400);
  play(B, B.hv, "Ghostbusters", now - 500);
  play(A, A.kids, "Baby Shark", now - 300);              // a station that is NOT active on B
  await settle(SA, SB);
  const onB = B.db.prepare("SELECT title, station_id, machine_id, machine_name FROM play_log ORDER BY played_at").all();
  const hvOnB = onB.filter(p => p.station_id === B.hv);
  check("B has A's two HalloVeen plays and its own, under B's own station number", hvOnB.length === 3 && hvOnB.filter(p => p.machine_name === "COMPUTER-A").length === 2, JSON.stringify(hvOnB));
  check("each play names its computer (Aired on): A's say COMPUTER-A, B's say COMPUTER-B", hvOnB.find(p => p.title === "Ghostbusters").machine_name === "COMPUTER-B" && hvOnB.find(p => p.title === "Thriller").machine_id === A.clientId);
  check("a station that is not active on B still receives (Kids: A's play arrives under B's Kids number)", onB.some(p => p.title === "Baby Shark" && p.station_id === B.kids));
  const onA = A.db.prepare("SELECT title, machine_name FROM play_log WHERE station_id = ?").all(A.hv);
  check("A has B's play too", onA.some(p => p.title === "Ghostbusters" && p.machine_name === "COMPUTER-B"));

  section("3 · each computer's rotation counts the plays that aired on that computer");
  const restB = buildRestMaps(B.db, B.hv).restByTitle, restA = buildRestMaps(A.db, A.hv).restByTitle;
  check("B rests its own Ghostbusters, not A's Monster Mash / Thriller", restB.has("ghostbusters") && !restB.has("monster mash") && !restB.has("thriller"));
  check("A rests its own Monster Mash and Thriller, not B's Ghostbusters", restA.has("monster mash") && restA.has("thriller") && !restA.has("ghostbusters"));

  section("4 · program logs are local, never synced");
  A.db.prepare("INSERT INTO generated_schedule (station_id, scheduled_at, title, uuid, generated_at) VALUES (?, ?, 'A log row', 'gs-a-1', ?)").run(A.hv, now + 3600, new Date().toISOString());
  await settle(SA, SB);
  check("A's log row never reaches B", !B.db.prepare("SELECT 1 FROM generated_schedule WHERE uuid = 'gs-a-1'").get());

  section("5 · users sync; same name + same station = one person");
  const ryan = await Users.userAdd(A.db, { name: "Ryan", role: "admin", pin: "1234", color: "#f00", station_id: A.hv });
  await Users.userAdd(A.db, { name: "Steve", role: "jock", pin: "1111", station_id: A.hv });
  await Users.userAdd(B.db, { name: "steve", role: "admin", pin: "2222", station_id: B.hv });
  await settle(SA, SB);
  check("a user added on A appears on B, under B's station number", !!B.db.prepare("SELECT 1 FROM users WHERE uuid = ? AND station_id = ? AND deleted_at IS NULL").get(ryan.uuid, B.hv));
  Users.mergeSamePerson(A.db); Users.mergeSamePerson(B.db);
  await settle(SA, SB);
  const stevesA = A.db.prepare("SELECT uuid FROM users WHERE lower(trim(name)) = 'steve' AND deleted_at IS NULL").all();
  const stevesB = B.db.prepare("SELECT uuid FROM users WHERE lower(trim(name)) = 'steve' AND deleted_at IS NULL").all();
  check("the two Steves become one, and both computers keep the same one", stevesA.length === 1 && stevesB.length === 1 && stevesA[0].uuid === stevesB[0].uuid, JSON.stringify({ stevesA, stevesB }));

  section("6 · the sync switch, a restore, and what follows");
  // Songs on both computers (made on A, synced).
  const songs = [];
  for (const t of ["Song 1", "Song 2", "Song 3", "Song 4"]) songs.push(Songs.songsCreate(A.db, { title: t, file_path: `C:/m/${t}.mp3`, category_id: catId(A, CAT.KIDS), content_class: "MUSIC" }).uuid);
  await settle(SA, SB);
  check("four songs in Kids on both computers", songs.every(u => catOf(A, u) === CAT.KIDS && catOf(B, u) === CAT.KIDS));
  // A backup of A, before the mistake — taken while one change was still waiting to go out (a real backup can hold
  // unsent changes; a restore must never send them).
  Songs.songsUpdate(A.db, songs[0], { genre: "pending-at-backup" });
  const backupFile = path.join(DIR, "A-backup.db");
  await A.db.backup(backupFile);
  await settle(SA, SB);
  // THE MISTAKE, sent while sync was on: three songs moved to Upbeat, one junk song added.
  for (const u of songs.slice(0, 3)) Songs.songsUpdate(A.db, u, { category_id: catId(A, CAT.UP) });
  const junk = Songs.songsCreate(A.db, { title: "JUNK", file_path: "C:/m/junk.mp3", category_id: catId(A, CAT.UP), content_class: "MUSIC" }).uuid;
  await settle(SA, SB);
  check("the mistake reached B (sync was on): three songs in Upbeat, the junk song there", songs.slice(0, 3).every(u => catOf(B, u) === CAT.UP) && catOf(B, junk) === CAT.UP);
  // Meanwhile B makes its own, unrelated change.
  Songs.songsUpdate(B.db, songs[3], { category_id: catId(B, CAT.ADULT) });
  await cycle(SB);
  // A: SYNC OFF. Another mistake, NOT sent.
  Songs.songsUpdate(A.db, songs[3], { title: "WRONG TITLE (made with sync off)" });
  const unsent = A.db.prepare("SELECT COUNT(*) n FROM mutations WHERE sync_status = 'pending'").get().n;
  check(`with sync off, A's change waits unsent (${unsent} pending) and B never sees it`, unsent > 0 && B.db.prepare("SELECT title FROM songs WHERE uuid = ?").get(songs[3]).title === "Song 4");

  // RESTORE A from the backup — the swap main does (rollback copy, file replaced, reopened), then restore-sync.
  const restoreA = (target) => {
    const pre = target.file + ".pre-restore";
    target.db.close(); fs.copyFileSync(target.file, pre);
    for (const s of ["-wal", "-shm"]) { try { fs.rmSync(target.file + s, { force: true }); } catch {} }
    fs.copyFileSync(backupFile, target.file);
    target.db = new Database(target.file); target.db.pragma("journal_mode = WAL");
    const pt = RS.captureRestorePoint(target.db, pre, { dir: DIR, backupLabel: "A-backup.db" });
    const discarded = RS.discardUnsent(target.db);
    fs.rmSync(pre, { force: true });
    return { pt, discarded };
  };
  // (a) WITHOUT the action — on a copy of A, so both outcomes are shown from the same start.
  const A2 = { ...A, file: path.join(DIR, "A2.db") };
  A.db.close(); fs.copyFileSync(A.file, A2.file); A.db = new Database(A.file); A.db.pragma("journal_mode = WAL");
  A2.db = new Database(A2.file); A2.db.pragma("journal_mode = WAL");
  const r2 = restoreA(A2);
  check(`restore discards every unsent change (${r2.discarded}) and keeps this computer's sent changes since the backup (${r2.pt.changes} on ${r2.pt.rows} rows)`, r2.discarded >= 1 && r2.pt.rows >= 4);
  const SA2 = scheduler(A2, baseUrl);
  await settle(SA2);
  check("(a) switching sync back on WITHOUT the action: A catches up — the mistake comes back to A too", songs.slice(0, 3).every(u => catOf(A2, u) === CAT.UP) && catOf(A2, junk) === CAT.UP);
  check("(a) …and the unsent change never left: B's song 4 title is untouched", B.db.prepare("SELECT title FROM songs WHERE uuid = ?").get(songs[3]).title === "Song 4");
  A2.db.close();

  // (b) WITH "Send this restore to every machine".
  const r = restoreA(A);
  const SAr = scheduler(A, baseUrl);
  const point = RS.readRestorePoint(DIR);
  console.log("  restore point rows: " + point.rows.map(x => `${x.table}:${(x.last && (x.last.title || x.last.name)) || x.row_id.slice(0, 8)}`).join(", "));
  const pv = RS.previewRestore(A.db, point);
  check(`the confirm can say what it will do: ${pv.putBack} row(s) put back, ${pv.remove} removed`, pv.putBack >= 3 && pv.remove >= 1);
  const sent = RS.sendRestore(A.db, point, DIR);
  await settle(SAr, SB);
  check(`(b) on B the mistaken rows are back to the backup (Kids), sent by A (${sent.putBack} put back, ${sent.removed} removed)`, songs.slice(0, 3).every(u => catOf(B, u) === CAT.KIDS), JSON.stringify(songs.slice(0, 3).map(u => catOf(B, u))));
  check("(b) the song the mistake created is gone on B (removed)", !!B.db.prepare("SELECT deleted_at FROM songs WHERE uuid = ?").get(junk)?.deleted_at);
  check("(b) B's own unrelated change made meanwhile is still there (song 4 in HV Adult) — and reaches A", catOf(B, songs[3]) === CAT.ADULT && catOf(A, songs[3]) === CAT.ADULT);
  check("(b) A does NOT get the mistake back on catch-up", songs.slice(0, 3).every(u => catOf(A, u) === CAT.KIDS) && !A.db.prepare("SELECT 1 FROM songs WHERE uuid = ? AND deleted_at IS NULL AND category_id IS NOT NULL AND category_id = ?").get(junk, catId(A, CAT.UP)));
  check("(b) the unsent change never left: B's song 4 title is untouched", B.db.prepare("SELECT title FROM songs WHERE uuid = ?").get(songs[3]).title === "Song 4");
  check("(b) a restore is sent once: a second send does nothing", RS.sendRestore(A.db, RS.readRestorePoint(DIR), DIR).putBack === 0);

  server.close();
  for (const c of [A, B]) { try { c.db.close(); } catch {} }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
