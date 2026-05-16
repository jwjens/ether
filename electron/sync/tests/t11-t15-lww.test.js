'use strict';
// T-11..T-15 — LWW apply tests per sync-protocol-v0.md §23 Category C

const { createTestDb } = require('./helpers/create-test-db');
const { makeWireMutation, resetHlcCounter } = require('./helpers/wire-mutation');
const { MergeEngine } = require('../merge-engine');
const { _resetForTest } = require('../mutation-writer');
const { v4: uuidv4 } = require('uuid');

// Stub causal queue — T-11..T-15 all use parent_mutation_id=null so Step 4 is skipped.
const causalQueue = { hold: () => {} };

function makeEngine(db, localSchemaVersion = 16) {
  return new MergeEngine(db, {
    localSchemaVersion,
    causalQueue,
    onCursorAdvance: () => {},
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('C: LWW apply tests', () => {
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

  // ── T-11 ──────────────────────────────────────────────────────────────────

  it('T-11: remote HLC > local latest — payload_after applied; logged origin=remote sync_status=synced', () => {
    const rowId   = uuidv4();
    const wall    = Date.now();
    const remoteA = 'aaaa0000-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    // Seed local state: apply M1 (lower HLC) → becomes the local latest for this row
    const m1 = makeWireMutation({
      row_id:        rowId,
      client_id:     remoteA,
      hlc:           `${wall}:0:${remoteA}`,
      payload_after: { id: 1, uuid: rowId, title: 'First Title',
                       artist_id: null, year: null, created_at: new Date().toISOString(),
                       updated_at: null, deleted_at: null },
    });
    expect(engine.apply(m1)).toBe('applied');

    // M2 has higher HLC (wall + 1 ms) → must win
    const m2 = makeWireMutation({
      row_id:        rowId,
      client_id:     remoteA,
      hlc:           `${wall + 1}:0:${remoteA}`,
      payload_after: { id: 1, uuid: rowId, title: 'Winner Title',
                       artist_id: null, year: null, created_at: new Date().toISOString(),
                       updated_at: null, deleted_at: null },
    });
    const result = engine.apply(m2);

    expect(result).toBe('applied');

    // Live table must reflect M2's payload_after
    const liveRow = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow.title).toBe('Winner Title');

    // M2 logged with origin='remote' and sync_status='synced' [N-108]
    const logRow = db.prepare('SELECT origin, sync_status FROM mutations WHERE id = ?').get(m2.id);
    expect(logRow.origin).toBe('remote');
    expect(logRow.sync_status).toBe('synced');
  });

  // ── T-12 ──────────────────────────────────────────────────────────────────

  it('T-12: remote HLC < local latest — live table unchanged; remote logged but not applied', () => {
    const rowId   = uuidv4();
    const wall    = Date.now();
    const remoteA = 'aaaa0000-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    // Seed local state with HIGHER HLC first
    const m1 = makeWireMutation({
      row_id:        rowId,
      client_id:     remoteA,
      hlc:           `${wall + 1}:0:${remoteA}`,
      payload_after: { id: 1, uuid: rowId, title: 'Local Winner',
                       artist_id: null, year: null, created_at: new Date().toISOString(),
                       updated_at: null, deleted_at: null },
    });
    expect(engine.apply(m1)).toBe('applied');

    // M2 arrives with lower HLC → must lose
    const m2 = makeWireMutation({
      row_id:        rowId,
      client_id:     remoteA,
      hlc:           `${wall}:0:${remoteA}`,
      payload_after: { id: 1, uuid: rowId, title: 'Should Not Win',
                       artist_id: null, year: null, created_at: new Date().toISOString(),
                       updated_at: null, deleted_at: null },
    });
    const result = engine.apply(m2);

    expect(result).toBe('loser');

    // Live table still has M1's title — M2's payload_after was NOT applied
    const liveRow = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow.title).toBe('Local Winner');

    // M2 is still logged in mutations (so it's not lost)
    const logRow = db.prepare('SELECT id FROM mutations WHERE id = ?').get(m2.id);
    expect(logRow).not.toBeNull();
  });

  // ── T-13 ──────────────────────────────────────────────────────────────────

  it('T-13: equal HLC wall+logical, remote client_id higher — remote wins', () => {
    const rowId     = uuidv4();
    const wall      = 1_700_000_000_000;
    const clientLow  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const clientHigh = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    // Seed local with lower client_id
    const m1 = makeWireMutation({
      row_id:        rowId,
      client_id:     clientLow,
      hlc:           `${wall}:5:${clientLow}`,
      payload_after: { id: 1, uuid: rowId, title: 'Low Client',
                       artist_id: null, year: null, created_at: new Date().toISOString(),
                       updated_at: null, deleted_at: null },
    });
    expect(engine.apply(m1)).toBe('applied');

    // Remote arrives with same wall+logical, higher client_id — must win [N-105]
    const m2 = makeWireMutation({
      row_id:        rowId,
      client_id:     clientHigh,
      hlc:           `${wall}:5:${clientHigh}`,
      payload_after: { id: 1, uuid: rowId, title: 'High Client Wins',
                       artist_id: null, year: null, created_at: new Date().toISOString(),
                       updated_at: null, deleted_at: null },
    });
    const result = engine.apply(m2);

    expect(result).toBe('applied');

    const liveRow = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow.title).toBe('High Client Wins');
  });

  // ── T-14 ──────────────────────────────────────────────────────────────────

  it('T-14: equal HLC wall+logical, remote client_id lower — local wins', () => {
    const rowId     = uuidv4();
    const wall      = 1_700_000_000_000;
    const clientLow  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const clientHigh = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    // Seed local with HIGHER client_id
    const m1 = makeWireMutation({
      row_id:        rowId,
      client_id:     clientHigh,
      hlc:           `${wall}:5:${clientHigh}`,
      payload_after: { id: 1, uuid: rowId, title: 'High Client Local',
                       artist_id: null, year: null, created_at: new Date().toISOString(),
                       updated_at: null, deleted_at: null },
    });
    expect(engine.apply(m1)).toBe('applied');

    // Remote arrives with same wall+logical, lower client_id — must lose [N-105]
    const m2 = makeWireMutation({
      row_id:        rowId,
      client_id:     clientLow,
      hlc:           `${wall}:5:${clientLow}`,
      payload_after: { id: 1, uuid: rowId, title: 'Low Client Should Lose',
                       artist_id: null, year: null, created_at: new Date().toISOString(),
                       updated_at: null, deleted_at: null },
    });
    const result = engine.apply(m2);

    expect(result).toBe('loser');

    // Live table still has high-client title — low-client remote did not overwrite
    const liveRow = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow.title).toBe('High Client Local');
  });

  // ── T-15 ──────────────────────────────────────────────────────────────────

  it('T-15: no prior mutations for (table_name, row_id) — incoming wins unconditionally', () => {
    // No existing mutations in DB for this row — the LWW check sees no localLatest
    const rowId = uuidv4();
    const m = makeWireMutation({
      row_id:        rowId,
      payload_after: { id: 1, uuid: rowId, title: 'First Ever',
                       artist_id: null, year: null, created_at: new Date().toISOString(),
                       updated_at: null, deleted_at: null },
    });

    const result = engine.apply(m);

    expect(result).toBe('applied');

    // Row exists in live table
    const liveRow = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow).not.toBeNull();
    expect(liveRow.title).toBe('First Ever');

    // Mutation logged
    const logRow = db.prepare('SELECT origin, sync_status FROM mutations WHERE id = ?').get(m.id);
    expect(logRow.origin).toBe('remote');
    expect(logRow.sync_status).toBe('synced');
  });
});
