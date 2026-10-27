// scripts/smoke-catalogue-moves.js — "songs are only ever in the catalogue", and nothing moves without the Yes
// (electron/catalogue-moves.js; Jeff, 2026-10-27). On a database and folders built here in a temp folder, never a real one:
//   npm run test:catalogue-moves
// 1. Finding is read-only and lists every file not in the catalogue: stored elsewhere, or not on this computer.
// 2. The Yes moves each file in (or downloads it), and points its rows — and the planned log rows — there, local-only.
// 3. Nothing else in Ether downloads, moves or repoints on its own: the play-time download, the 45 s prefetch and the
//    renderer's cloud fetches are gone, and only the pop-up's Yes reaches the move.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const Database = require("better-sqlite3");
const { findNotInCatalogue, moveIntoCatalogue } = require("../electron/catalogue-moves");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "cat-moves-"));
  const CAT = path.join(T, "catalogue"), OUT = path.join(T, "Downloads");
  fs.mkdirSync(CAT); fs.mkdirSync(OUT);
  fs.writeFileSync(path.join(CAT, "In.mp3"), "in");
  fs.writeFileSync(path.join(OUT, "Outside.mp3"), "outside-bytes");
  fs.writeFileSync(path.join(OUT, "Clash.mp3"), "short");
  fs.writeFileSync(path.join(CAT, "Clash.mp3"), "a different, longer file");
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT, file_key TEXT, deleted_at TEXT);
    CREATE TABLE cart_slots (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT, deleted_at TEXT);
    CREATE TABLE generated_schedule (id INTEGER PRIMARY KEY, song_id INTEGER, file_path TEXT, state TEXT, deleted_at TEXT);
    CREATE TABLE mutations (id INTEGER PRIMARY KEY, table_name TEXT);`);
  const ins = db.prepare("INSERT INTO songs (id, title, file_path, file_key) VALUES (?, ?, ?, ?)");
  ins.run(1, "In", path.join(CAT, "In.mp3"), null);
  ins.run(2, "Outside", path.join(OUT, "Outside.mp3"), null);
  ins.run(3, "Cloud", "C:\\Users\\projector\\Music\\Cloud.mp3", "Cloud.mp3");
  ins.run(4, "Gone", "C:\\Users\\projector\\Music\\Gone.mp3", null);
  ins.run(5, "Clash", path.join(OUT, "Clash.mp3"), null);
  ins.run(6, "Never here", null, "Never Here.mp3");
  db.prepare("INSERT INTO cart_slots (id, title, file_path) VALUES (1, 'Cart', ?)").run(path.join(OUT, "Outside.mp3"));
  db.prepare("INSERT INTO generated_schedule (id, song_id, file_path, state) VALUES (1, 2, ?, 'pending'), (2, 2, ?, 'aired')")
    .run(path.join(OUT, "Outside.mp3"), path.join(OUT, "Outside.mp3"));
  const snap = () => JSON.stringify([db.prepare("SELECT * FROM songs").all(), db.prepare("SELECT * FROM cart_slots").all(), db.prepare("SELECT * FROM generated_schedule").all()]);

  console.log("\n── 1. finding is read-only, and lists what is not in the catalogue ──");
  const before = snap();
  const found = findNotInCatalogue(db, CAT);
  const byName = Object.fromEntries(found.files.map(f => [f.name, f]));
  ok(snap() === before && fs.existsSync(path.join(OUT, "Outside.mp3")), "finding changed nothing (database or files)");
  ok(!byName["In.mp3"], "a file in the catalogue is not listed");
  ok(byName["Outside.mp3"]?.state === "elsewhere" && byName["Outside.mp3"].rows.length === 2, "a file stored elsewhere is listed once, with both rows that use it (song + cart)");
  ok(byName["Cloud.mp3"]?.state === "missing" && byName["Cloud.mp3"].fileKey === "Cloud.mp3", "a file not on this computer with a cloud copy is listed as missing, downloadable");
  ok(byName["Gone.mp3"]?.state === "missing" && !byName["Gone.mp3"].fileKey, "a file not on this computer with no cloud copy is listed too");
  ok(byName["Never Here.mp3"]?.state === "missing", "a song with only a cloud copy (no location) is listed");
  ok(found.files.length === 5, `5 files listed (got ${found.files.length})`);

  console.log("\n── 2. the Yes ──");
  const downloads = [];
  const res = await moveIntoCatalogue(db, CAT, found.files, {
    download: async (fileKey, name) => { downloads.push([fileKey, name]); const p = path.join(CAT, name); fs.writeFileSync(p, "dl"); return { ok: true, filePath: p }; },
  });
  const R = Object.fromEntries(res.results.map(r => [r.name, r]));
  const song = (id) => db.prepare("SELECT file_path FROM songs WHERE id = ?").get(id).file_path;
  ok(R["Outside.mp3"].ok && R["Outside.mp3"].action === "moved" && fs.existsSync(path.join(CAT, "Outside.mp3")) && !fs.existsSync(path.join(OUT, "Outside.mp3")),
     "an outside file is MOVED into the catalogue (no copy left behind)");
  ok(song(2) === path.join(CAT, "Outside.mp3") && db.prepare("SELECT file_path FROM cart_slots WHERE id=1").get().file_path === path.join(CAT, "Outside.mp3"),
     "every row that used it now points at the catalogue file");
  ok(db.prepare("SELECT file_path FROM generated_schedule WHERE id=1").get().file_path === path.join(CAT, "Outside.mp3"), "the planned log row follows");
  ok(db.prepare("SELECT file_path FROM generated_schedule WHERE id=2").get().file_path === path.join(OUT, "Outside.mp3"), "the aired log row is the record of what aired — untouched");
  ok(downloads.some(d => d[0] === "Cloud.mp3" && d[1] === "Cloud.mp3") && song(3) === path.join(CAT, "Cloud.mp3"), "a file not here is downloaded into the catalogue under its own name, and the song points there");
  ok(song(6) === path.join(CAT, "Never Here.mp3"), "the song that had only a cloud copy now points at its download");
  ok(!R["Gone.mp3"].ok && /no cloud copy/.test(R["Gone.mp3"].reason) && song(4) === "C:\\Users\\projector\\Music\\Gone.mp3", "no cloud copy: reported, and the row is left exactly as it was");
  ok(!R["Clash.mp3"].ok && fs.readFileSync(path.join(CAT, "Clash.mp3"), "utf8") === "a different, longer file" && fs.existsSync(path.join(OUT, "Clash.mp3")) && song(5) === path.join(OUT, "Clash.mp3"),
     "a DIFFERENT file with the same name in the catalogue is never replaced; nothing moves and the row is unchanged");
  ok(song(1) === path.join(CAT, "In.mp3"), "the song already in the catalogue is untouched");
  ok(db.prepare("SELECT COUNT(*) n FROM mutations").get().n === 0, "nothing journalled for a peer (local-only)");
  ok(res.moved === 1 && res.downloaded === 2 && res.failed === 2, `counts: 1 moved, 2 downloaded, 2 not moved (got ${res.moved}/${res.downloaded}/${res.failed})`);
  ok(findNotInCatalogue(db, CAT).files.map(f => f.name).sort().join() === "Clash.mp3,Gone.mp3", "afterwards only the two it could not move are still listed");

  console.log("\n── 3. nothing else downloads, moves or repoints on its own ──");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const main = read("electron/main.js");
  const resolver = main.slice(main.indexOf("async function resolveLocalAudioPath"), main.indexOf("// ── NOT IN THE CATALOGUE → THE POP-UP"));
  ok(resolver.length > 0 && !/fetchR2Track|UPDATE /.test(resolver), "playback's resolver neither downloads nor repoints");
  ok(!/_pointRowsAtDownload|onMaterialized/.test(main), "the download-then-repoint path and its prefetch hook are gone from main");
  const lh = read("electron/library-health.js");
  ok(!/prefetchTick|fetchToPath|download-url/.test(lh), "the library-health sweep has no prefetch (no download on a timer)");
  ok(!/r2:fetch-track/.test(read("src/audio/loggen.ts")) && !/r2:fetch-track/.test(read("src/App.tsx")), "the renderer's queue fill and remote load fetch nothing from the cloud");
  const moveCalls = main.match(/moveIntoCatalogue\(/g) || [];
  // (The second call is the Preferences switch, section 4 — off unless the user turns it on.)
  ok(moveCalls.length === 2 && /ipcMain\.handle\('catalogue:move-in'/.test(main), "main moves files only from the pop-up's Yes (catalogue:move-in) and the Preferences switch");
  const prompt = read("src/components/CatalogueMovePrompt.tsx");
  ok((prompt.match(/"catalogue:move-in"/g) || []).length === 1 && /const yes = async/.test(prompt), "the renderer calls catalogue:move-in only from the pop-up's Yes");

  console.log("\n── 4. \"Download missing files into the catalogue automatically\" (Preferences, 2026-10-27) ──");
  const M = require("../electron/catalogue-moves");
  db.exec("CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
  ok(M.autoDownloadOn(db) === false, "never set: OFF (files go to the pop-up)");
  ok(M.setAutoDownload(db, true) === true && db.prepare("SELECT value FROM system_state WHERE key = ?").get(M.AUTO_DOWNLOAD_KEY).value === "on", "switched on: stored in system_state (this computer's, never synced)");
  ok(db.prepare("SELECT COUNT(*) n FROM mutations").get().n === 0, "the switch journals nothing for a peer");
  const sample = [{ key: "a", state: "missing", fileKey: "A.mp3" }, { key: "b", state: "missing", fileKey: null }, { key: "c", state: "elsewhere", fileKey: "C.mp3" }];
  const on = M.splitByAutoDownload(sample, true), off = M.splitByAutoDownload(sample, false);
  ok(on.auto.map(f => f.key).join() === "a" && on.ask.map(f => f.key).join() === "b,c", "on: only a file not on this computer WITH a cloud copy downloads by itself; no-cloud-copy and stored-elsewhere still go to the pop-up");
  ok(off.auto.length === 0 && off.ask.length === 3, "off: everything goes to the pop-up");
  ok(M.setAutoDownload(db, false) === false, "switched off again");
  const autoFn = main.slice(main.indexOf("async function _autoDownloadMissing"), main.indexOf("ipcMain.handle('catalogue:auto-download:get'"));
  ok(/if \(_autoDlRunning \|\| !M\.autoDownloadOn\(db\)\) return;/.test(autoFn) && /M\.splitByAutoDownload\(snap\?\.notInCatalogue\?\.files, true\)/.test(autoFn) && /M\.moveIntoCatalogue\(/.test(autoFn),
     "main downloads by itself only while the switch is on, only the files that rule picks, through the same move as the Yes");
  ok((main.match(/if \(ch === "library-health"\) _autoDownloadMissing\(data\)/g) || []).length === 2, "every sweep (worker, or the in-main fallback) feeds it");
  ok((main.match(/moveIntoCatalogue\(/g) || []).length === 2, "main moves files in exactly two places: the pop-up's Yes and the switch");

  // The automatic path end to end, on this database: a missing file with a cloud copy is downloaded and pointed at; the
  // file stored elsewhere and the one with no cloud copy are left for the pop-up.
  db.prepare("INSERT INTO songs (id, title, file_path, file_key) VALUES (7, 'Auto', 'C:\\\\Users\\\\projector\\\\Music\\\\Auto.mp3', 'Auto.mp3')").run();
  fs.writeFileSync(path.join(OUT, "Elsewhere2.mp3"), "e2");
  db.prepare("INSERT INTO songs (id, title, file_path, file_key) VALUES (8, 'Elsewhere2', ?, 'Elsewhere2.mp3')").run(path.join(OUT, "Elsewhere2.mp3"));
  M.setAutoDownload(db, true);
  const split = M.splitByAutoDownload(findNotInCatalogue(db, CAT).files, M.autoDownloadOn(db));
  await moveIntoCatalogue(db, CAT, split.auto, { download: async (k, name) => { const p = path.join(CAT, name); fs.writeFileSync(p, "dl"); return { ok: true, filePath: p }; } });
  ok(song(7) === path.join(CAT, "Auto.mp3"), "on: the missing file was downloaded into the catalogue and the song points there");
  ok(song(8) === path.join(OUT, "Elsewhere2.mp3") && fs.existsSync(path.join(OUT, "Elsewhere2.mp3")), "on: the file stored elsewhere was NOT moved — it waits for the pop-up");
  ok(split.ask.some(f => f.name === "Elsewhere2.mp3") && split.ask.some(f => f.name === "Gone.mp3"), "and the pop-up still lists it, and the one with no cloud copy");

  db.close();
  fs.rmSync(T, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
