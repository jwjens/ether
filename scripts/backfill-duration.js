/**
 * One-time backfill: populate duration_ms for songs where it is NULL or 0.
 * Run via: node_modules/.bin/electron.cmd scripts/backfill-duration.js
 *
 * Strategy per song:
 *   1. native getFileDuration() (Rust/symphonia) — works for VBR MP3 and most formats
 *   2. TLEN ID3v2 frame (milliseconds, stored by some taggers)
 *   3. Skip — log warning
 */

const path    = require("path");
const os      = require("os");
const fs      = require("fs");
const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

// ── helpers ──────────────────────────────────────────────────────────────────

function readFileSafe(p) {
  try { return fs.readFileSync(p); }
  catch { return null; }
}

/** Parse TLEN frame from ID3v2 header — returns milliseconds or null. */
function parseTLEN(buf) {
  if (!buf || buf.length < 10) return null;
  const header = buf.slice(0, 3).toString("ascii");
  if (header !== "ID3") return null;
  const version = buf[3];
  const size = (buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f);
  let pos = 10;
  const end = Math.min(10 + size, buf.length);
  while (pos + 10 < end) {
    const frameId = buf.slice(pos, pos + 4).toString("ascii");
    if (frameId[0] === "\0") break;
    const frameSize = version >= 4
      ? ((buf[pos+4] & 0x7f) << 21 | (buf[pos+5] & 0x7f) << 14 | (buf[pos+6] & 0x7f) << 7 | (buf[pos+7] & 0x7f))
      : (buf[pos+4] << 24 | buf[pos+5] << 16 | buf[pos+6] << 8 | buf[pos+7]);
    if (frameSize <= 0 || frameSize > end - pos - 10) break;
    if (frameId === "TLEN") {
      const text = buf.slice(pos + 11, pos + 10 + frameSize).toString("utf8").replace(/\0/g, "").trim();
      const ms = parseInt(text, 10);
      if (!isNaN(ms) && ms > 0) return ms;
    }
    pos += 10 + frameSize;
  }
  return null;
}

// ── native getFileDuration via Electron IPC ───────────────────────────────────
// In Electron main-process context we can require the native module directly.
let nativeGetDuration = null;
try {
  // Try to load the Rust addon that the main process uses
  const addonPath = path.join(__dirname, "../src-tauri/target/release/ether_native.node");
  if (fs.existsSync(addonPath)) {
    const native = require(addonPath);
    nativeGetDuration = native.getFileDuration;
  }
} catch {}

// ── main ─────────────────────────────────────────────────────────────────────

const songs = db.prepare(`
  SELECT id, file_path FROM songs
  WHERE duration_ms IS NULL OR duration_ms = 0
  ORDER BY id
`).all();

console.log(`=== backfill-duration: ${songs.length} songs to process ===\n`);

const update = db.prepare("UPDATE songs SET duration_ms = ? WHERE id = ?");

let updated = 0, skipped = 0, missing = 0;

for (const song of songs) {
  const fp = song.file_path;

  if (!fs.existsSync(fp)) {
    console.log(`  [MISS] ${fp}`);
    missing++;
    continue;
  }

  // Strategy 1: native
  let durationMs = 0;
  if (nativeGetDuration) {
    try {
      const sec = nativeGetDuration(fp);
      if (sec > 0) durationMs = Math.round(sec * 1000);
    } catch {}
  }

  // Strategy 2: TLEN frame
  if (durationMs === 0) {
    const buf = readFileSafe(fp);
    if (buf) {
      const tlen = parseTLEN(buf);
      if (tlen) durationMs = tlen;
    }
  }

  if (durationMs > 0) {
    update.run(durationMs, song.id);
    console.log(`  [OK]   id=${song.id} ${Math.round(durationMs/1000)}s  ${path.basename(fp)}`);
    updated++;
  } else {
    console.log(`  [SKIP] id=${song.id} — no duration source  ${path.basename(fp)}`);
    skipped++;
  }
}

console.log(`\n=== done: ${updated} updated, ${skipped} skipped, ${missing} missing ===`);
db.close();
process.exit(0);
