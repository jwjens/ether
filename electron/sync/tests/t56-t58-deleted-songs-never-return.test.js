'use strict';
// T-56..T-58 — A deleted song never comes back: not as a song, not as a Library entry (Jeff, 2026-10-23).
//
// OVEVENTS, 2026-10-21 18:57:58Z, its first start on 4.6.62: the pull re-delivered 31 song updates from 2026-08-07 whose
// payloads carried their own tombstones. The songs stayed deleted; mirrorAssetInbound wrote their library_asset rows
// back with deleted_at = NULL, and the Library listed 31 deleted songs (docs/library-category-and-rename-2026-10-23.md).

const { createTestDb } = require('./helpers/create-test-db');
const { makeWireMutation, resetHlcCounter } = require('./helpers/wire-mutation');
const { MergeEngine } = require('../merge-engine');
const { _resetForTest } = require('../mutation-writer');
const { mirrorAssetInbound, retireOrphanedAssets } = require('../handlers/asset-mirror');
const { v4: uuidv4 } = require('uuid');

const SONGS_DDL = `
  CREATE TABLE songs (
    id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, title TEXT, file_path TEXT, file_key TEXT,
    duration_ms INTEGER, content_class TEXT, rotation_status TEXT,
    created_at TEXT, updated_at TEXT, deleted_at TEXT
  );`;
const ASSET_DDL = `
  CREATE TABLE library_asset (
    uuid TEXT PRIMARY KEY, type TEXT, title TEXT, file_path TEXT, file_key TEXT, duration_ms INTEGER,
    created_at TEXT, updated_at TEXT, deleted_at TEXT
  );`;

const DELETED_AT = '2026-07-06T21:37:07.404Z';

function setup() {
  _resetForTest();
  resetHlcCounter();
  const { db } = createTestDb();
  db.exec(SONGS_DDL);
  db.exec(ASSET_DDL);
  const engine = new MergeEngine(db, { localSchemaVersion: 16, causalQueue: { hold: () => {} }, onCursorAdvance: () => {} });
  return { db, engine };
}

// A song deleted here before deletes cleared file_path: tombstoned, path still set, its asset tombstoned too.
function seedDeletedSong(db, uuid) {
  db.prepare(`INSERT INTO songs (id, uuid, title, file_path, deleted_at, created_at) VALUES (6, ?, 'Gone Song', 'C:\\cat\\Gone Song.mp3', ?, ?)`)
    .run(uuid, DELETED_AT, DELETED_AT);
  db.prepare(`INSERT INTO library_asset (uuid, type, title, file_path, created_at, updated_at, deleted_at) VALUES (?, 'SONG', 'Gone Song', 'C:\\cat\\Gone Song.mp3', ?, ?, ?)`)
    .run(uuid, DELETED_AT, DELETED_AT, DELETED_AT);
}

const liveAssets = (db) => db.prepare('SELECT uuid FROM library_asset WHERE deleted_at IS NULL').all().map(r => r.uuid);

