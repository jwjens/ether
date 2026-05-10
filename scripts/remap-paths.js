/**
 * scripts/remap-paths.js
 * One-time path remap: fix songs.file_path after files were reorganized into subdirectories.
 * Run via: node_modules/.bin/electron.cmd scripts/remap-paths.js
 */

const path    = require("path");
const os      = require("os");
const fs      = require("fs");
const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

// ── Step 1: walk Music dir, build filename → [fullPath, ...] map ─────────────

function walk(dir, map) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { console.warn(`  [WARN] Cannot read dir: ${dir} — ${e.message}`); return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, map);
    } else if (/\.(mp3|flac|wav|m4a|ogg|aac)$/i.test(e.name)) {
      const key = e.name.toLowerCase();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(full.replace(/\\/g, "/"));
    }
  }
}

const musicDir = path.join(os.homedir(), "Music");
console.log(`=== remap-paths: walking ${musicDir} ===\n`);
const diskMap = new Map(); // filename.toLowerCase() → [fullPath, ...]
walk(musicDir, diskMap);
console.log(`Disk files indexed: ${[...diskMap.values()].reduce((n, a) => n + a.length, 0)}`);
console.log(`Unique filenames:   ${diskMap.size}\n`);

// ── Step 2: load all songs ────────────────────────────────────────────────────

const songs = db.prepare("SELECT id, file_path FROM songs WHERE file_path IS NOT NULL ORDER BY id").all();
console.log(`Songs in DB: ${songs.length}\n`);

// ── Step 3: classify each song ───────────────────────────────────────────────

const toUpdate   = [];  // { id, oldPath, newPath }
const correct    = [];  // id — path already points to existing file
const missing    = [];  // id — filename not found anywhere on disk
const ambiguous  = [];  // { id, filePath, matches } — multiple disk hits

for (const song of songs) {
  const dbPath   = song.file_path.replace(/\\/g, "/");
  const filename = path.basename(song.file_path).toLowerCase();
  const matches  = diskMap.get(filename);

  if (!matches || matches.length === 0) {
    missing.push(song);
    continue;
  }

  if (matches.length > 1) {
    // Check if current DB path is among the matches — if so, it's correct
    const normDb = dbPath;
    const exactMatch = matches.find(m => m === normDb);
    if (exactMatch) {
      correct.push(song);
    } else {
      ambiguous.push({ id: song.id, filePath: song.file_path, matches });
    }
    continue;
  }

  // Exactly one disk match
  const diskPath = matches[0];
  if (diskPath === dbPath) {
    correct.push(song);
  } else {
    toUpdate.push({ id: song.id, oldPath: song.file_path, newPath: diskPath });
  }
}

// ── Step 4: preview ───────────────────────────────────────────────────────────

console.log("=== Preview ===");
console.log(`  Will update:        ${toUpdate.length}`);
console.log(`  Already correct:    ${correct.length}`);
console.log(`  Missing on disk:    ${missing.length}`);
console.log(`  Ambiguous (skip):   ${ambiguous.length}`);
console.log("");

if (ambiguous.length > 0) {
  console.log("=== Ambiguous (multiple disk matches — skipped) ===");
  for (const a of ambiguous) {
    console.log(`  id=${a.id}  DB: ${a.filePath}`);
    for (const m of a.matches) console.log(`    DISK: ${m}`);
  }
  console.log("");
}

if (missing.length > 0) {
  console.log("=== Missing on disk (untouched) ===");
  for (const s of missing) console.log(`  id=${s.id}  ${s.file_path}`);
  console.log("");
}

// ── Step 5: apply updates in one transaction ──────────────────────────────────

if (toUpdate.length === 0) {
  console.log("Nothing to update. Done.");
  db.close();
  process.exit(0);
}

console.log("=== Applying updates ===");
const stmt = db.prepare("UPDATE songs SET file_path = ? WHERE id = ?");

db.transaction(() => {
  for (const u of toUpdate) {
    stmt.run(u.newPath, u.id);
    console.log(`  [UPDATE] id=${u.id}`);
    console.log(`    OLD: ${u.oldPath}`);
    console.log(`    NEW: ${u.newPath}`);
  }
})();

// ── Step 6: final report ──────────────────────────────────────────────────────

console.log(`
=== Final report ===
  Total scanned:    ${songs.length}
  Updated:          ${toUpdate.length}
  Already correct:  ${correct.length}
  Missing on disk:  ${missing.length}
  Ambiguous/skip:   ${ambiguous.length}
`);

db.close();
process.exit(0);
