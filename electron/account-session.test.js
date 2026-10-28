// Phase 0 of docs/account-sign-in-plan-2026-10-26.md (Jeff, 2026-10-28: "the sign-in token out of the database and
// backups"). The sign-in lives only in <profile>\auth.bin, encrypted; never in openair.db, never in a backup.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const Database = require_("better-sqlite3");
const { createAccountSession, SECRET_INSTALL_KEYS } = require_("./account-session");
const KV = require_("./sync/handlers/install_config_kv");

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjI1LCJ0eXAiOiJ1c2VyIn0.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
// A stand-in for safeStorage: reversible, and never the plain text on disk.
const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(Buffer.from(s, "utf8").map(b => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(Buffer.from(b).map(x => x ^ 0x5a)).toString("utf8"),
});
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ether-auth-"));
function dbWithToken(dir) {
  const db = new Database(path.join(dir, "openair.db"));
  db.exec(`CREATE TABLE install_config_kv (key TEXT PRIMARY KEY, value TEXT, uuid TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
           CREATE TABLE songs (id INTEGER PRIMARY KEY);`);
  db.prepare("INSERT INTO install_config_kv (key, value, uuid) VALUES ('account_jwt', ?, 'u1'), ('account_email', 'jeff@example.org', 'u2')").run(TOKEN);
  return db;
}

describe("the sign-in is kept in protected storage, outside the database", () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });

  it("set → auth.bin holds it encrypted (no plain text), and get reads it back after a restart", () => {
    const a = createAccountSession({ safeStorage: fakeSafe(), dir: () => dir });
    expect(a.set(TOKEN)).toEqual({ ok: true, stored: "protected" });
    const bytes = fs.readFileSync(path.join(dir, "auth.bin"));
    expect(bytes.toString("utf8")).not.toContain(TOKEN);
    expect(JWT_SHAPE.test(bytes.toString("latin1"))).toBe(false);
    const again = createAccountSession({ safeStorage: fakeSafe(), dir: () => dir });   // a new run
    expect(again.get()).toBe(TOKEN);
  });

  it("no protected storage → memory only for this run, never a plaintext file", () => {
    const a = createAccountSession({ safeStorage: fakeSafe(false), dir: () => dir });
    expect(a.set(TOKEN).stored).toBe("memory");
    expect(a.get()).toBe(TOKEN);
    expect(fs.existsSync(path.join(dir, "auth.bin"))).toBe(false);
  });

  it("clear (Sign Out) removes it", () => {
    const a = createAccountSession({ safeStorage: fakeSafe(), dir: () => dir });
    a.set(TOKEN); a.clear();
    expect(a.has()).toBe(false);
    expect(fs.existsSync(path.join(dir, "auth.bin"))).toBe(false);
  });

  it("each profile has its own sign-in (the folder is read at every call)", () => {
    const d2 = tmpDir(); let cur = dir;
    const a = createAccountSession({ safeStorage: fakeSafe(), dir: () => cur });
    a.set(TOKEN);
    cur = d2;
    expect(a.get()).toBe(null);
  });
});

describe("migration: an existing database token moves out, and its bytes are gone from the file", () => {
  it("moves the token to auth.bin, deletes the row, and the database file holds no JWT-shaped string", () => {
    const dir = tmpDir();
    const db = dbWithToken(dir);
    const a = createAccountSession({ safeStorage: fakeSafe(), dir: () => dir });
    const r = a.migrate(db);
    expect(r).toEqual({ moved: true, removed: 1 });
    expect(a.get()).toBe(TOKEN);
    expect(db.prepare("SELECT COUNT(*) n FROM install_config_kv WHERE key = 'account_jwt'").get().n).toBe(0);
    expect(db.prepare("SELECT value FROM install_config_kv WHERE key = 'account_email'").get().value).toBe("jeff@example.org");
    db.pragma("wal_checkpoint(TRUNCATE)"); db.close();
    expect(JWT_SHAPE.test(fs.readFileSync(path.join(dir, "openair.db")).toString("latin1"))).toBe(false);
  });
});

describe("the database cannot take it back", () => {
  it("install_config_kv refuses the key, and never lists or returns it", () => {
    const dir = tmpDir();
    const db = dbWithToken(dir);
    expect(() => KV.installConfigKvUpsertByKey(db, "account_jwt", TOKEN)).toThrow(/never stored in the database/);
    expect(KV.installConfigKvList(db).map(r => r.key)).not.toContain("account_jwt");
    expect(KV.installConfigKvGet(db, "account_jwt")).toBe(null);
    expect(SECRET_INSTALL_KEYS).toContain("account_jwt");
  });
  it("nothing in the app reads or writes the token through the database any more", () => {
    const strip = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    const main = strip(fs.readFileSync(path.join(__dirname, "main.js"), "utf8"));
    expect(main).not.toMatch(/key\s*=\s*'account_jwt'|key='account_jwt'|\["account_jwt"|upsertInstall\("account_jwt"/);
    for (const f of ["../src/App.tsx", "../src/components/OnboardingFlow.tsx", "../src/lib/memberships.ts"]) {
      expect(strip(fs.readFileSync(path.join(__dirname, f), "utf8")), f).not.toMatch(/['"]account_jwt['"]/);
    }
  });
});

describe("no sign-in in a backup", () => {
  it("the backup worker's copy of a database that still holds a token has no token row and no JWT-shaped bytes", async () => {
    const dir = tmpDir();
    const db = dbWithToken(dir); db.close();
    const { Worker } = require_("node:worker_threads");
    const out = path.join(dir, "backup.db");
    const res = await new Promise((resolve) => {
      const w = new Worker(path.join(__dirname, "backup-worker.js"), { workerData: { dbPath: path.join(dir, "openair.db"), outPath: out, gzip: false } });
      w.once("message", resolve); w.once("error", (e) => resolve({ ok: false, error: e.message }));
    });
    expect(res.ok, res.error).toBe(true);
    const copy = new Database(out, { readonly: true });
    expect(copy.prepare("SELECT COUNT(*) n FROM install_config_kv WHERE key = 'account_jwt'").get().n).toBe(0);
    expect(copy.prepare("SELECT value FROM install_config_kv WHERE key = 'account_email'").get().value).toBe("jeff@example.org");
    copy.close();
    expect(JWT_SHAPE.test(fs.readFileSync(out).toString("latin1"))).toBe(false);
  });
});

describe("Sign Out when Windows holds the file", () => {
  it("a refused delete still leaves no sign-in: the file is emptied, and the next start reads 'not signed in'", () => {
    const dir = tmpDir();
    const real = fs;
    const holding = { ...real, rmSync: () => { const e = new Error("EPERM: operation not permitted"); e.code = "EPERM"; throw e; } };
    const a = createAccountSession({ safeStorage: fakeSafe(), dir: () => dir, fs: holding });
    a.set(TOKEN);
    a.clear();
    expect(a.isSetUp()).toBe(false);
    const next = createAccountSession({ safeStorage: fakeSafe(), dir: () => dir });   // the next start
    expect(next.isSetUp()).toBe(false);
    expect(next.get()).toBe(null);
  }, 30000);   // each refused attempt waits briefly before the next; under a loaded machine that adds up
});
