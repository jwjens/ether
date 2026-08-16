import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const SANDBOX = path.join(os.tmpdir(), "ether-profile-paths-test");

/** Fresh module per test — profile-paths caches the active profile for the life of the process. */
function load(sub) {
  const root = path.join(SANDBOX, sub);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  process.env.LOCALAPPDATA = root;
  delete require_.cache[require_.resolve("./profile-paths.js")];
  return { P: require_("./profile-paths.js"), root };
}

const KEY = "ETH-STN-BAA8-E056-6FC8";
/** A profile is "there" when its database is — the pointer alone never counts. */
function seedProfile(P, key) {
  P.ensureProfileDir(key);
  fs.writeFileSync(P.dbPath(key), "");
}

beforeEach(() => { delete process.env.ETHER_DB_PATH; });
afterAll(() => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {} });

describe("profile key sanitising", () => {
  it("accepts a real license key and upper-cases it", () => {
    const { P } = load("sanitise");
    expect(P.sanitizeKey(KEY)).toBe(KEY);
    expect(P.sanitizeKey("  eth-stn-baa8-e056-6fc8  ")).toBe(KEY);
  });

  it("refuses traversal, separators and empties rather than escaping them", () => {
    const { P } = load("sanitise2");
    for (const bad of ["..", "../..", "a/b", "a\\b", "", "   ", null, undefined, "x", "key with spaces", "key:colon"]) {
      expect(P.sanitizeKey(bad)).toBeNull();
    }
  });

  it("never builds a path from an invalid key", () => {
    const { P } = load("sanitise3");
    expect(() => P.profileDir("../escape")).toThrow(/invalid profile key/);
    expect(() => P.writePointer("../escape")).toThrow(/invalid profile key/);
  });

  it("keeps the scratch profile outside the license-key namespace", () => {
    const { P } = load("sanitise4");
    expect(P.sanitizeKey(P.PENDING)).toBeNull();          // can never be typed as a real key
    expect(P.profileDir(P.PENDING)).toContain(P.PENDING); // but is still a usable directory
  });
});

describe("the pointer", () => {
  it("round-trips and is the only thing naming the active profile", () => {
    const { P } = load("pointer");
    seedProfile(P, KEY);
    P.writePointer(KEY);
    expect(P.readPointer()).toBe(KEY);
    expect(P.resolveActive()).toEqual({ key: KEY, pending: false });
  });

  it("leaves no torn pointer behind (atomic tmp+rename)", () => {
    const { P } = load("pointer-atomic");
    seedProfile(P, KEY);
    P.writePointer(KEY);
    expect(fs.existsSync(P.pointerFile() + ".tmp")).toBe(false);
  });

  it("clearing it routes the next resolve to sign-in without deleting data", () => {
    const { P } = load("pointer-clear");
    seedProfile(P, KEY);
    P.writePointer(KEY);
    P.clearPointer();
    expect(P.readPointer()).toBeNull();
    expect(fs.existsSync(P.dbPath(KEY))).toBe(true);   // signing out destroys nothing
  });
});

describe("edge rule 1 — never guess, never auto-create from a stale pointer", () => {
  it("no pointer at all → pending, and no account profile invented", () => {
    const { P } = load("no-pointer");
    const active = P.resolveActive({ freshPending: true });
    expect(active.pending).toBe(true);
    expect(active.key).toBe(P.PENDING);
    expect(P.listProfiles()).toEqual([]);
  });

  it("pointer naming a missing profile → pending, and that profile is NOT created", () => {
    const { P } = load("dangling");
    P.writePointer("ETH-STN-DEAD-BEEF-0000");
    const active = P.resolveActive({ freshPending: true });
    expect(active.pending).toBe(true);
    expect(P.profileExists("ETH-STN-DEAD-BEEF-0000")).toBe(false);
    expect(P.listProfiles()).toEqual([]);
  });

  it("a pointer with a directory but no database is still not a profile", () => {
    const { P } = load("empty-dir");
    P.ensureProfileDir(KEY);          // directory only — no openair.db
    P.writePointer(KEY);
    expect(P.profileExists(KEY)).toBe(false);
    expect(P.resolveActive({ freshPending: true }).pending).toBe(true);
  });

  it("resets the scratch profile on a cold start so a half-finished sign-in is never adopted", () => {
    const { P } = load("stale-pending");
    P.ensureProfileDir(P.PENDING);
    fs.writeFileSync(path.join(P.profileDir(P.PENDING), "leftover.txt"), "from an abandoned sign-in");
    P.resolveActive({ freshPending: true });
    expect(fs.existsSync(path.join(P.profileDir(P.PENDING), "leftover.txt"))).toBe(false);
  });
});

describe("isolation is the directory", () => {
  it("two accounts never share a path", () => {
    const { P } = load("two-accounts");
    const a = "ETH-STN-AAAA-1111-2222";
    const b = "ETH-STN-BBBB-3333-4444";
    for (const f of ["dbPath", "logsDir", "healthEventsFile", "restoreFailuresLog", "cloudRestoreTmp", "automationIntentFile"]) {
      expect(P[f](a)).not.toBe(P[f](b));
      expect(P[f](a).startsWith(P.profileDir(a))).toBe(true);
    }
    expect(P.markerPath(a, ".ether-on-air")).not.toBe(P.markerPath(b, ".ether-on-air"));
  });

  it("lists real profiles and never the scratch one", () => {
    const { P } = load("listing");
    seedProfile(P, "ETH-STN-AAAA-1111-2222");
    seedProfile(P, "ETH-STN-BBBB-3333-4444");
    P.ensureProfileDir(P.PENDING);
    expect(P.listProfiles().sort()).toEqual(["ETH-STN-AAAA-1111-2222", "ETH-STN-BBBB-3333-4444"]);
  });

  it("keeps the pointer and the staged engine OUTSIDE every profile (edge rule 3)", () => {
    const { P } = load("outside");
    seedProfile(P, KEY);
    expect(P.pointerFile().startsWith(P.profileDir(KEY))).toBe(false);
    expect(P.engineStageDir().startsWith(P.profilesRoot())).toBe(false);
    expect(P.engineStageDir()).toBe(path.join(P.etherRoot(), "engine"));
  });
});

describe("switching profiles in process", () => {
  it("setActive re-points every path builder at once", () => {
    const { P } = load("switch");
    const a = "ETH-STN-AAAA-1111-2222";
    const b = "ETH-STN-BBBB-3333-4444";
    seedProfile(P, a); seedProfile(P, b);
    P.writePointer(a);
    expect(P.activeKey()).toBe(a);
    P.setActive(b);
    expect(P.activeKey()).toBe(b);
    expect(P.isPending()).toBe(false);
    expect(P.dbPath(P.activeKey())).toBe(P.dbPath(b));
  });

  it("refuses to activate a key it would not build a path for", () => {
    const { P } = load("switch-bad");
    expect(() => P.setActive("../escape")).toThrow(/invalid profile key/);
  });
});
