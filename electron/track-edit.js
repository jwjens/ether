'use strict';
// electron/track-edit.js — the Library's title/artist/album/year/genre/BPM edit (discogs:updateTrack).
//
// THE BUG IT REPLACES (486b861, 2026-05-10): the handler built `patch.artist_id = artistId` and `patch.album_id = albumId`
// whenever `artistId !== undefined`, which is always true (it was `?? null`). So every edit wrote BOTH: an inline edit of
// album, year, genre or BPM set artist_id to NULL, and an artist edit set album_id to NULL (proven on a copy: song 544,
// docs/library-category-and-rename-2026-10-23.md).
//
// THE RULE: a field the call does not carry is left exactly as it is. A field it carries as an empty string is cleared —
// that is the only way to clear one, and it is explicit. Year is stored on the album (songs has no year), so a year with
// no album in the call sets the year of the song's own album and never touches the link.
//
// Pure apart from `deps`, so it is tested without a database (electron/track-edit.test.js).

const present = (fields, k) => fields[k] !== undefined;

/**
 * @param db      better-sqlite3 handle, passed through to deps
 * @param fields  { id, title?, artist?, album?, year?, genre?, bpm? }
 * @param deps    { getSong(db,id), artistsFindOrCreateByName(db,name), albumsFindOrCreate(db,{title,artistId,year}),
 *                  setAlbumYear(db, albumId, year), songsUpdateById(db,id,patch) }
 * @returns { ok: true, patch } or { ok: false, error }
 */
function applyTrackEdit(db, fields, deps) {
  const f = fields || {};
  const song = deps.getSong(db, f.id);
  if (!song) return { ok: false, error: `song ${f.id} not found` };

  const patch = {};
  if (present(f, 'title')) patch.title = f.title;

  let artistId = song.artist_id ?? null;
  if (present(f, 'artist')) {
    const name = String(f.artist ?? '').trim();
    artistId = name ? (deps.artistsFindOrCreateByName(db, name)?.id ?? null) : null;
    patch.artist_id = artistId;
  }

  if (present(f, 'album')) {
    const title = String(f.album ?? '').trim();
    patch.album_id = title
      ? (deps.albumsFindOrCreate(db, { title, artistId, year: present(f, 'year') ? f.year : null })?.id ?? null)
      : null;
  } else if (present(f, 'year')) {
    if (song.album_id == null) return { ok: false, error: 'The year is stored on the album, and this song has no album yet — set the album first.' };
    deps.setAlbumYear(db, song.album_id, f.year);
  }

  if (present(f, 'genre')) patch.genre = f.genre;
  if (present(f, 'bpm'))   patch.bpm   = f.bpm;

  if (Object.keys(patch).length) deps.songsUpdateById(db, f.id, patch);
  return { ok: true, patch };
}

module.exports = { applyTrackEdit };
