'use strict';
// T-30..T-31 — Idempotency tests per sync-protocol-v0.md §23 Category G

const { createTestDb } = require('./helpers/create-test-db');
const { makeWireMutation, resetHlcCounter } = require('./helpers/wire-mutation');
const { MergeEngine } = require('../merge-engine');
const { _resetForTest } = require('../mutation-writer');
const { v4: uuidv4 } = require('uuid');

const causalQueue = { hold: () => {} };

function makeEngine(db, cursorCalls = []) {
  return new MergeEngine(db, {
    localSchemaVersion: 16,
    causalQueue,
    onCursorAdvance: (cid, hlc) => cursorCalls.push({ cid, hlc }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('G: Idempotency tests', () => {
  let db, clientId;

  beforeEach(() => {
    _resetForTest();
    resetHlcCounter();
    ({ db, clientId } = createTestDb());
  });

  afterEach(() => {
    db.close();
  });

  // ── T-30 ──────────────────────────────────────────────────────────────────

  it('T-30: same mutation UUID applied twice — second is idempotent; one row in mutations; live table unchanged [N-100]', () => {
    const cursorCalls = [];
    const engine = makeEngine(db, cursorCalls);

    const rowId = uuidv4();
    const now   = new Date().toISOString();
    const m = makeWireMutation({
      row_id:        rowId,
      payload_after: { id: 1, uuid: rowId, title: 'Original Title',
                       artist_id: null, year: null, created_at: now,
                       updated_at: null, deleted_at: null },
    });

    // First apply — normal path
    const result1 = engine.apply(m);
    expect(result1).toBe('applied');
    expect(cursorCalls).toHaveLength(1);

    const liveAfterFirst = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowId);
    expect(liveAfterFirst.title).toBe('Original Title');

    // Second apply of the same object — Step 1 fires, short-circuits
    const result2 = engine.apply(m);
    expect(result2).toBe('idempotent');

    // Cursor advances even on idempotent path [N-100]
    expect(cursorCalls).toHaveLength(2);

    // Exactly one row in mutations for this id — not duplicated
    const count = db.prepare('SELECT COUNT(*) AS n FROM mutations WHERE id = ?').get(m.id).n;
    expect(count).toBe(1);

    // Live table unchanged — second apply did not overwrite anything
    const liveAfterSecond = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowId);
    expect(liveAfterSecond.title).toBe('Original Title');
  });

  // ── T-31 ──────────────────────────────────────────────────────────────────

  it('T-31: same mutation UUID re-applied after it was an LWW loser — idempotent; cursor advances; winner survives [N-100]', () => {
    const cursorCalls = [];
    const engine = makeEngine(db, cursorCalls);

    const rowId    = uuidv4();
    const wall     = 1_700_000_000_000;
    const client   = 'aaaa0000-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const now      = new Date().toISOString();

    // Apply winner first (higher HLC)
    const mWinner = makeWireMutation({
      row_id:    rowId,
      client_id: client,
      hlc:       `${wall + 1}:0:${client}`,
      payload_after: { id: 1, uuid: rowId, title: 'Winner Title',
                       artist_id: null, year: null, created_at: now,
                       updated_at: null, deleted_at: null },
    });
    expect(engine.apply(mWinner)).toBe('applied');

    // Apply loser (lower HLC) — logged but not applied to live table
    const mLoser = makeWireMutation({
      row_id:    rowId,
      client_id: client,
      hlc:       `${wall}:0:${client}`,
      payload_after: { id: 1, uuid: rowId, title: 'Loser Title',
                       artist_id: null, year: null, created_at: now,
                       updated_at: null, deleted_at: null },
    });
    expect(engine.apply(mLoser)).toBe('loser');

    // Confirm loser is in mutations table (logged, not discarded)
    const loserLog = db.prepare('SELECT id FROM mutations WHERE id = ?').get(mLoser.id);
    expect(loserLog).not.toBeUndefined();

    // Live table still shows winner
    const liveBeforeRetry = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowId);
    expect(liveBeforeRetry.title).toBe('Winner Title');

    const callsBefore = cursorCalls.length;

    // Re-apply the same loser mutation — Step 1 sees the id, short-circuits
    const result3 = engine.apply(mLoser);
    expect(result3).toBe('idempotent');

    // Cursor must advance on idempotent path [N-100]
    expect(cursorCalls.length).toBe(callsBefore + 1);

    // Still exactly one loser row — not duplicated
    const count = db.prepare('SELECT COUNT(*) AS n FROM mutations WHERE id = ?').get(mLoser.id).n;
    expect(count).toBe(1);

    // Winner title still intact — loser re-apply did not overwrite
    const liveAfterRetry = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowId);
    expect(liveAfterRetry.title).toBe('Winner Title');
  });
});
