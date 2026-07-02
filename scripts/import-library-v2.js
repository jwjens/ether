'use strict';
// Ether v2 genesis importer (spec §7 step 2 + §6 file store).
//
// Scans ONLY the four source folders, SHA-256s each audio file (content_hash = identity, D1),
// dedups by hash (identical bytes in two folders → one row; source_folder keeps the first),
// extracts tags via music-metadata (the app's existing tagging path), and REPORTS.
//
//   --dry-run            scan + hash + dedup + metadata + report ONLY (no writes). Review-gate mode.
//   --music <dir>        override music dir (default: <USERPROFILE>\Music\ether music library)
//   --db <path>          target SQLite (must already have songs_v2 + local_files); write mode
//   --store <dir>        content store dir; files copied to <store>/<hash>.<ext>
//   --limit <N>          only process the first N audio files (for scratch proofs)
//   --json <path>        write the full deduped record list + report as JSON
//
// Write mode (copy-to-store + songs_v2/local_files upsert) is Phase 2 (post review-gate go), and
// must run with the Ether app CLOSED (never write the live openair.db while the engine is open),
// or against a scratch --db. This turn only exercises --dry-run (real library) + a scratch write proof.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.aif', '.aiff', '.wma']);
const FOLDERS = ['Daytime', 'Halloween', 'Christmas', 'CS - Coffee Shop'];

function defaultMusicDir() {
  const home = process.env.USERPROFILE || require('os').homedir();
  return path.join(home, 'Music', 'ether music library');
}

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && AUDIO_EXTS.has(path.extname(ent.name).toLowerCase())) out.push(p);
  }
  return out;
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// Scan → hash → dedup → metadata. Returns { records (unique), dupGroups, unreadable, scanned, perFolder }.
async function scanLibrary({ musicDir = defaultMusicDir(), folders = FOLDERS, limit = 0 } = {}) {
  const mm = await import('music-metadata');
  const files = [];
  const perFolder = {};
  for (const f of folders) {
    const dir = path.join(musicDir, f);
    if (!fs.existsSync(dir)) { perFolder[f] = 0; continue; }
    const found = walk(dir, []);
    perFolder[f] = found.length;
    for (const p of found) files.push({ abs_path: p, source_folder: f });
  }
  const scanned = files.length;
  const toProcess = limit > 0 ? files.slice(0, limit) : files;

  const byHash = new Map();      // content_hash -> record (first wins)
  const dupGroups = new Map();   // content_hash -> [ {source_folder, original_name} ... ] when >1
  const unreadable = [];

  for (const f of toProcess) {
    let content_hash, size_bytes;
    try {
      content_hash = sha256File(f.abs_path);
      size_bytes = fs.statSync(f.abs_path).size;
    } catch (e) { unreadable.push({ file: f.abs_path, reason: 'read/hash: ' + e.message }); continue; }

    const original_name = path.basename(f.abs_path);
    const ext = path.extname(f.abs_path).slice(1).toLowerCase();

    if (byHash.has(content_hash)) {
      const g = dupGroups.get(content_hash) || [{ source_folder: byHash.get(content_hash).source_folder, original_name: byHash.get(content_hash).original_name }];
      g.push({ source_folder: f.source_folder, original_name });
      dupGroups.set(content_hash, g);
      continue; // first occurrence already recorded; source_folder keeps the first
    }

    let title = null, artist = null, album = null, duration_ms = null;
    try {
      const meta = await mm.parseFile(f.abs_path, { duration: true });
      const c = meta.common || {};
      title = c.title || null;
      artist = c.artist || (Array.isArray(c.artists) ? c.artists[0] : null) || null;
      album = c.album || null;
      if (meta.format && typeof meta.format.duration === 'number') duration_ms = Math.round(meta.format.duration * 1000);
    } catch (e) {
      unreadable.push({ file: f.abs_path, reason: 'tags: ' + e.message, hashed: true });
      // still keep the row — identity is the hash, tags are display metadata (fill title from filename)
    }
    if (!title) title = original_name.replace(/\.[^.]+$/, '');

    byHash.set(content_hash, {
      content_hash, title, artist, album, duration_ms, ext,
      size_bytes, source_folder: f.source_folder, original_name, abs_path: f.abs_path,
    });
  }

  return { records: [...byHash.values()], dupGroups, unreadable, scanned, processed: toProcess.length, perFolder };
}

