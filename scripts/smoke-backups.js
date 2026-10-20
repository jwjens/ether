// scripts/smoke-backups.js — backups by setting, per computer (electron/backups.js + electron/backup-worker.js).
//   npm run test:backups
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const Database = require("better-sqlite3");
const ROOT = path.join(__dirname, "..");
const B = require(path.join(ROOT, "electron", "backups.js"));

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${extra ? "  — " + extra : ""}`); } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ether-backups-"));
  const dbFile = path.join(dir, "openair.db"), bdir = path.join(dir, "backups");
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
           CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, deleted_at TEXT);
           CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT);`);
  const ins = db.prepare("INSERT INTO songs (title) VALUES (?)");
  db.transaction(() => { for (let i = 0; i < 2000; i++) ins.run("Song " + i); })();
  db.prepare("INSERT INTO songs (title) VALUES ('only in the WAL')").run();   // not checkpointed: must be in the backup
  const events = [];
  let cloudCalls = 0;
  const b = B.create({ getDb: () => db, dbPath: () => dbFile, backupsDir: () => bdir, healthEvent: (k) => events.push(k),
                       cloudRun: async () => { cloudCalls++; return { ok: true }; }, log: () => {} });

  const s0 = b.settings();
  check("starting values = before 4.6.62: local off (keep 10 shown), cloud every 6 h, cloud keeps all", s0.localEveryMin === 0 && s0.localKeep === 10 && s0.cloudEveryMin === 360 && s0.cloudKeep === 0, JSON.stringify(s0));
  let refused = null; try { b.setSettings({ localEveryMin: 3 }); } catch (e) { refused = e.message; }
  check(`an interval under 5 minutes is refused ("${refused}")`, !!refused && /5 minutes/.test(refused));
  let r0 = null; try { b.setSettings({ cloudKeep: -1 }); } catch (e) { r0 = e.message; }
  check("a negative keep is refused", !!r0);

  const r = await b.runLocal("test");
  const copy = r.ok ? new Database(path.join(bdir, r.name), { readonly: true }) : null;
  check(`a local backup is made in the worker, verified, ${r.songs} songs, ${r.ms} ms`, r.ok && r.songs === 2001);
  check("it is a consistent copy: the change still in the WAL is in it", !!copy && copy.prepare("SELECT 1 FROM songs WHERE title = 'only in the WAL'").get());
  if (copy) copy.close();

  b.setSettings({ localKeep: 2 });
  for (let i = 0; i < 3; i++) { await new Promise(res => setTimeout(res, 1100)); await b.runLocal("test"); }
  check(`only the newest 2 are kept (${b.listLocal().length} on disk)`, b.listLocal().length === 2);

  // The schedule: no burst on first run; a due time in the past runs once; the next time is stored.
  db.prepare("DELETE FROM system_state WHERE key LIKE 'backup_cloud_next_at'").run();
  await b.tick();
  check("first run with no stored due time: nothing runs, the first cloud backup is one interval out", cloudCalls === 0 && b.settings().cloudNextAt > Date.now() + 350 * 60000);
  db.prepare("UPDATE system_state SET value = ? WHERE key = 'backup_cloud_next_at'").run(String(Date.now() - 1000));
  await b.tick();
  check("a due time in the past (the computer was off) runs once, and the next is stored", cloudCalls === 1 && b.settings().cloudNextAt > Date.now() + 350 * 60000);
  await b.tick();
  check("…and not again until it is due", cloudCalls === 1);

  // A backup that cannot be made leaves nothing behind and says so.
  const bad = B.create({ getDb: () => db, dbPath: () => path.join(dir, "missing.db"), backupsDir: () => bdir, healthEvent: (k) => events.push(k), cloudRun: async () => ({}), log: () => {} });
  const before = b.listLocal().length;
  const rb = await bad.runLocal("test");
  check(`a failed backup is reported (${rb.error}) and leaves no file`, !rb.ok && b.listLocal().length === before && events.includes("backup-local-failed"));

  db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
