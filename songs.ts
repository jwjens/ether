// src/db/songs.ts
// All SQL queries for the song library.

import { query, queryOne, execute } from './client';
import type { Song, SongView, Artist, Album, Category, NewRecord, UpdateRecord } from '../types/models';

// ============================================================
// SONGS
// ============================================================

const SONG_VIEW_SELECT = `
  SELECT
    s.*,
    a.name       AS artist_name,
    a.sort_name  AS artist_sort_name,
    al.title     AS album_title,
    c.code        AS category_code,
    c.name        AS category_name,
    c.color       AS category_color
  FROM songs s
  LEFT JOIN artists a  ON a.id = s.artist_id
  LEFT JOIN albums al  ON al.id = s.album_id
  LEFT JOIN categories c ON c.id = s.category_id
`;

export async function getSongs(filters: {
  search?: string;
  category_id?: number;
  rotation_status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<SongView[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.search) {
    conditions.push(`(s.title LIKE ? OR a.name LIKE ? OR al.title LIKE ?)`);
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }
  if (filters.category_id !== undefined) {
    conditions.push(`s.category_id = ?`);
    params.push(filters.category_id);
  }
  if (filters.rotation_status) {
    conditions.push(`s.rotation_status = ?`);
    params.push(filters.rotation_status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 500;
  const offset = filters.offset ?? 0;

  const rows = await query<SongView>(
    `${SONG_VIEW_SELECT} ${where} ORDER BY a.sort_name, s.title LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return rows.map(parseSongView);
}

export async function getSongById(id: number): Promise<SongView | null> {
  const row = await queryOne<SongView>(
    `${SONG_VIEW_SELECT} WHERE s.id = ?`, [id]
  );
  return row ? parseSongView(row) : null;
}

export async function getSongsByCategory(categoryId: number): Promise<SongView[]> {
  const rows = await query<SongView>(
    `${SONG_VIEW_SELECT} WHERE s.category_id = ? AND s.rotation_status != 'inactive' ORDER BY s.last_played_at ASC NULLS FIRST`,
    [categoryId]
  );
  return rows.map(parseSongView);
}

export async function insertSong(song: Omit<NewRecord<Song>, 'updated_at'>): Promise<number> {
  const result = await execute(`
    INSERT INTO songs (
      title, artist_id, album_id, file_path, file_format, file_size_bytes,
      duration_ms, intro_ms, outro_ms, genre, era, is_explicit, is_instrumental,
      category_id, rotation_status, no_repeat_hours, no_artist_hours, daypart_mask,
      gender, tags, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    song.title, song.artist_id ?? null, song.album_id ?? null,
    song.file_path ?? null, song.file_format ?? null, song.file_size_bytes ?? null,
    song.duration_ms, song.intro_ms ?? 0, song.outro_ms ?? 0,
    song.genre ?? null, song.era ?? null,
    song.is_explicit ? 1 : 0, song.is_instrumental ? 1 : 0,
    song.category_id ?? null, song.rotation_status ?? 'active',
    song.no_repeat_hours ?? 2, song.no_artist_hours ?? 1,
    song.daypart_mask ?? 16777215, song.gender ?? 'unknown',
    JSON.stringify(song.tags ?? []), song.notes ?? null,
  ]);
  return result.lastInsertId;
}

export async function updateSong(song: UpdateRecord<Song>): Promise<void> {
  const { id, ...fields } = song;
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = Object.values(fields);
  await execute(
    `UPDATE songs SET ${sets}, updated_at = unixepoch() WHERE id = ?`,
    [...values, id]
  );
}

export async function deleteSong(id: number): Promise<void> {
  await execute('DELETE FROM songs WHERE id = ?', [id]);
}

export async function markSongPlayed(songId: number, hour: number): Promise<void> {
  await execute(`
    UPDATE songs SET
      last_played_at   = unixepoch(),
      last_played_hour = ?,
      spins_total      = spins_total + 1,
      spins_this_week  = spins_this_week + 1,
      updated_at       = unixepoch()
    WHERE id = ?
  `, [hour, songId]);
}

export async function getSongCount(): Promise<number> {
  const row = await queryOne<{ count: number }>('SELECT COUNT(*) as count FROM songs');
  return row?.count ?? 0;
}

// ============================================================
// ARTISTS
// ============================================================

export async function getOrCreateArtist(name: string): Promise<number> {
  const existing = await queryOne<Artist>(
    'SELECT * FROM artists WHERE name = ?', [name]
  );
  if (existing) return existing.id;

  // Generate sort_name: move "The ", "A ", "An " to end
  const sortName = name.replace(/^(The|A|An)\s+/i, (_, article) => {
    return name.slice(article.length + 1) + `, ${article}`;
  });

  const result = await execute(
    'INSERT INTO artists (name, sort_name) VALUES (?, ?)',
    [name, sortName !== name ? sortName : null]
  );
  return result.lastInsertId;
}

export async function getArtists(): Promise<Artist[]> {
  return query<Artist>('SELECT * FROM artists ORDER BY COALESCE(sort_name, name)');
}

// ============================================================
// ALBUMS
// ============================================================

export async function getOrCreateAlbum(title: string, artistId: number | null, year?: number): Promise<number> {
  const existing = await queryOne<Album>(
    'SELECT * FROM albums WHERE title = ? AND (artist_id = ? OR artist_id IS NULL)',
    [title, artistId]
  );
  if (existing) return existing.id;

  const result = await execute(
    'INSERT INTO albums (title, artist_id, year) VALUES (?, ?, ?)',
    [title, artistId, year ?? null]
  );
  return result.lastInsertId;
}

// ============================================================
// CATEGORIES
// ============================================================

export async function getCategories(): Promise<Category[]> {
  return query<Category>('SELECT * FROM categories ORDER BY code');
}

export async function getCategoryById(id: number): Promise<Category | null> {
  return queryOne<Category>('SELECT * FROM categories WHERE id = ?', [id]);
}

export async function createCategory(cat: NewRecord<Category>): Promise<number> {
  const result = await execute(
    'INSERT INTO categories (code, name, color, description, target_spins_per_week) VALUES (?, ?, ?, ?, ?)',
    [cat.code, cat.name, cat.color ?? null, cat.description ?? null, cat.target_spins_per_week ?? null]
  );
  return result.lastInsertId;
}

// ============================================================
// BATCH IMPORT (used by library scanner)
// ============================================================

export interface ImportSongPayload {
  file_path: string;
  file_format: string;
  file_size_bytes: number;
  title: string;
  artist?: string;
  album?: string;
  album_artist?: string;
  year?: number;
  genre?: string;
  duration_ms: number;
  category_id?: number;
}

export async function batchImportSongs(payloads: ImportSongPayload[]): Promise<{
  inserted: number;
  skipped: number;
  errors: string[];
}> {
  let inserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const p of payloads) {
    try {
      // Skip if file already in library
      const existing = await queryOne<{ id: number }>(
        'SELECT id FROM songs WHERE file_path = ?', [p.file_path]
      );
      if (existing) { skipped++; continue; }

      const artistName = p.artist ?? 'Unknown Artist';
      const artistId = await getOrCreateArtist(artistName);

      let albumId: number | null = null;
      if (p.album) {
        albumId = await getOrCreateAlbum(p.album, artistId, p.year);
      }

      // Derive era from year
      let era: string | null = null;
      if (p.year) {
        const decade = Math.floor(p.year / 10) * 10;
        era = `${decade}s`;
      }

      await insertSong({
        title: p.title,
        artist_id: artistId,
        album_id: albumId,
        file_path: p.file_path,
        file_format: p.file_format,
        file_size_bytes: p.file_size_bytes,
        duration_ms: p.duration_ms,
        intro_ms: 0,
        outro_ms: 0,
        genre: p.genre ?? null,
        era,
        is_explicit: false,
        is_instrumental: false,
        category_id: p.category_id ?? null,
        rotation_status: 'active',
        no_repeat_hours: 2,
        no_artist_hours: 1,
        daypart_mask: 16777215,
        gender: 'unknown',
        tags: [],
      });
      inserted++;
    } catch (err) {
      errors.push(`${p.file_path}: ${String(err)}`);
    }
  }

  return { inserted, skipped, errors };
}

// ============================================================
// HELPERS
// ============================================================

function parseSongView(row: SongView): SongView {
  return {
    ...row,
    is_explicit: Boolean(row.is_explicit),
    is_instrumental: Boolean(row.is_instrumental),
    tags: typeof row.tags === 'string'
      ? (() => { try { return JSON.parse(row.tags as unknown as string); } catch { return []; } })()
      : row.tags ?? [],
  };
}
