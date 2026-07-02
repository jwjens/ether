'use strict';
// electron/audio-resolver.js — Ether v2 content resolution by hash (spec §6).
//
// resolveByHash(db, content_hash, opts) resolves a song's bytes to a local file path:
//   1. local_files hit AND the file exists → return that path (source: 'local')
//   2. file already sitting in the content store (local_files stale/missing) → repair + return ('store')
//   3. R2 GET <hash>.<ext> → write into the content store, upsert local_files → return ('r2')
//   4. miss → { ok:false, reason:'not local, not in R2' }
//
// This replaces resolveLocalAudioPath (basename/file_key era). Identity is the content hash (D1);
// ext comes from songs_v2. The R2 fetch is INJECTED (r2GetToFile) so production passes the
// backend-signed flow (fetchR2Track) and tests pass a direct S3 client. The resolver itself is
// license-agnostic — it hands r2GetToFile the bare "<hash>.<ext>"; the injected fn applies the
// license prefix / grant resolution.

const fs = require('fs');
const path = require('path');

function upsertLocal(db, contentHash, dest) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO local_files (content_hash, local_path, verified_at) VALUES (?,?,?)
              ON CONFLICT(content_hash) DO UPDATE SET local_path=excluded.local_path, verified_at=excluded.verified_at`)
    .run(contentHash, dest, now);
}

// r2GetToFile(key, destPath) → Promise<boolean> : download R2 object `key` (bare "<hash>.<ext>") to
// destPath, returning true on success. store = <musicDir>/store.
async function resolveByHash(db, contentHash, { store, r2GetToFile }) {
  if (!contentHash) return { ok: false, reason: 'no content_hash' };

  // 1) local_files hit + file present
  try {
    const lf = db.prepare('SELECT local_path FROM local_files WHERE content_hash = ?').get(contentHash);
    if (lf && lf.local_path && fs.existsSync(lf.local_path)) return { ok: true, source: 'local', path: lf.local_path };
  } catch { /* local_files may not exist in odd states — fall through */ }

  // ext is authoritative from the song identity row
  const song = db.prepare('SELECT ext FROM songs_v2 WHERE content_hash = ?').get(contentHash);
  if (!song || !song.ext) return { ok: false, reason: 'unknown content_hash (not in songs_v2)' };
  const dest = path.join(store, `${contentHash}.${song.ext}`);

  // 2) already in the store but local_files was stale/missing → repair the pointer
  if (fs.existsSync(dest)) { upsertLocal(db, contentHash, dest); return { ok: true, source: 'store', path: dest }; }

  // 3) R2 → store → local_files
  try { fs.mkdirSync(store, { recursive: true }); } catch {}
  let got = false;
  try { got = await r2GetToFile(`${contentHash}.${song.ext}`, dest); } catch { got = false; }
  if (got && fs.existsSync(dest)) { upsertLocal(db, contentHash, dest); return { ok: true, source: 'r2', path: dest }; }

  // 4) miss — clean up a partial download if any
  try { if (fs.existsSync(dest) && fs.statSync(dest).size === 0) fs.rmSync(dest); } catch {}
  return { ok: false, reason: 'not local, not in R2' };
}

module.exports = { resolveByHash };
