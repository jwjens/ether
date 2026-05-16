'use strict';
// T-21..T-24 — Tombstone tests per sync-protocol-v0.md §23 Category E

const { createTestDb } = require('./helpers/create-test-db');
const { makeWireMutation, resetHlcCounter } = require('./helpers/wire-mutation');
const { MergeEngine } = require('../merge-engine');
const { _resetForTest } = require('../mutation-writer');
const { v4: uuidv4 } = require('uuid');

// Stub causal queue — all tombstone tests use parent_mutation_id=null, Step 4 skipped.
const causalQueue = { hold: () => {} };

function makeEngine(db) {
  return new MergeEngine(db, {
    localSchemaVersion: 16,
    causalQueue,
    onCursorAdvance: () => {},
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('E: Tombstone tests', () => {
  let db, clientId, engine;

  beforeEach(() => {
    _resetForTest();
    resetHlcCounter();
    ({ db, clientId } = createTestDb());
    engine = makeEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── T-21 ──────────────────────────────────────────────────────────────────

  it('T-21: remote delete higher HLC than local insert — deleted_at set; row hidden from IS NULL query [N-109]/[N-110]', () => {
    const rowId  = uuidv4();
    const wall   = 1_700_000_000_000;
    const client = 'aaaa0000-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const now    = new Date().toISOString();

    const mInsert = makeWireMutation({
      row_id:    rowId,
      client_id: client,
      hlc:       `${wall}:0:${client}`,
      payload_after: { id: 1, uuid: rowId, title: 'To Be Deleted',
                       artist_id: null, year: null, created_at: now,
                       updated_at: null, deleted_at: null },
    });
    expect(engine.apply(mInsert)).toBe('applied');

    const deleteTime = new Date().toISOString();
    const mDelete = makeWireMutation({
      row_id:    rowId,
      client_id: client,
      op:        'delete',
      hlc:       `${wall + 1}:0:${client}`,
      payload_before: { id: 1, uuid: rowId, title: 'To Be Deleted',
                        artist_id: null, year: null, created_at: now,
                        updated_at: null, deleted_at: null },
      payload_after: null,
      created_at: deleteTime,
    });

    const result = engine.apply(mDelete);

    expect(result).toBe('applied');

    // deleted_at stamped with the mutation's created_at [N-109]
    const liveRow = db.prepare('SELECT deleted_at FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow).not.toBeUndefined();
    expect(liveRow.deleted_at).toBe(deleteTime);

    // Row hidden from IS NULL query [N-110]
    const visible = db.prepare('SELECT uuid FROM albums WHERE uuid = ? AND deleted_at IS NULL').get(rowId);
    expect(visible).toBeUndefined();
  });

  // ── T-22 ──────────────────────────────────────────────────────────────────

  it('T-22: remote delete lower HLC than local update — row survives; delete logged as loser [N-111]', () => {
    const rowId  = uuidv4();
    const wall   = 1_700_000_000_000;
    const client = 'aaaa0000-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const now    = new Date().toISOString();

    // Seed local with HIGHER HLC — local mutation wins any subsequent comparison
    const mInsert = makeWireMutation({
      row_id:    rowId,
      client_id: client,
      hlc:       `${wall + 1}:0:${client}`,
      payload_after: { id: 1, uuid: rowId, title: 'Survives Delete',
                       artist_id: null, year: null, created_at: now,
                       updated_at: null, deleted_at: null },
    });
    expect(engine.apply(mInsert)).toBe('applied');

    // Delete arrives with lower HLC — must lose [N-111]
    const mDelete = makeWireMutation({
      row_id:    rowId,
      client_id: client,
      op:        'delete',
      hlc:       `${wall}:0:${client}`,
      payload_before: { id: 1, uuid: rowId, title: 'Survives Delete',
                        artist_id: null, year: null, created_at: now,
                        updated_at: null, deleted_at: null },
      payload_after: null,
    });

    const result = engine.apply(mDelete);

    expect(result).toBe('loser');

    // Row must still be visible — delete did not apply [N-111]
    const liveRow = db.prepare('SELECT title, deleted_at FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow.title).toBe('Survives Delete');
    expect(liveRow.deleted_at).toBeNull();

    // Delete mutation is still logged (not silently dropped)
    const logRow = db.prepare('SELECT id FROM mutations WHERE id = ?').get(mDelete.id);
    expect(logRow).not.toBeUndefined();
  });

  // ── T-23 ──────────────────────────────────────────────────────────────────

  it('T-23: re-insert HLC > delete HLC — deleted_at cleared; row visible again [N-112]', () => {
    const rowId  = uuidv4();
    const wall   = 1_700_000_000_000;
    const client = 'aaaa0000-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const now    = new Date().toISOString();

    // 1. Insert the row
    const mInsert = makeWireMutation({
      row_id:    rowId,
      client_id: client,
      hlc:       `${wall}:0:${client}`,
      payload_after: { id: 1, uuid: rowId, title: 'Will Be Revived',
                       artist_id: null, year: null, created_at: now,
                       updated_at: null, deleted_at: null },
    });
    expect(engine.apply(mInsert)).toBe('applied');

    // 2. Delete with higher HLC — tombstones the row
    const mDelete = makeWireMutation({
      row_id:    rowId,
      client_id: client,
      op:        'delete',
      hlc:       `${wall + 1}:0:${client}`,
      payload_before: { id: 1, uuid: rowId, title: 'Will Be Revived',
                        artist_id: null, year: null, created_at: now,
                        updated_at: null, deleted_at: null },
      payload_after: null,
    });
    expect(engine.apply(mDelete)).toBe('applied');

    // Confirm tombstoned before the re-insert
    const afterDelete = db.prepare('SELECT deleted_at FROM albums WHERE uuid = ?').get(rowId);
    expect(afterDelete.deleted_at).not.toBeNull();

    // 3. Re-insert with even higher HLC — clears the tombstone [N-112]
    const mReInsert = makeWireMutation({
      row_id:    rowId,
      client_id: client,
      op:        'insert',
      hlc:       `${wall + 2}:0:${client}`,
      payload_after: { id: 1, uuid: rowId, title: 'Revived',
                       artist_id: null, year: null, created_at: now,
                       updated_at: null, deleted_at: null },
    });

    const result = engine.apply(mReInsert);

    expect(result).toBe('applied');

    // deleted_at cleared by INSERT OR REPLACE with deleted_at=null [N-112]
    const liveRow = db.prepare('SELECT title, deleted_at FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow.title).toBe('Revived');
    expect(liveRow.deleted_at).toBeNull();

    // Row visible again via IS NULL query
    const visible = db.prepare('SELECT uuid FROM albums WHERE uuid = ? AND deleted_at IS NULL').get(rowId);
    expect(visible).not.toBeUndefined();
  });

  // ── T-24 ──────────────────────────────────────────────────────────────────

  it('T-24: remote delete for nonexistent row — no error; mutation logged; no row created [N-107]', () => {
    const rowId = uuidv4();
    const now   = new Date().toISOString();

    const mDelete = makeWireMutation({
      row_id: rowId,
      op:     'delete',
      payload_before: { id: 1, uuid: rowId, title: 'Ghost Row',
                        artist_id: null, year: null, created_at: now,
                        updated_at: null, deleted_at: null },
      payload_after: null,
    });

    // No prior history → LWW sees null localLatest → falls through to apply
    // Apply is UPDATE ... WHERE uuid = ? → 0 rows affected, no-op [N-107]
    let result;
    expect(() => { result = engine.apply(mDelete); }).not.toThrow();
    expect(result).toBe('applied');

    // Mutation must be logged [N-107]
    const logRow = db.prepare('SELECT id FROM mutations WHERE id = ?').get(mDelete.id);
    expect(logRow).not.toBeUndefined();

    // No row created in live table — UPDATE is a no-op, not INSERT [N-107]
    const liveRow = db.prepare('SELECT uuid FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow).toBeUndefined();
  });
});
