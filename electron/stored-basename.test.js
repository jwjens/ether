// WINDOWS PATHS ON macOS/Linux — the stored-path basename, the library lookup, and Re-sync.
// docs/mac-install-no-engine-windows-paths-2026-09-30.md §2 and §7.
//
// On POSIX, path.basename() does not split on `\`, so a row synced from Jeff's PC
// (`C:\Users\jensj\AppData\Local\Ether\catalogue\ABC.mp3`) came back WHOLE on his Mac: 725 rows read
// OUTSIDE with the files sitting in the catalogue, Re-sync could not relink them, and the materializer
// wrote 92 files literally named `C:\Users\…\x.mp3`. CI's test job runs on ubuntu-latest — POSIX, the
// same path semantics as the Mac — so this gate runs where the bug lives.
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { storedBasename, buildIndex, findInIndex } = require_("./audio-library-index.js");
const { matchStation, applyRelink } = require_("./library-folders.js");
const Database = require_("better-sqlite3");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ether-stored-basename-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("storedBasename — the file name of a stored path, whichever OS wrote it", () => {
  it.each([
    ["C:\\Users\\jensj\\AppData\\Local\\Ether\\catalogue\\ABC.mp3", "ABC.mp3"],
    ["C:\\Users\\jensj\\Music\\ether music library\\...Baby One More Time.mp3", "...Baby One More Time.mp3"],
    ["c:/users/jensj/catalogue/Mixed Seps.wav", "Mixed Seps.wav"],
    ["C:\\Users\\jensj/catalogue\\mixed/Both Ways.mp3", "Both Ways.mp3"],
    ["\\\\NAS\\share\\audio\\Unc Song.flac", "Unc Song.flac"],
    ["H:\\Ether\\catalogue\\", "catalogue"],
    ["/Users/admin/Music/ether music library/ABC.mp3", "ABC.mp3"],
    ["relative/dir/Rel.mp3", "Rel.mp3"],
    ["JustAName.mp3", "JustAName.mp3"],
    ["", ""],
  ])("%s → %s", (stored, want) => {
    expect(storedBasename(stored)).toBe(want);
  });

  it("null/undefined are an empty name, not a throw", () => {
    expect(storedBasename(null)).toBe("");
    expect(storedBasename(undefined)).toBe("");
  });

  it("path.basename is the defect on POSIX — the reason this helper exists", () => {
    if (process.platform === "win32") return;   // Windows' path.basename already splits on both
    expect(path.basename("C:\\Users\\jensj\\catalogue\\ABC.mp3")).toBe("C:\\Users\\jensj\\catalogue\\ABC.mp3");
  });
});

describe("findInIndex — a Windows path resolves to this machine's file by name", () => {
  const lib = path.join(TMP, "lib-index");
  fs.mkdirSync(path.join(lib, "genre"), { recursive: true });
  fs.writeFileSync(path.join(lib, "ABC.mp3"), "x");
  fs.writeFileSync(path.join(lib, "genre", "Heads Will Roll - A-Trak Remix.wav"), "x");
  const index = buildIndex(lib);

  it("exact basename, case-insensitive", () => {
    expect(findInIndex(index, "C:\\Users\\jensj\\AppData\\Local\\Ether\\catalogue\\abc.MP3"))
      .toBe(path.join(lib, "ABC.mp3"));
  });
  it("in a subfolder", () => {
    expect(findInIndex(index, "C:\\Users\\jensj\\Music\\ether music library\\Heads Will Roll - A-Trak Remix.wav"))
      .toBe(path.join(lib, "genre", "Heads Will Roll - A-Trak Remix.wav"));
  });
  it("a file that is not here stays unresolved", () => {
    expect(findInIndex(index, "C:\\Users\\jensj\\AppData\\Local\\Ether\\catalogue\\Not Here.mp3")).toBe(null);
  });
});

describe("Re-sync re-points Windows-path rows to this machine's files by name", () => {
  const lib = path.join(TMP, "lib-resync");
  fs.mkdirSync(lib, { recursive: true });
  for (const f of ["ABC.mp3", "Legal ID.wav", "Pool Sweep.mp3"]) fs.writeFileSync(path.join(lib, f), "x");

  const WIN = "C:\\Users\\jensj\\AppData\\Local\\Ether\\catalogue\\";
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT, file_key TEXT, category_id INTEGER,
                        content_class TEXT, rotation_status TEXT, deleted_at TEXT, updated_at TEXT);
    CREATE TABLE clock_slots (id INTEGER PRIMARY KEY, station_id INTEGER, slot_type TEXT, category_id INTEGER, deleted_at TEXT);
    CREATE TABLE generated_schedule (id INTEGER PRIMARY KEY, station_id INTEGER, song_id INTEGER, title TEXT,
                                     file_path TEXT, deleted_at TEXT);
    CREATE TABLE announcements (id INTEGER PRIMARY KEY, station_id INTEGER, title TEXT, file_path TEXT, deleted_at TEXT);
    CREATE TABLE library_asset (id INTEGER PRIMARY KEY, name TEXT, file_path TEXT, deleted_at TEXT);
    INSERT INTO clock_slots (station_id, slot_type, category_id) VALUES (1, 'music', 7);
  `);
  const ins = db.prepare("INSERT INTO songs (id, title, file_path, category_id, content_class) VALUES (?, ?, ?, ?, ?)");
  ins.run(1, "ABC", WIN + "ABC.mp3", 7, "MUSIC");
  ins.run(2, "Gone", WIN + "Gone.mp3", 7, "MUSIC");
  ins.run(3, "Pool Sweep", WIN + "Pool Sweep.mp3", null, "SWP");
  db.prepare("INSERT INTO generated_schedule (station_id, song_id, title, file_path) VALUES (1, 1, 'ABC', ?)").run(WIN + "ABC.mp3");
  db.prepare("INSERT INTO announcements (id, station_id, title, file_path) VALUES (1, 1, 'Legal', ?)").run(WIN + "Legal ID.wav");
  db.prepare("INSERT INTO library_asset (id, name, file_path) VALUES (1, 'sweep', ?)").run(WIN + "Pool Sweep.mp3");

  const result = matchStation(db, 1, lib);
  const applied = applyRelink(db, 1, result, {});
  const pathOf = (t, id) => db.prepare(`SELECT file_path FROM ${t} WHERE id = ?`).get(id).file_path;

  it("matches the songs whose file is here, by name", () => {
    expect(result.matches.map(m => m.songId).sort()).toEqual([1, 3]);
    expect(result.missing.map(m => m.songId)).toEqual([2]);
  });
  it("writes this machine's path to songs and the schedule", () => {
    expect(pathOf("songs", 1)).toBe(path.join(lib, "ABC.mp3"));
    expect(pathOf("songs", 3)).toBe(path.join(lib, "Pool Sweep.mp3"));
    expect(db.prepare("SELECT file_path FROM generated_schedule WHERE song_id = 1").get().file_path).toBe(path.join(lib, "ABC.mp3"));
  });
  it("re-points the other audio tables too", () => {
    expect(pathOf("announcements", 1)).toBe(path.join(lib, "Legal ID.wav"));
    expect(pathOf("library_asset", 1)).toBe(path.join(lib, "Pool Sweep.mp3"));
    expect(applied.relinkedAssets).toBe(2);
  });
  it("leaves a row whose file is genuinely absent on its old path", () => {
    expect(pathOf("songs", 2)).toBe(WIN + "Gone.mp3");
  });
});