// Phase 2 (post review-gate): copy uniques into the store and upsert songs_v2 + local_files.
function importToStoreAndDb(records, { dbPath, store }) {
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  fs.mkdirSync(store, { recursive: true });
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const upSong = db.prepare(`INSERT INTO songs_v2
      (content_hash,title,artist,album,duration_ms,ext,size_bytes,source_folder,original_name,created_at,updated_at)
      VALUES (@content_hash,@title,@artist,@album,@duration_ms,@ext,@size_bytes,@source_folder,@original_name,@now,@now)
    ON CONFLICT(content_hash) DO UPDATE SET
      title=excluded.title, artist=excluded.artist, album=excluded.album, duration_ms=excluded.duration_ms,
      ext=excluded.ext, size_bytes=excluded.size_bytes, source_folder=excluded.source_folder,
      original_name=excluded.original_name, updated_at=excluded.updated_at`);
  const upLocal = db.prepare(`INSERT INTO local_files (content_hash, local_path, verified_at)
      VALUES (@content_hash,@local_path,@now)
    ON CONFLICT(content_hash) DO UPDATE SET local_path=excluded.local_path, verified_at=excluded.verified_at`);
  let copied = 0, songRows = 0, localRows = 0;
  const tx = db.transaction((recs) => {
    for (const r of recs) {
      const dest = path.join(store, `${r.content_hash}.${r.ext}`);
      if (!fs.existsSync(dest)) { fs.copyFileSync(r.abs_path, dest); copied++; }
      upSong.run({ ...r, now });
      upLocal.run({ content_hash: r.content_hash, local_path: dest, now });
    }
  });
  tx(records);
  songRows = db.prepare('SELECT COUNT(*) c FROM songs_v2').get().c;
  localRows = db.prepare('SELECT COUNT(*) c FROM local_files').get().c;
  db.close();
  return { copied, songRows, localRows };
}

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
function flag(name) { return process.argv.includes(name); }

async function main() {
  const musicDir = arg('--music', defaultMusicDir());
  const limit = parseInt(arg('--limit', '0'), 10) || 0;
  const dryRun = flag('--dry-run');
  console.log('=== Ether v2 importer ===');
  console.log('music dir:', musicDir, dryRun ? '(DRY RUN — no writes)' : '');
  if (limit) console.log('limit:', limit);

  const t0 = Date.now();
  const { records, dupGroups, unreadable, scanned, processed, perFolder } = await scanLibrary({ musicDir, limit });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const collapsed = [...dupGroups.values()].reduce((n, g) => n + (g.length - 1), 0);
  console.log('\n--- REVIEW GATE REPORT ---');
  console.log('per-folder audio files:', JSON.stringify(perFolder));
  console.log('files scanned:        ', scanned);
  if (limit) console.log('files processed:      ', processed);
  console.log('unique content hashes:', records.length);
  console.log('duplicate groups:     ', dupGroups.size, `(collapsed ${collapsed} extra copies)`);
  console.log('unreadable/tagless:   ', unreadable.length);
  console.log('elapsed:              ', secs + 's');

  if (dupGroups.size) {
    console.log('\n-- duplicate groups (byte-identical across/within folders) --');
    let i = 0;
    for (const [hash, g] of dupGroups) { console.log(`  ${hash.slice(0, 12)}… : ${g.map(x => x.source_folder + '/' + x.original_name).join('  ==  ')}`); if (++i >= 25) { console.log(`  …and ${dupGroups.size - 25} more`); break; } }
  }
  if (unreadable.length) {
    console.log('\n-- unreadable / tagless (kept by hash, title from filename if tags failed) --');
    for (const u of unreadable.slice(0, 25)) console.log(`  ${u.reason} :: ${u.file}`);
    if (unreadable.length > 25) console.log(`  …and ${unreadable.length - 25} more`);
  }

  console.log('\n-- deduped list sample (first 15) --');
  for (const r of records.slice(0, 15))
    console.log(`  [${r.source_folder}] "${r.title}"${r.artist ? ' — ' + r.artist : ''}${r.duration_ms ? ' (' + Math.round(r.duration_ms / 1000) + 's)' : ''}  ${r.content_hash.slice(0, 10)}…`);

  const jsonOut = arg('--json', '');
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({
      generated_at: new Date().toISOString(), musicDir, perFolder, scanned, processed,
      unique: records.length, duplicateGroups: dupGroups.size, collapsed, unreadable,
      records: records.map(({ abs_path, ...r }) => r),
    }, null, 2));
    console.log('\nfull report + deduped list written to:', jsonOut);
  }

  if (!dryRun) {
    const dbPath = arg('--db', ''); const store = arg('--store', '');
    if (!dbPath || !store) { console.error('\nWRITE MODE needs --db and --store. Refusing to guess. (Use --dry-run for the report.)'); process.exit(2); }
    console.log('\n--- WRITE MODE: copy to store + upsert songs_v2/local_files ---');
    console.log('db:', dbPath, '| store:', store);
    const { copied, songRows, localRows } = importToStoreAndDb(records, { dbPath, store });
    console.log(`copied ${copied} new files into store; songs_v2 rows=${songRows}, local_files rows=${localRows}`);
  }

  console.log('\n=== STOP at review gate. No publish, no R2, no live-DB writes. ===');
}

module.exports = { scanLibrary, importToStoreAndDb, FOLDERS, AUDIO_EXTS, defaultMusicDir };
if (require.main === module) main().catch(e => { console.error('IMPORTER ERROR:', e.stack || e.message); process.exit(1); });
