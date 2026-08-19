'use strict';
// scripts/repair-song-metadata.js — re-link songs to their artists/albums/genre from the FILE TAGS.
//
// THE DEFECT (measured 2026-08-19 on jensj):
//   artists.id range      : 327-652  (326 rows)
//   songs.artist_id range : 1-326    (475 songs)
//   songs.artist_id -> artists.id :  RESOLVES 0   ORPHANED 475   NULL 68
//
// Every artist row was re-created with a fresh AUTOINCREMENT id and songs.artist_id was never
// re-pointed. The ranges are exactly adjacent and exactly the same size — 326 artists that used to
// be 1-326 now sit at 327-652. Nothing resolves. The library HAS the artists; the join has lost them.
//
// Consequences beyond a blank name: artist reads "—" everywhere, catalogue artwork lookups degrade to
// TITLE-ONLY searches (a guess: "All I Wanna Do" is Sheryl Crow, Jewel and a dozen others), and any
// report or rotation rule that groups by artist is grouping by nothing.
//
// THE REPAIR: the audio files are the source of truth. For every song with a readable file, read the
// tag, find-or-create the artist/album by NAME (station-scoped), and re-point the song. Genre is
// filled in where the tag has one and the row does not.
//
// SAFE BY DEFAULT — dry run unless --apply is passed. Prints exactly what it would change.
//
//   node scripts/repair-song-metadata.js                 # dry run, changes nothing
//   node scripts/repair-song-metadata.js --apply         # writes
//
// ⚠ ETHER MUST BE FULLY CLOSED (app AND daemon) before --apply. Writing the live openair.db from an
// outside process while Ether holds it open in WAL mode risks corruption — the standing rule.
// Take a copy first; the script prints the path it would back up to.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > 0 ? Number(process.argv[i + 1]) || 0 : 0; })();

