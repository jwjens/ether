'use strict';
// electron/sync/library-client.js — Ether v2 client bootstrap + tail (spec §4).
//
// On sign-in: pull GET /library/snapshot into songs_v2 (install-scoped library), store the
// snapshot version, and populate local_files from the content store. Then tail
// GET /library/changes?since_version=N on the sync cadence, applying upserts/deletes by
// content_hash. A 410 Gone (offline past the GC horizon) triggers a full re-bootstrap.
//
// Metadata read-path ONLY (D2). Playback resolution by hash is §6 (resolveByHash); nothing here
// reads songs_v2 into the UI yet (that's the separate read-cutover). Station-scoped data continues
// over the existing mutation stream unchanged.

const fs = require('fs');
const path = require('path');

const VERSION_KEY = 'library_snapshot_version';

async function doFetch(url, opts) {
  const f = global.fetch || (await import('node-fetch')).default;
  return f(url, opts);
}

function getStoredVersion(db) {
  try {
    const r = db.prepare("SELECT value FROM system_state WHERE key = ?").get(VERSION_KEY);
    return r ? parseInt(r.value, 10) || 0 : null;   // null = never bootstrapped
  } catch { return null; }
}
function setStoredVersion(db, v) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(VERSION_KEY, String(v), now);
}

const SONG_KEYS = ['content_hash', 'title', 'artist', 'album', 'duration_ms', 'ext', 'size_bytes', 'source_folder', 'original_name'];
function normalize(s) { const o = {}; for (const k of SONG_KEYS) o[k] = s[k] ?? null; return o; }

function upsertSongsStmt(db) {
  return db.prepare(`INSERT INTO songs_v2
      (content_hash,title,artist,album,duration_ms,ext,size_bytes,source_folder,original_name,created_at,updated_at)
      VALUES (@content_hash,@title,@artist,@album,@duration_ms,@ext,@size_bytes,@source_folder,@original_name,@now,@now)
    ON CONFLICT(content_hash) DO UPDATE SET
      title=excluded.title, artist=excluded.artist, album=excluded.album, duration_ms=excluded.duration_ms,
      ext=excluded.ext, size_bytes=excluded.size_bytes, source_folder=excluded.source_folder,
      original_name=excluded.original_name, updated_at=excluded.updated_at`);
}

// Rebuild local_files from the content store (<musicDir>/store/<hash>.<ext>). Machine-local, never synced.
function populateLocalFiles(db, musicDir) {
  const store = path.join(musicDir, 'store');
  if (!fs.existsSync(store)) return 0;
  const now = new Date().toISOString();
  const up = db.prepare(`INSERT INTO local_files (content_hash, local_path, verified_at) VALUES (?, ?, ?)
                         ON CONFLICT(content_hash) DO UPDATE SET local_path=excluded.local_path, verified_at=excluded.verified_at`);
  let n = 0;
  const tx = db.transaction((files) => {
    for (const f of files) {
      const m = f.match(/^([0-9a-f]{64})\.[A-Za-z0-9]+$/);
      if (!m) continue;
      if (!db.prepare('SELECT 1 FROM songs_v2 WHERE content_hash = ?').get(m[1])) continue; // only for known songs
      up.run(m[1], path.join(store, f), now); n++;
    }
  });
  tx(fs.readdirSync(store));
  return n;
}

// Full bootstrap: snapshot → songs_v2, store version, rebuild local_files.
async function bootstrapLibrary(db, { backendUrl, licenseKey, musicDir }) {
  if (!licenseKey) return { ok: false, reason: 'no_license' };
  const res = await doFetch(`${backendUrl}/library/snapshot`, { headers: { 'x-license-key': licenseKey } });
  if (!res.ok) return { ok: false, reason: `snapshot ${res.status}` };
  const snap = await res.json();
  const now = new Date().toISOString();
  const up = upsertSongsStmt(db);
  const tx = db.transaction((songs) => { for (const s of songs) up.run({ ...normalize(s), now }); });
  tx(snap.songs || []);
  setStoredVersion(db, snap.version || 0);
  const local = populateLocalFiles(db, musicDir);
  const count = db.prepare('SELECT COUNT(*) c FROM songs_v2').get().c;
  console.log(`[library-bootstrap] snapshot v${snap.version}: songs_v2=${count} (pulled ${snap.songs ? snap.songs.length : 0}), local_files=${local}`);
  return { ok: true, version: snap.version, count, local };
}

// Incremental tail: apply upserts + deletes since the stored version.
async function tailChanges(db, { backendUrl, licenseKey, musicDir }) {
  if (!licenseKey) return { ok: false, reason: 'no_license' };
  const since = getStoredVersion(db);
  if (since == null) return bootstrapLibrary(db, { backendUrl, licenseKey, musicDir }); // never bootstrapped
  const res = await doFetch(`${backendUrl}/library/changes?since_version=${since}`, { headers: { 'x-license-key': licenseKey } });
  if (res.status === 410) { setStoredVersion(db, 0); return bootstrapLibrary(db, { backendUrl, licenseKey, musicDir }); }
  if (!res.ok) return { ok: false, reason: `changes ${res.status}` };
  const ch = await res.json();
  const ups = ch.upserts || [], dels = ch.deletes || [];
  if (!ups.length && !dels.length && (ch.version || 0) <= since) return { ok: true, upserts: 0, deletes: 0, version: since };
  const now = new Date().toISOString();
  const up = upsertSongsStmt(db);
  const delSong = db.prepare('DELETE FROM songs_v2 WHERE content_hash = ?');
  const delLocal = db.prepare('DELETE FROM local_files WHERE content_hash = ?');
  const tx = db.transaction(() => {
    for (const s of ups) up.run({ ...normalize(s), now });
    for (const d of dels) { delLocal.run(d.content_hash); delSong.run(d.content_hash); }
    setStoredVersion(db, ch.version || since);
  });
  tx();
  if (ups.length || dels.length) console.log(`[library-tail] v${since}→${ch.version}: +${ups.length} upserts, -${dels.length} deletes`);
  return { ok: true, upserts: ups.length, deletes: dels.length, version: ch.version };
}

module.exports = { bootstrapLibrary, tailChanges, getStoredVersion, VERSION_KEY };
