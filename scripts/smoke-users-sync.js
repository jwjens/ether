// scripts/smoke-users-sync.js — slow PIN hash + users sync (v67). Jeff, 2026-10-20: "switch PINs to a slow hash first,
// then add users to sync as planned (same name + same station = one person)".
//   npm run test:users-sync
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const ROOT = path.join(__dirname, "..");
const PinHash = require(path.join(ROOT, "electron", "pin-hash.js"));
const U = require(path.join(ROOT, "electron", "sync", "handlers", "users.js"));
const T = require(path.join(ROOT, "electron", "sync", "synced-tables.js"));
const mig = require(path.join(ROOT, "scripts", "migrate-users-sync-phase-sync-67.js"));

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${extra ? "  — " + extra : ""}`); } };

(async () => {
  // ── 1 · the hash ──────────────────────────────────────────────────────────────────────────────────────────────────
  const t0 = Date.now(); const h = await PinHash.hashPin("4821"); const hashMs = Date.now() - t0;
  check(`a new PIN is stored as scrypt (${h.slice(0, 20)}…, ${hashMs} ms)`, h.startsWith("scrypt$32768$8$1$") && !h.includes("4821"));
  check("the right PIN verifies; nothing to upgrade", JSON.stringify(await PinHash.verifyPin("4821", h)) === JSON.stringify({ ok: true, needsUpgrade: false }));
  check("a wrong PIN does not", (await PinHash.verifyPin("4822", h)).ok === false);
  const salt = crypto.randomBytes(16).toString("hex"), old = salt + ":" + crypto.createHash("sha256").update(salt + "1357").digest("hex");
  check("an old salt:sha256 PIN still verifies, and says it needs upgrading", JSON.stringify(await PinHash.verifyPin("1357", old)) === JSON.stringify({ ok: true, needsUpgrade: true }));
  check("…a wrong PIN against it neither verifies nor asks for an upgrade", JSON.stringify(await PinHash.verifyPin("1358", old)) === JSON.stringify({ ok: false, needsUpgrade: false }));
  check("a PIN stored in the clear verifies and needs upgrading; it is recognised as plain", (await PinHash.verifyPin("2468", "2468")).needsUpgrade && PinHash.isPlain("2468") && !PinHash.isPlain(old) && !PinHash.isPlain(h));

  // ── 2 · the database: the live users table + v67 ──────────────────────────────────────────────────────────────────
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ether-users-")), "smoke.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'jock', pin_hash TEXT,
                        color TEXT NOT NULL DEFAULT '#22d3ee', station_id INTEGER NOT NULL DEFAULT 1, station_uuid TEXT);
    CREATE TABLE stations (id INTEGER PRIMARY KEY, name TEXT, uuid TEXT);
    CREATE TABLE client_identity (id INTEGER PRIMARY KEY, client_id TEXT NOT NULL, created_at TEXT, label TEXT);
    CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
    CREATE TABLE mutations (id TEXT PRIMARY KEY, client_id TEXT, station_id TEXT, actor_id TEXT, table_name TEXT, row_id TEXT, op TEXT,
                            payload_before TEXT, payload_after TEXT, created_at TEXT, applied_at TEXT, hlc TEXT, parent_mutation_id TEXT,
                            schema_version INTEGER, origin TEXT, sync_status TEXT, conflict_resolution TEXT, station_uuid TEXT);
    INSERT INTO client_identity (id, client_id) VALUES (1, '11111111-2222-3333-4444-555555555555');
    INSERT INTO system_state (key, value) VALUES ('hlc_last', '1745000000000:0:11111111-2222-3333-4444-555555555555');
    INSERT INTO schema_version (version) VALUES (66);
    INSERT INTO stations VALUES (2, 'halloVeen', '43889edc-0000-4000-8000-000000000002');
    INSERT INTO users (name, role, pin_hash, station_id) VALUES ('Admin', 'admin', NULL, 2), ('Ryan', 'admin', NULL, 2);
  `);
  mig.applyMigration(db);
  const cols = new Set(db.prepare("PRAGMA table_info(users)").all().map(c => c.name));
  check("v67 adds uuid / created_at / updated_at / deleted_at", ["uuid", "created_at", "updated_at", "deleted_at"].every(c => cols.has(c)));
  check("v67 gives every existing user a uuid", db.prepare("SELECT COUNT(*) n FROM users WHERE uuid IS NULL").get().n === 0);
  const uuidsBefore = db.prepare("SELECT uuid FROM users ORDER BY id").all().map(r => r.uuid).join();
  mig.applyMigration(db);
  check("v67 run twice changes nothing", db.prepare("SELECT uuid FROM users ORDER BY id").all().map(r => r.uuid).join() === uuidsBefore);
  check("users is a synced, station-scoped table; its station travels by identity", T.REGISTRY.users && T.REGISTRY.users.scope === "station" && !T.isSyncExcluded("users") && T.refsOf("users").station_id === "stations");

  // ── 3 · writes are journaled; a PIN never travels in the clear ────────────────────────────────────────────────────
  const shawna = await U.userAdd(db, { name: " Shawna ", role: "admin", pin: "9090", color: "#fff", station_id: 2 });
  const ins = db.prepare("SELECT * FROM mutations WHERE table_name = 'users' AND op = 'insert' AND row_id = ?").get(shawna.uuid);
  check("add: journaled (it will sync), name trimmed, PIN stored as scrypt", !!ins && shawna.name === "Shawna" && PinHash.isScrypt(shawna.pin_hash));
  check("add: the PIN itself is nowhere in the journal", !db.prepare("SELECT 1 FROM mutations WHERE payload_after LIKE '%9090%' OR payload_before LIKE '%9090%'").get());
  await U.userSetPin(db, shawna.id, "1212");
  const afterPin = db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(shawna.id).pin_hash;
  check("set PIN: journaled, scrypt, verifies", (await PinHash.verifyPin("1212", afterPin)).ok && db.prepare("SELECT COUNT(*) n FROM mutations WHERE row_id = ? AND op = 'update'").get(shawna.uuid).n === 1);
  U.userUpdate(db, shawna.id, { role: "jock" });
  U.userRemove(db, shawna.id);
  const gone = db.prepare("SELECT deleted_at FROM users WHERE id = ?").get(shawna.id);
  check("remove: a soft delete (it travels), journaled", !!gone.deleted_at && db.prepare("SELECT COUNT(*) n FROM mutations WHERE row_id = ? AND op = 'update'").get(shawna.uuid).n === 3);
  let refused = false; const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL").all();
  U.userRemove(db, admins[0].id);
  try { U.userRemove(db, admins[1].id); } catch (e) { refused = /last administrator/.test(e.message); }
  check("the last administrator cannot be removed", refused);
  let badPin = false; try { await U.userAdd(db, { name: "X", pin: "12", station_id: 2 }); } catch (e) { badPin = /4 digits/.test(e.message); }
  check("a PIN that is not 4 digits is refused", badPin);

  // ── 4 · same name + same station = one person ─────────────────────────────────────────────────────────────────────
  const a = { uuid: "aaaaaaaa-0000-4000-8000-000000000001", pin: await PinHash.hashPin("1111"), at: "2026-10-20T10:00:00.000Z" };
  const b = { uuid: "bbbbbbbb-0000-4000-8000-000000000002", pin: await PinHash.hashPin("2222"), at: "2026-10-20T12:00:00.000Z" };
  db.prepare("INSERT INTO users (name, role, pin_hash, color, station_id, uuid, created_at, updated_at) VALUES ('Steve', 'jock', ?, '#111', 2, ?, ?, ?)").run(a.pin, a.uuid, a.at, a.at);
  db.prepare("INSERT INTO users (name, role, pin_hash, color, station_id, uuid, created_at, updated_at) VALUES ('steve ', 'admin', ?, '#222', 2, ?, ?, ?)").run(b.pin, b.uuid, b.at, b.at);
  db.prepare("INSERT INTO users (name, role, pin_hash, color, station_id, uuid, created_at, updated_at) VALUES ('Steve', 'jock', NULL, '#333', 9, ?, ?, ?)").run("cccccccc-0000-4000-8000-000000000003", a.at, a.at);
  const merged = U.mergeSamePerson(db);
  const keep = db.prepare("SELECT * FROM users WHERE uuid = ?").get(a.uuid), lose = db.prepare("SELECT * FROM users WHERE uuid = ?").get(b.uuid);
  check("two Steves on station 2 (any case, trimmed) become one: the smaller uuid is kept, the other removed", merged.length === 1 && !keep.deleted_at && !!lose.deleted_at);
  check("the kept one takes the newer one's role, colour and PIN", keep.role === "admin" && keep.color === "#222" && (await PinHash.verifyPin("2222", keep.pin_hash)).ok);
  check("a Steve on another station is a different person — untouched", !db.prepare("SELECT deleted_at FROM users WHERE uuid = 'cccccccc-0000-4000-8000-000000000003'").get().deleted_at);
  check("the merge is journaled (both computers agree) and running it again does nothing",
    db.prepare("SELECT COUNT(*) n FROM mutations WHERE row_id IN (?, ?)").get(a.uuid, b.uuid).n === 2 && U.mergeSamePerson(db).length === 0);

  db.close();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
