'use strict';
// T-60 — library_asset.intro_version_path: RECEIVED as a file, SENT as before (Jeff, 2026-10-27: "Option 1. Make the
// intro-item change in the next build, and switch the sending side only after OV is on that build").
//
// Sent: still a plain string — a computer on an older build reads the column as scalar and would refuse an envelope.
// Received: this computer keeps only the file name and builds its own <catalogue>/<name>, never the sender's folder; an
// update that did not change the intro file keeps this computer's location. docs/library-sync-open-items-2026-10-27.md §5.

const path = require('path');
const { createTestDb } = require('./helpers/create-test-db');
const { makeWireMutation, resetHlcCounter } = require('./helpers/wire-mutation');
const { MergeEngine } = require('../merge-engine');
const { serializePayload, deserializePayload, _resetForTest } = require('../mutation-writer');
const { v4: uuidv4 } = require('uuid');

const CAT = 'C:\\Ether\\catalogue';
const PEER = 'C:\\Users\\projector\\Music\\Thriller (intro).mp3';
const MINE = 'D:\\My Music\\Thriller intro edit.mp3';

function setup() {
  _resetForTest();
  resetHlcCounter();
  const { db } = createTestDb();
  db.exec(`CREATE TABLE library_asset (id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, type TEXT, title TEXT, file_path TEXT, file_key TEXT,
    intro_version_path TEXT, has_intro INTEGER, duration_ms INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT);`);
  const engine = new MergeEngine(db, { localSchemaVersion: 16, causalQueue: { hold: () => {} }, onCursorAdvance: () => {}, localAudioDir: CAT });
  return { db, engine };
}
const mut = (op, uuid, before, after) => {
  const client = uuidv4();
  return makeWireMutation({ table_name: 'library_asset', row_id: uuid, op, client_id: client, hlc: `${Date.now()}:0:${client}`,
    payload_before: before && { uuid, type: 'song', title: 'Thriller', deleted_at: null, ...before },
    payload_after:  { uuid, type: 'song', title: 'Thriller', deleted_at: null, ...after } });
};

describe('T-60: library_asset.intro_version_path is received as a file, sent as before', () => {
  it('sending is unchanged: a plain string, which an older build reads as it always has', () => {
    const p = serializePayload({ uuid: 'u', title: 'T', intro_version_path: PEER }, 'library_asset');
    expect(p.intro_version_path).toBe(PEER);
  });

  it('receiving keeps only the file name, under this computer\'s catalogue (plain string from an older sender)', () => {
    const row = deserializePayload({ uuid: 'u', intro_version_path: PEER }, 'library_asset', { localAudioDir: CAT });
    expect(row.intro_version_path).toBe(path.join(CAT, 'Thriller (intro).mp3'));
  });

  it('receiving also reads the file envelope a later build will send', () => {
    const row = deserializePayload({ uuid: 'u', intro_version_path: { __blob_ref: PEER, __blob_size: null, __blob_origin: PEER } },
      'library_asset', { localAudioDir: CAT });
    expect(row.intro_version_path).toBe(path.join(CAT, 'Thriller (intro).mp3'));
  });

  it('null stays null', () => {
    expect(deserializePayload({ uuid: 'u', intro_version_path: null }, 'library_asset', { localAudioDir: CAT }).intro_version_path).toBeNull();
  });

  describe('through the merge engine', () => {
    let db, engine;
    beforeEach(() => { ({ db, engine } = setup()); });
    afterEach(() => { db.close(); });

    it('a new row stores <catalogue>/<name>, never the sender\'s folder', () => {
      const uuid = uuidv4();
      expect(engine.apply(mut('insert', uuid, null, { intro_version_path: PEER }))).toBe('applied');
      expect(db.prepare('SELECT intro_version_path v FROM library_asset WHERE uuid = ?').get(uuid).v)
        .toBe(path.join(CAT, 'Thriller (intro).mp3'));
    });

    it('an edit elsewhere that did not change the intro file keeps this computer\'s location', () => {
      const uuid = uuidv4();
      db.prepare(`INSERT INTO library_asset (id, uuid, type, title, intro_version_path) VALUES (7, ?, 'song', 'Thriller', ?)`).run(uuid, MINE);
      expect(engine.apply(mut('update', uuid, { intro_version_path: PEER }, { title: 'Thriller (2008)', intro_version_path: PEER }))).toBe('applied');
      const r = db.prepare('SELECT title, intro_version_path v FROM library_asset WHERE uuid = ?').get(uuid);
      expect(r.title).toBe('Thriller (2008)');
      expect(r.v).toBe(MINE);
    });
  });
});