function defaultDbPath() {
  const explicit = process.argv.find(a => a.endsWith('.db'));
  if (explicit) return explicit;
  const local = process.env.LOCALAPPDATA || '';
  // The active profile, the same path the app resolves.
  const profiles = path.join(local, 'Ether', 'profiles');
  try {
    const dirs = fs.readdirSync(profiles).filter(d => !d.includes('retired') && !d.startsWith('_'));
    for (const d of dirs) {
      const p = path.join(profiles, d, 'openair.db');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* fall through */ }
  return path.join(local, 'Ether', 'openair.db');
}

(async () => {
  const dbPath = defaultDbPath();
  console.log(`[repair] database : ${dbPath}`);
  console.log(`[repair] mode     : ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);
  if (!fs.existsSync(dbPath)) { console.error('[repair] database not found'); process.exit(1); }

  if (APPLY) {
    const backup = `${dbPath}.bak-premetadata-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(dbPath, backup);
      console.log(`[repair] backup   : ${backup}`);
    } else {
      console.log(`[repair] backup   : ${backup} (already exists, kept)`);
    }
  }

  const db = new Database(dbPath, { readonly: !APPLY });

  // BEFORE
  const before = {
    resolves: db.prepare(`SELECT COUNT(*) c FROM songs s WHERE s.artist_id IS NOT NULL
                            AND EXISTS (SELECT 1 FROM artists a WHERE a.id = s.artist_id)`).get().c,
    orphaned: db.prepare(`SELECT COUNT(*) c FROM songs s WHERE s.artist_id IS NOT NULL
                            AND NOT EXISTS (SELECT 1 FROM artists a WHERE a.id = s.artist_id)`).get().c,
    nulls:    db.prepare('SELECT COUNT(*) c FROM songs WHERE artist_id IS NULL').get().c,
  };
  console.log(`[repair] before   : resolves ${before.resolves}  orphaned ${before.orphaned}  null ${before.nulls}`);

  // `songs` has NO station_id — the library is install-scoped and shared across stations (CLAUDE.md).
  // `artists` IS station-scoped, so a song's artist is resolved within the station that owns the
  // artist rows; on this install every artist row is station 1.
  let rows = db.prepare(`SELECT id, title, artist_id, album_id, genre, file_path
                           FROM songs WHERE file_path IS NOT NULL AND file_path != ''`).all();
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`[repair] songs with a file: ${rows.length}\n`);

  const mm = await import('music-metadata');

  // Name -> id, per station. Artists are station-scoped (artists.station_id), so a name is only the
  // same artist WITHIN a station; two stations legitimately keep their own rows.
  const artistKey = (sid, name) => `${sid}::${String(name).trim().toLowerCase()}`;
  const artistCache = new Map();
  // Which station's artist rows to link into. Songs are install-scoped, so this follows wherever the
  // artist rows actually live rather than guessing per song.
  const ARTIST_STATION = (db.prepare('SELECT station_id, COUNT(*) c FROM artists GROUP BY station_id ORDER BY c DESC').get() || {}).station_id ?? 1;
  for (const a of db.prepare('SELECT id, name, station_id FROM artists').all()) {
    artistCache.set(artistKey(a.station_id ?? 1, a.name), a.id);
  }

  // Albums: title is NOT NULL, station_id is NOT NULL, and the row carries artist_id + uuid.
  // Keyed by (station, title, artist) — the same album title by two artists is two albums.
  const albumKey = (sid, title, aid) => `${sid}::${String(title).trim().toLowerCase()}::${aid ?? ''}`;
  const albumCache = new Map();
  for (const al of db.prepare('SELECT id, title, artist_id, station_id FROM albums').all()) {
    albumCache.set(albumKey(al.station_id ?? 1, al.title, al.artist_id), al.id);
  }

  const insArtist = APPLY ? db.prepare(
    `INSERT INTO artists (name, station_id, uuid, created_at) VALUES (?, ?, ?, unixepoch())`) : null;
  const insAlbum = APPLY ? db.prepare(
    `INSERT INTO albums (title, artist_id, year, station_id, uuid, created_at) VALUES (?, ?, ?, ?, ?, unixepoch())`) : null;
  const updAlbum = APPLY ? db.prepare('UPDATE songs SET album_id = ? WHERE id = ?') : null;
  const updSong = APPLY ? db.prepare('UPDATE songs SET artist_id = ? WHERE id = ?') : null;
  const updGenre = APPLY ? db.prepare('UPDATE songs SET genre = ? WHERE id = ?') : null;

  const stats = { relinked: 0, created: 0, alreadyOk: 0, noTag: 0, unreadable: 0, missing: 0,
                  genre: 0, albumLinked: 0, albumCreated: 0, noAlbumTag: 0 };
  const samples = [];

  const work = () => {
    for (const s of rows) {
      if (!fs.existsSync(s.file_path)) { stats.missing++; continue; }
      let tag;
      try { tag = (await0(s)); } catch { stats.unreadable++; continue; }
      if (!tag) { stats.unreadable++; continue; }

      const name = (tag.artist || tag.albumartist || '').trim();
      if (!name) { stats.noTag++; continue; }

      const sid = ARTIST_STATION;   // artists are station-scoped; songs are not
      const key = artistKey(sid, name);
      let aid = artistCache.get(key);
      if (aid == null) {
        stats.created++;
        if (APPLY) {
          const info = insArtist.run(name, sid, require('crypto').randomUUID());
          aid = Number(info.lastInsertRowid);
          artistCache.set(key, aid);
        } else {
          aid = -1;   // dry run placeholder
        }
      }

      if (s.artist_id === aid) { stats.alreadyOk++; }
      else {
        stats.relinked++;
        if (samples.length < 10) samples.push(`${(s.title || '').slice(0, 40)}  artist_id ${s.artist_id} -> ${aid === -1 ? '(new)' : aid}  "${name}"`);
        if (APPLY) updSong.run(aid, s.id);
      }

      // ── ALBUM ────────────────────────────────────────────────────────────────────────────────
      // albums had ONE row and ZERO songs linked to it — the same breakage as artists, one table over.
      const albumTitle = (tag.album || '').trim();
      if (!albumTitle) { stats.noAlbumTag++; }
      else {
        const realAid = aid === -1 ? null : aid;
        const akey = albumKey(sid, albumTitle, realAid);
        let alid = albumCache.get(akey);
        if (alid == null) {
          stats.albumCreated++;
          if (APPLY) {
            const yr = Number(tag.year) || null;
            const info = insAlbum.run(albumTitle, realAid, yr, sid, require('crypto').randomUUID());
            alid = Number(info.lastInsertRowid);
            albumCache.set(akey, alid);
          } else { alid = -1; }
        }
        if (s.album_id !== alid) {
          stats.albumLinked++;
          if (APPLY) updAlbum.run(alid, s.id);
        }
      }

      const g = (tag.genre && tag.genre[0] || '').trim();
      if (g && !(s.genre && String(s.genre).trim())) {
        stats.genre++;
        if (APPLY) updGenre.run(g, s.id);
      }
    }
  };

  // music-metadata is async; pre-read every tag first so the write below can run in one transaction.
  const tags = new Map();
  let done = 0;
  for (const s of rows) {
    if (!fs.existsSync(s.file_path)) continue;
    try {
      const m = await mm.parseFile(s.file_path, { duration: false });
      tags.set(s.id, m.common || {});
    } catch { /* counted as unreadable below */ }
    if (++done % 100 === 0) console.log(`[repair] read tags ${done}/${rows.length}`);
  }
  function await0(s) { return tags.get(s.id); }

  if (APPLY) db.transaction(work)();
  else work();

  console.log('\n[repair] result');
  console.log(`  artist re-linked      : ${stats.relinked}`);
  console.log(`  artists created       : ${stats.created}`);
  console.log(`  already correct       : ${stats.alreadyOk}`);
  console.log(`  file has no artist tag: ${stats.noTag}`);
  console.log(`  unreadable tags       : ${stats.unreadable}`);
  console.log(`  file missing on disk  : ${stats.missing}`);
  console.log(`  album linked          : ${stats.albumLinked}`);
  console.log(`  albums created        : ${stats.albumCreated}`);
  console.log(`  file has no album tag : ${stats.noAlbumTag}`);
  console.log(`  genre filled in       : ${stats.genre}`);
  if (samples.length) { console.log('\n  examples:'); samples.forEach(x => console.log('   ', x)); }

  if (APPLY) {
    const after = {
      resolves: db.prepare(`SELECT COUNT(*) c FROM songs s WHERE s.artist_id IS NOT NULL
                              AND EXISTS (SELECT 1 FROM artists a WHERE a.id = s.artist_id)`).get().c,
      orphaned: db.prepare(`SELECT COUNT(*) c FROM songs s WHERE s.artist_id IS NOT NULL
                              AND NOT EXISTS (SELECT 1 FROM artists a WHERE a.id = s.artist_id)`).get().c,
    };
    console.log(`\n[repair] after    : resolves ${after.resolves}  orphaned ${after.orphaned}`);
    if (after.orphaned > 0) console.log('[repair] NOTE: remaining orphans are songs whose file is missing or carries no artist tag.');
  } else {
    console.log('\n[repair] DRY RUN — nothing was written. Re-run with --apply (Ether fully closed) to commit.');
  }

  db.close();
})();
