// Where a row's audio plays from, with nothing decided by Ether (electron/catalogue.js; Jeff, 2026-10-26: "The catalogue is
// the default, not a lock … What item 5 removes is Ether deciding on its own: no automatic path guessing, no title
// matching, no silent fallback to another folder."). Real files in a temp folder.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
const C = require("./catalogue");
const { buildIndex, findInIndex } = require("./audio-library-index");
const LF = require("./library-folders");

let root, cat, chosen;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-"));
  cat = path.join(root, "catalogue"); chosen = path.join(root, "my music");
  fs.mkdirSync(cat); fs.mkdirSync(chosen);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const put = (dir, name, bytes = "x") => { const p = path.join(dir, name); fs.writeFileSync(p, bytes); return p; };

describe("a row plays the location it stores, and nothing Ether picks", () => {
  it("the catalogue (the default) plays", () => {
    const p = put(cat, "Thriller.mp3");
    expect(C.playableFile(p)).toBe(p);
  });
  it("a file the user chose outside the catalogue plays from there (Change File Location stays fully available)", () => {
    const p = put(chosen, "Thriller (live).mp3");
    expect(C.playableFile(p)).toBe(p);
  });
  it("a stored location that is not there is MISSING — never answered by the same name in the catalogue", () => {
    put(cat, "Thriller.mp3");
    const stored = path.join(root, "gone", "Thriller.mp3");
    expect(C.playableFile(stored)).toBeNull();
    // the control: the old resolver tier answered it with the catalogue file (the silent fallback to another folder)
    expect(findInIndex(buildIndex(cat), stored)).toBe(path.join(cat, "Thriller.mp3"));
  });
  it("and never by a tolerant or case-blind name", () => {
    put(cat, "thriller.mp3");
    expect(C.playableFile(path.join(cat, "Thriller.mp3"))).toBeNull();                       // a different-case file is another file
    put(cat, "Thriller_spotdown.org.mp3");
    expect(C.playableFile(path.join(root, "gone", "Thriller.MP3"))).toBeNull();
  });
});

describe("downloads go into the catalogue, under the row's own name", () => {
  it("the row's file name exactly — not rewritten (it used to become \"Summer_Of__69.mp3\")", () => {
    const t = C.downloadTarget(cat, "C:\\elsewhere\\Summer Of '69.mp3", "Summer Of '69.mp3");
    expect(t).toEqual({ path: path.join(cat, "Summer Of '69.mp3"), name: "Summer Of '69.mp3", present: false });
  });
  it("a row with no path yet takes its cloud file's name; a different-case file already there gets the case-alt name", () => {
    expect(C.downloadTarget(cat, null, "ABC.mp3").name).toBe("ABC.mp3");
    put(cat, "abc.mp3");
    expect(C.downloadTarget(cat, null, "ABC.mp3").name).toMatch(/^ABC~c[0-9a-f]{8}\.mp3$/);
  });
  it("no catalogue folder → no target (nothing is substituted)", () => {
    expect(C.downloadTarget(null, "x.mp3", "x.mp3")).toBeNull();
  });
});

describe("Re-sync: the row's own location, else the SAME name in the folder — no title match", () => {
  const fakeDb = (rows) => ({ prepare: (sql) => ({
    all: () => (/FROM clock_slots/.test(sql) ? [] : /FROM generated_schedule/.test(sql) ? rows : /PRAGMA/.test(sql) ? [] : []),
    get: () => undefined,
  }) });
  it("keeps a chosen location, relinks a lost one by its exact name, and never by title", () => {
    const mine = put(chosen, "Arabian Nights (my edit).mp3");
    put(cat, "Moved.mp3");
    put(cat, "Arabian Nights - Bruce Adler.mp3");
    const r = LF.matchStation(fakeDb([
      { songId: 1, title: "Mine", filePath: mine },
      { songId: 2, title: "Moved", filePath: path.join(root, "old", "Moved.mp3") },
      { songId: 3, title: "Arabian Nights", filePath: path.join(root, "old", "Arabian Nights.mp3") },
    ]), 2, cat);
    expect(r.matches).toEqual([
      { songId: 1, title: "Mine", file: mine },
      { songId: 2, title: "Moved", file: path.join(cat, "Moved.mp3") },
    ]);
    expect(r.missing).toEqual([{ songId: 3, title: "Arabian Nights" }]);   // the title matcher used to link it to Bruce Adler
  });
  it("there is no second folder: the old per-station 'music_dir' row is not read", () => {
    const db = { prepare: () => ({ get: () => ({ value: "D:\\old station folder" }) }) };
    expect(LF.getFolder(db, 2, { getMachineMusicDir: () => null })).toBeNull();
    expect(LF.getFolder(db, 2, { getMachineMusicDir: () => cat })).toBe(cat);
  });
});

