'use strict';
// T-59 — Sync never guesses a path: a file's location is this computer's (Jeff, 2026-10-26; electron/catalogue.js).
//
// An inbound UPDATE used to overwrite this machine's stored location with <catalogue>/<name> built from the sender's
// path, so a location the user chose here with Change File Location was silently replaced the next time another machine
// edited anything on the song (its artist, say). Now an update that did not change the file keeps this computer's
// location; a change of file (a new name), or a row that is new here, takes the catalogue — the default location.

const path = require('path');
const { createTestDb } = require('./helpers/create-test-db');
const { makeWireMutation, resetHlcCounter } = require('./helpers/wire-mutation');
const { MergeEngine } = require('../merge-engine');
const { _resetForTest } = require('../mutation-writer');
const { v4: uuidv4 } = require('uuid');

const CAT = 'C:\\Ether\\catalogue';
const CHOSEN = 'D:\\My Music\\Thriller (my edit).mp3';

function setup() {
  _resetForTest();
  resetHlcCounter();
  const { db } = createTestDb();
  db.exec(`CREATE TABLE songs (
    id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, title TEXT, file_path TEXT, file_key TEXT,
    duration_ms INTEGER, content_class TEXT, rotation_status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);`);
  db.exec(`CREATE TABLE library_asset (uuid TEXT PRIMARY KEY, type TEXT, title TEXT, file_path TEXT, file_key TEXT,
    duration_ms INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT);`);
  const engine = new MergeEngine(db, { localSchemaVersion: 16, causalQueue: { hold: () => {} }, onCursorAdvance: () => {}, localAudioDir: CAT });
  return { db, engine };
}
const peerPath = 'C:\\Users\\projector\\Music\\Thriller.mp3';
const upd = (uuid, before, after) => {
  const client = uuidv4();
  return makeWireMutation({ table_name: 'songs', row_id: uuid, op: 'update', client_id: client, hlc: `${Date.now()}:0:${client}`,
    payload_before: { id: 3, uuid, title: 'Thriller', file_path: peerPath, deleted_at: null, ...before },
    payload_after:  { id: 3, uuid, title: 'Thriller', file_path: peerPath, deleted_at: null, ...after } });
};

describe('T-59: sync keeps this computer\'s file location', () => {
  let db, engine;
  beforeEach(() => { ({ db, engine } = setup()); });
  afterEach(() => { db.close(); });

  it('an edit on another machine (the artist) leaves the location the user chose here exactly as it is', () => {
    const uuid = uuidv4();
    db.prepare(`INSERT INTO songs (id, uuid, title, file_path) VALUES (3, ?, 'Thriller', ?)`).run(uuid, CHOSEN);
    expect(engine.apply(upd(uuid, {}, { title: 'Thriller (2008 mix)' }))).toBe('applied');
    const row = db.prepare('SELECT title, file_path FROM songs WHERE uuid = ?').get(uuid);
    expect(row.title).toBe('Thriller (2008 mix)');
    expect(row.file_path).toBe(CHOSEN);                    // it used to become C:\Ether\catalogue\Thriller.mp3
  });

  it('a change of FILE on the other machine (a new name) takes the catalogue, the default location', () => {
    const uuid = uuidv4();
    db.prepare(`INSERT INTO songs (id, uuid, title, file_path) VALUES (3, ?, 'Thriller', ?)`).run(uuid, CHOSEN);
    engine.apply(upd(uuid, {}, { file_path: 'C:\\Users\\projector\\Music\\Thriller (remaster).mp3' }));
    expect(db.prepare('SELECT file_path FROM songs WHERE uuid = ?').get(uuid).file_path).toBe(path.join(CAT, 'Thriller (remaster).mp3'));
  });

  it('a song that is new here goes to the catalogue under its own name — never the sender\'s folder', () => {
    const uuid = uuidv4(), client = uuidv4();
    engine.apply(makeWireMutation({ table_name: 'songs', row_id: uuid, op: 'insert', client_id: client, hlc: `${Date.now()}:0:${client}`,
      payload_after: { id: 3, uuid, title: 'Thriller', file_path: peerPath, deleted_at: null } }));
    expect(db.prepare('SELECT file_path FROM songs WHERE uuid = ?').get(uuid).file_path).toBe(path.join(CAT, 'Thriller.mp3'));
  });

  it('a removed file (path cleared on the other machine) is cleared here too', () => {
    const uuid = uuidv4();
    db.prepare(`INSERT INTO songs (id, uuid, title, file_path) VALUES (3, ?, 'Thriller', ?)`).run(uuid, CHOSEN);
    engine.apply(upd(uuid, {}, { file_path: null }));
    expect(db.prepare('SELECT file_path FROM songs WHERE uuid = ?').get(uuid).file_path).toBeNull();
  });
});
