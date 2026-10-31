// Tools → Cloud Log Backup (dead-controls item 7): the description is sent and kept, "Auto-backup daily at midnight" is
// this computer's real cloud schedule, Restore goes through the sanctioned swap, and the old plan names are gone.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextLocalMidnight, isDaily, togglePatch, scheduleSentence, DAILY_MIN } from "./cloudBackupSchedule";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const notes = require_("../../electron/backup-notes.js");
const backups = require_("../../electron/backups.js");
const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec("CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  d.exec("CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, deleted_at TEXT)");
  return d;
}

describe("Description (optional)", () => {
  it("is kept next to the backup it belongs to and shown with it", () => {
    const d = db();
    expect(notes.addNote(d, "2026-10-31T12-00-00Z", "  Before   format change ")).toBe(true);
    const out = notes.attachNotes(d, [{ timestamp: "2026-10-31T12-00-00Z", key: "a" }, { timestamp: "2026-10-30T00-00-00Z", key: "b" }]);
    expect(out[0].description).toBe("Before format change");
    expect(out[1].description).toBeNull();
  });
  it("an empty description writes nothing", () => {
    const d = db();
    expect(notes.addNote(d, "2026-10-31T12-00-00Z", "   ")).toBe(false);
    expect(notes.readNotes(d)).toEqual({});
  });
  it("is sent: the screen passes it to the backup, and the backup puts it in the cloud metadata and keeps it", () => {
    const cb = read("src/components/CloudBackup.tsx");
    expect(cb).toMatch(/invoke\("cloud-backup:run-now", \{ description:/);
    const mod = read("electron/cloud-backup.js");
    expect(mod).toMatch(/runBackup\(dbPath, \{ description: opts && opts\.description \}\)/);
    expect(mod).toMatch(/const metadata\s*=\s*\{\s*description,/);
    expect(mod).toMatch(/addNote\(getDb\(\), timestamp, description\)/);
    expect(read("electron/main.js")).toMatch(/require\("\.\/backup-notes"\)\.attachNotes\(getDb\(\), withNotes\)/);
  });
});

describe("Auto-backup daily at midnight", () => {
  it("ON means cloud backups every day starting at the next local midnight; OFF turns cloud backups off", () => {
    const now = new Date(2026, 9, 31, 15, 30).getTime();
    const mid = nextLocalMidnight(now);
    expect(new Date(mid).getHours()).toBe(0);
    expect(new Date(mid).getDate()).toBe(1);
    expect(togglePatch(360, now)).toEqual({ cloudEveryMin: DAILY_MIN, cloudFirstAt: mid });
    expect(togglePatch(DAILY_MIN, now)).toEqual({ cloudEveryMin: 0 });
    expect(isDaily(DAILY_MIN)).toBe(true);
    expect(isDaily(360)).toBe(false);
  });
  it("the line under the toggle says what the schedule really is", () => {
    expect(scheduleSentence(0, null)).toMatch(/off on this computer/);
    expect(scheduleSentence(360, null)).toMatch(/every 6 hours/);
    expect(scheduleSentence(DAILY_MIN, null)).toMatch(/every day/);
  });
  it("the backups setting starts the daily schedule at midnight and keeps it there", () => {
    const d = db();
    const b = backups.create({ getDb: () => d, dbPath: () => "x", backupsDir: () => "x", cloudRun: async () => ({ ok: true }), healthEvent: () => {}, log: () => {} });
    const now = Date.now();
    const mid = nextLocalMidnight(now);
    const s = b.setSettings({ cloudEveryMin: DAILY_MIN, cloudFirstAt: mid });
    expect(s.cloudEveryMin).toBe(DAILY_MIN);
    expect(s.cloudNextAt).toBe(mid);
    // A first time in the past or beyond one interval is not honoured — one interval from now instead.
    const s2 = b.setSettings({ cloudEveryMin: 60, cloudFirstAt: now - 1000 });
    expect(s2.cloudNextAt).toBeGreaterThanOrEqual(now + 60 * 60000);
    // The next due time counts from the due time, not from when the minute tick noticed it.
    const step = DAILY_MIN * 60000;
    expect(backups.nextDue(mid, DAILY_MIN, mid + 45_000)).toBe(mid + step);
    expect(backups.nextDue(mid, DAILY_MIN, mid + 3 * step + 10)).toBe(mid + 4 * step);
  });
  it("the toggle no longer writes the setting nothing read", () => {
    const cb = read("src/components/CloudBackup.tsx");
    expect(cb).not.toMatch(/cloud_auto_backup/);
    expect(cb).toMatch(/invoke\("backups:set-settings", togglePatch\(/);
  });
});

describe("Saved Backups → Restore", () => {
  it("restores through the sanctioned swap, never by writing play_log from the screen", () => {
    const cb = read("src/components/CloudBackup.tsx");
    expect(cb).toMatch(/invoke\("backups:restore-cloud", b\.key\)/);
    expect(cb).toMatch(/invoke\("backups:list"\)/);
    expect(cb).not.toMatch(/DELETE FROM play_log/);
    expect(cb).not.toMatch(/\bexecute\(/);
  });
  it("an older play-history-only backup says plainly why it cannot be restored", () => {
    expect(read("src/components/CloudBackup.tsx")).toMatch(/older play-history-only backup\. Ether can't load it into a running station/);
  });
});

describe("plan names", () => {
  it("the screen and the backup messages use the current plan names", () => {
    for (const f of ["src/components/CloudBackup.tsx", "electron/cloud-backup.js"]) {
      const s = read(f);
      expect(s, f).not.toMatch(/Studio plan|Network plan|Studio \(pro\)|Pro Feature/);
    }
    expect(read("src/components/CloudBackup.tsx")).toMatch(/Station, Pro or Unlimited plan/);
  });
});