describe("every place that opens a file uses this, and none falls back", () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
  const main = read("electron", "main.js");
  const slice = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));
  // (2026-10-27, electron/catalogue-moves.js) Nothing downloads on its own: a file not here is listed in the pop-up, and only
  // its Yes fetches it.
  it("main's resolver: the stored file and nothing else — no download, no index, no case-blind match", () => {
    const r = slice("async function resolveLocalAudioPath", "\n}\n");
    expect(r).toMatch(/Cat\.playableFile\(filePath\)/);
    expect(r).not.toMatch(/fetchR2Track|downloadTarget|_pointRowsAtDownload/);
    expect(r).not.toMatch(/findInIndex|buildIndex|caseShadowed/);
  });
  it("audio:load and the jukebox refuse an unresolved row instead of loading its stored path anyway", () => {
    const load = slice('ipcMain.handle("audio:load"', "\n});");
    expect(load).toMatch(/if \(!resolved\.ok\) \{ logStartup\(.*\); return false; \}/);
    expect(load).not.toMatch(/resolved\.ok \? resolved\.filePath : filePath/);
    const jb = slice('ipcMain.handle("jukebox:play"', "\n});");
    expect(jb).toMatch(/reason: "not-in-catalogue"/);
    expect(jb).not.toMatch(/soft-fall/);
  });
  it("announcements play their own file through the same resolver", () => {
    const f = slice("async function fireAnnouncement", "\n}\n");
    expect(f).toMatch(/await resolveLocalAudioPath\(row\.file_path\)/);
    expect(f).toMatch(/filePath: _annFile/);
  });
  it("a download keeps the row's name (no rewrite to underscores), and no download repoints rows on its own", () => {
    const f = slice("async function fetchR2Track", "\n}\n");
    expect(f).not.toMatch(/replace\(\/\[\^a-zA-Z0-9\._-\]\/g/);
    expect(main).not.toMatch(/_pointRowsAtDownload/);
  });
  it("Change File Location is untouched: any file the user picks is stored as picked", () => {
    const h = slice("ipcMain.handle('audio-library:repoint'", "\n});");
    expect(h).toMatch(/_audioMigrate\.repointOne\(db, table, id, filePath\)/);
    expect(h).not.toMatch(/importIntoLibrary/);
  });
  it("the audio engine and the library-health sense use the same rule", () => {
    const eng = read("audiod", "engine.js");
    const r = eng.slice(eng.indexOf("  _resolveLocal(fp) {"), eng.indexOf("\n  }\n", eng.indexOf("  _resolveLocal(fp) {")));
    expect(r).toMatch(/require\('\.\.\/electron\/catalogue'\)\.playableFile\(fp\)/);
    expect(r).not.toMatch(/findInIndex|_libIndex/);
    expect(eng).not.toMatch(/ether music library/);                                          // no default folder of its own
    const lh = read("electron", "library-health.js");
    expect(lh).toMatch(/if \(require\('\.\/catalogue'\)\.playableFile\(fp\)\) return \{ cls: 'resolves', foreign \};/);
    expect(lh).not.toMatch(/findInIndex\(/);
  });
});