describe('Deleted songs never return', () => {
  let db, engine;
  beforeEach(() => { ({ db, engine } = setup()); });
  afterEach(() => { db.close(); });

  it('T-56: the OVEVENTS incident — an old update carrying the tombstone does not bring the Library entry back', () => {
    const uuid = uuidv4();
    seedDeletedSong(db, uuid);
    const client = '8e8f6181-b68a-433f-a93d-8005787b641b';
    const m = makeWireMutation({
      table_name: 'songs', row_id: uuid, op: 'update', client_id: client,
      hlc: `1786121327973:0:${client}`, created_at: '2026-08-07T16:48:47.973Z',
      payload_before: { id: 6, uuid, title: 'Gone Song', file_path: 'C:\\cat\\Gone Song.mp3', deleted_at: DELETED_AT },
      payload_after:  { id: 6, uuid, title: 'Gone Song', file_path: 'C:\\cat\\Gone Song.mp3', deleted_at: DELETED_AT },
    });
    engine.apply(m);
    expect(db.prepare('SELECT deleted_at FROM songs WHERE uuid = ?').get(uuid).deleted_at).toBe(DELETED_AT);
    expect(liveAssets(db)).toEqual([]);
  });

  it('T-57: an update with deleted_at = null (a machine that never heard of the delete) does not undelete the song', () => {
    const uuid = uuidv4();
    seedDeletedSong(db, uuid);
    const client = uuidv4();
    const m = makeWireMutation({
      table_name: 'songs', row_id: uuid, op: 'update', client_id: client, hlc: `${Date.now()}:0:${client}`,
      payload_before: { id: 6, uuid, title: 'Gone Song', file_path: 'C:\\cat\\Gone Song.mp3', deleted_at: null },
      payload_after:  { id: 6, uuid, title: 'Gone Song (edited)', file_path: 'C:\\cat\\Gone Song.mp3', deleted_at: null },
    });
    engine.apply(m);
    const row = db.prepare('SELECT title, deleted_at FROM songs WHERE uuid = ?').get(uuid);
    expect(row.deleted_at).toBe(DELETED_AT);
    expect(row.title).toBe('Gone Song');
    expect(liveAssets(db)).toEqual([]);

    // ...nor does an insert (the re-insert rule [N-112] stands for other tables, not songs).
    const ins = makeWireMutation({
      table_name: 'songs', row_id: uuid, op: 'insert', client_id: client, hlc: `${Date.now() + 1}:0:${client}`,
      payload_after: { id: 6, uuid, title: 'Gone Song', file_path: 'C:\\cat\\Gone Song.mp3', deleted_at: null },
    });
    engine.apply(ins);
    expect(db.prepare('SELECT deleted_at FROM songs WHERE uuid = ?').get(uuid).deleted_at).toBe(DELETED_AT);
    expect(liveAssets(db)).toEqual([]);
  });

  it('T-57b: the mirror itself never makes a live asset from a deleted row, and tombstones a live one', () => {
    const uuid = uuidv4();
    db.prepare(`INSERT INTO library_asset (uuid, type, title, created_at, updated_at) VALUES (?, 'SONG', 'x', 'a', 'a')`).run(uuid);
    const r = mirrorAssetInbound(db, 'songs', { uuid, title: 'x', file_path: 'C:\\cat\\x.mp3', deleted_at: DELETED_AT });
    expect(r.skipped).toBe('deleted_row');
    expect(db.prepare('SELECT deleted_at FROM library_asset WHERE uuid = ?').get(uuid).deleted_at).toBe(DELETED_AT);
    const fresh = uuidv4();
    mirrorAssetInbound(db, 'songs', { uuid: fresh, title: 'y', file_path: 'C:\\cat\\y.mp3', deleted_at: DELETED_AT });
    expect(db.prepare('SELECT 1 FROM library_asset WHERE uuid = ?').get(fresh)).toBeUndefined();
  });

  it('T-58: the launch repair retires the ghosts already there, leaves live songs alone, and is a no-op once clean', () => {
    const ghost = uuidv4(), live = uuidv4();
    db.prepare(`INSERT INTO songs (id, uuid, title, file_path, deleted_at) VALUES (1, ?, 'ghost', 'p', ?)`).run(ghost, DELETED_AT);
    db.prepare(`INSERT INTO songs (id, uuid, title, file_path) VALUES (2, ?, 'live', 'q')`).run(live);
    for (const u of [ghost, live]) {
      db.prepare(`INSERT INTO library_asset (uuid, type, title, created_at, updated_at) VALUES (?, 'SONG', 't', '2026-10-21T18:57:58Z', '2026-10-21T18:57:58Z')`).run(u);
    }
    const r = retireOrphanedAssets(db);
    expect(r.retired).toBe(1);
    expect(r.byTable).toEqual({ songs: 1 });
    expect(liveAssets(db)).toEqual([live]);
    expect(db.prepare('SELECT deleted_at FROM library_asset WHERE uuid = ?').get(ghost).deleted_at).toBe(DELETED_AT);
    expect(retireOrphanedAssets(db).retired).toBe(0);
  });

  it('T-58b: a live song still mirrors on arrival (the fix does not stop normal sync)', () => {
    const uuid = uuidv4();
    const client = uuidv4();
    const m = makeWireMutation({
      table_name: 'songs', row_id: uuid, op: 'insert', client_id: client, hlc: `${Date.now()}:0:${client}`,
      payload_after: { id: 9, uuid, title: 'New Song', file_path: 'C:\\cat\\New Song.mp3', deleted_at: null },
    });
    expect(engine.apply(m)).toBe('applied');
    expect(db.prepare('SELECT deleted_at FROM songs WHERE uuid = ?').get(uuid).deleted_at).toBeNull();
    expect(liveAssets(db)).toEqual([uuid]);
  });
});
