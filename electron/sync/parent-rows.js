'use strict';
// electron/sync/parent-rows.js — A REFERENCE WHOSE ROW IS NOT HERE (2026-10-19).
//
// A reference travels as its parent's uuid. Usually the parent is already on the receiving machine and the uuid finds
// it. When it is not, writing the sender's integer would name the wrong row — so the sender also sends a small label of
// the parent, and the receiver does one of two things, never a guess:
//
//   ARTISTS, ALBUMS → created here with the SAME uuid (Jeff: "Missing artists are created on arrival"). When the
//                     artist's own row arrives later it lands on this one (same uuid). Never matched by name: two
//                     different artists can share a name ("Kids Bop" ×2 on OVEVENTS).
//   NAMED ROWS      → categories, jingle/spot categories, clocks, shows: the row with the SAME NAME in the SAME
//                     STATION, only when exactly one matches. Stations each seeded their own "Sponsors" spot category,
//                     so the same category has a different uuid on each machine — the name in its station is what they
//                     share. No match, or more than one → nothing is written.
//
// Created rows are written directly and journalled nowhere: the sender's own mutation for that row is the truth and
// arrives (or arrived) by its own path; this only stops a song from arriving without its artist.
// docs/sync-uuid-references-2026-10-19.md

const { REGISTRY } = require('./synced-tables');

const PARENTS = {
  artists:           { create: true,  cols: ['name', 'sort_name', 'gender'] },
  albums:            { create: true,  cols: ['title', 'year'] },
  categories:        { matchBy: 'name', cols: ['name', 'code'] },
  jingle_categories: { matchBy: 'name', cols: ['name'] },
  spot_categories:   { matchBy: 'name', cols: ['name'] },
  clocks:            { matchBy: 'name', cols: ['name'] },
  shows:             { matchBy: 'name', cols: ['name'] },
};

const physical = (t) => (REGISTRY[t] && REGISTRY[t].tableName) || t;
const _stmts = new WeakMap();
function stmt(db, sql) {
  let m = _stmts.get(db);
  if (!m) { m = new Map(); _stmts.set(db, m); }
  if (!m.has(sql)) m.set(sql, db.prepare(sql));
  return m.get(sql);
}

/** The label a sender attaches for a parent row (by local id): its uuid, the PARENTS columns, and its station's uuid. */
function labelOf(db, table, localId) {
  const p = PARENTS[table];
  if (!p || localId == null) return null;
  try {
    const hasStation = !!(REGISTRY[table] && REGISTRY[table].columns && REGISTRY[table].columns.station_id);
    const cols = ['uuid', ...p.cols, ...(hasStation ? ['station_id'] : [])];
    const r = stmt(db, `SELECT ${cols.join(', ')} FROM ${physical(table)} WHERE id = ?`).get(localId);
    if (!r || !r.uuid) return null;
    const label = {};
    for (const c of ['uuid', ...p.cols]) label[c] = r[c] ?? null;
    if (hasStation && r.station_id != null) {
      const s = stmt(db, 'SELECT uuid FROM stations WHERE id = ?').get(r.station_id);
      if (s && s.uuid) label.station_uuid = s.uuid;
    }
    if (table === 'albums') {
      const a = stmt(db, 'SELECT a.uuid FROM albums al JOIN artists a ON a.id = al.artist_id WHERE al.id = ?').get(localId);
      if (a && a.uuid) label.artist_uuid = a.uuid;
    }
    return label;
  } catch { return null; }
}

/**
 * Stand up or recognise a missing parent on THIS machine. Returns { id, how: 'created' | 'matched' } or null.
 * `uuid` is the parent's uuid; `label` is what labelOf produced on the sender (may be null → nothing to go on).
 */
function materializeParent(db, table, uuid, label) {
  const p = PARENTS[table];
  if (!p || !uuid || !label) return null;
  try {
    const existing = stmt(db, `SELECT id FROM ${physical(table)} WHERE uuid = ?`).get(uuid);
    if (existing) return { id: existing.id, how: 'matched' };
    if (p.create) {
      const name = table === 'albums' ? label.title : label.name;
      if (!name) return null;
      const now = new Date().toISOString();
      if (table === 'artists') {
        const r = db.prepare('INSERT INTO artists (name, sort_name, gender, uuid, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(label.name, label.sort_name ?? null, label.gender ?? 'unknown', uuid, now);
        return { id: Number(r.lastInsertRowid), how: 'created' };
      }
      // albums: its own artist by uuid when that artist is here; otherwise none (never another machine's number)
      let artistId = null;
      if (label.artist_uuid) artistId = stmt(db, 'SELECT id FROM artists WHERE uuid = ?').get(label.artist_uuid)?.id ?? null;
      const r = db.prepare('INSERT INTO albums (title, artist_id, year, uuid, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(label.title, artistId, label.year ?? null, uuid, now);
      return { id: Number(r.lastInsertRowid), how: 'created' };
    }
    // Named rows: the one with this name in this station, when exactly one.
    if (!label[p.matchBy] || !label.station_uuid) return null;
    const st = stmt(db, 'SELECT id FROM stations WHERE uuid = ?').get(label.station_uuid);
    if (!st) return null;
    const rows = stmt(db, `SELECT id FROM ${physical(table)} WHERE station_id = ? AND ${p.matchBy} = ? AND deleted_at IS NULL`)
      .all(st.id, label[p.matchBy]);
    return rows.length === 1 ? { id: rows[0].id, how: 'matched' } : null;
  } catch (e) {
    console.warn(`[parent-rows] could not stand up ${table} ${uuid}: ${e.message}`);
    return null;
  }
}

module.exports = { PARENTS, labelOf, materializeParent };
