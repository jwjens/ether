'use strict';
// T-16..T-20 — Causal ordering tests per sync-protocol-v0.md §23 Category D
//
// T-16: component level (MergeEngine + explicit CausalOrderQueue — queue inspectable)
// T-17: SyncEngine level (FakeTransport — exercises _retryCausalQueue wiring) — TODO
// T-18: SyncEngine level (FakeTransport — recursive release for C→B→A chain) — TODO
// T-19: CausalOrderQueue level (checkStale() with vi fake timers)
// T-20: component level (null parent_mutation_id skips Step 4)

const { createTestDb } = require('./helpers/create-test-db');
const { makeWireMutation, resetHlcCounter } = require('./helpers/wire-mutation');
const { FakeTransport } = require('./helpers/fake-transport');
const { MergeEngine } = require('../merge-engine');
const { CausalOrderQueue } = require('../causal-order');
const { SyncEngine } = require('../sync-engine');
const { _resetForTest } = require('../mutation-writer');
const { v4: uuidv4 } = require('uuid');

// ─────────────────────────────────────────────────────────────────────────────

describe('D: Causal ordering tests', () => {
  let db, clientId;

  beforeEach(() => {
    _resetForTest();
    resetHlcCounter();
    ({ db, clientId } = createTestDb());
  });

  afterEach(() => {
    vi.useRealTimers();   // guard against T-19 fake timer bleed
    db.close();
  });

  // ── T-16 ──────────────────────────────────────────────────────────────────

  it('T-16: child arrives before parent — held, cursor not advanced, not written to mutations', () => {
    const cursorCalls = [];
    const causalQueue = new CausalOrderQueue();
    const engine = new MergeEngine(db, {
      localSchemaVersion: 16,
      causalQueue,
      onCursorAdvance: (cid, hlc) => cursorCalls.push({ cid, hlc }),
    });

    const rowA = uuidv4();
    const rowB = uuidv4();
    const mParent = makeWireMutation({ row_id: rowA });
    const mChild  = makeWireMutation({ row_id: rowB, parent_mutation_id: mParent.id });

    const result = engine.apply(mChild);

    // Step 4 fires: parent not in mutations table → hold
    expect(result).toBe('held');

    // Child is tracked in the causal queue [N-103]
    expect(causalQueue.hasHeld(mChild.id)).toBe(true);
    expect(causalQueue.heldCount).toBe(1);

    // Cursor must NOT advance — re-delivery path left open [N-103]
    expect(cursorCalls).toHaveLength(0);

    // Child must NOT be written to mutations table [N-103]
    const row = db.prepare('SELECT id FROM mutations WHERE id = ?').get(mChild.id);
    expect(row).toBeUndefined();
  });

  // ── T-17 ──────────────────────────────────────────────────────────────────

  it('T-17: parent arrives after child held — _retryCausalQueue fires; both applied; queue drained', async () => {
    const transport = new FakeTransport();
    const engine    = new SyncEngine(db, transport);

    const now        = new Date().toISOString();
    const rowIdP     = uuidv4();
    const rowIdC     = uuidv4();

    // mParent: no causal dependency — will be the root that unblocks mChild.
    // mChild:  parent_mutation_id → mParent.id; must arrive first to be held.
    // Use distinct payload.id values so INSERT OR REPLACE doesn't collapse both
    // inserts into one row (albums.id is INTEGER PRIMARY KEY).
    const mParent = makeWireMutation({
      row_id:       rowIdP,
      payload_after: { id: 10, uuid: rowIdP, title: 'Parent Row',
                       artist_id: null, year: null, created_at: now,
                       updated_at: null, deleted_at: null },
    });
    const mChild = makeWireMutation({
      row_id:             rowIdC,
      parent_mutation_id: mParent.id,
      payload_after: { id: 11, uuid: rowIdC, title: 'Child Row',
                       artist_id: null, year: null, created_at: now,
                       updated_at: null, deleted_at: null },
    });

    // Deliver child first (held), parent second (applied → releases child).
    // Use public push() — exercises the real transport path [N-114].
    await transport.push({ client_id: 'remote', station_id: null, batch: [mChild, mParent] });
    await engine.pull();

    // Both mutations must be in the mutations log
    const logP = db.prepare('SELECT origin, sync_status FROM mutations WHERE id = ?').get(mParent.id);
    const logC = db.prepare('SELECT origin, sync_status FROM mutations WHERE id = ?').get(mChild.id);
    expect(logP).not.toBeUndefined();
    expect(logC).not.toBeUndefined();
    expect(logP.origin).toBe('remote');
    expect(logC.origin).toBe('remote');

    // Both rows must be in the live albums table
    const liveP = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowIdP);
    const liveC = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowIdC);
    expect(liveP?.title).toBe('Parent Row');
    expect(liveC?.title).toBe('Child Row');

    // Causal queue must be fully drained — no silent accumulation
    expect(engine._causalQueue.heldCount).toBe(0);
  });

  // ── T-18 ──────────────────────────────────────────────────────────────────

  it('T-18: C→B→A chain; C first, B second, A last — all held until A; applied A,B,C in order; queue drained', async () => {
    const transport = new FakeTransport();
    const engine    = new SyncEngine(db, transport);

    const now    = new Date().toISOString();
    const rowIdA = uuidv4();
    const rowIdB = uuidv4();
    const rowIdC = uuidv4();

    // Build chain: A is root, B depends on A, C depends on B.
    // Distinct payload.id values per row to prevent INSERT OR REPLACE collisions.
    const mA = makeWireMutation({
      row_id:       rowIdA,
      payload_after: { id: 10, uuid: rowIdA, title: 'Row A',
                       artist_id: null, year: null, created_at: now,
                       updated_at: null, deleted_at: null },
    });
    const mB = makeWireMutation({
      row_id:             rowIdB,
      parent_mutation_id: mA.id,
      payload_after: { id: 11, uuid: rowIdB, title: 'Row B',
                       artist_id: null, year: null, created_at: now,
                       updated_at: null, deleted_at: null },
    });
    const mC = makeWireMutation({
      row_id:             rowIdC,
      parent_mutation_id: mB.id,
      payload_after: { id: 12, uuid: rowIdC, title: 'Row C',
                       artist_id: null, year: null, created_at: now,
                       updated_at: null, deleted_at: null },
    });

    // Deliver C first, B second, A last — worst-case arrival order for causal ordering.
    // pull() sees [mC, mB, mA] → C held, B held, A applied →
    //   _retryCausalQueue(mA.id) releases mB → applied →
    //   _retryCausalQueue(mB.id) releases mC → applied.
    await transport.push({ client_id: 'remote', station_id: null, batch: [mC, mB, mA] });
    await engine.pull();

    // All three mutations logged
    const logA = db.prepare('SELECT origin FROM mutations WHERE id = ?').get(mA.id);
    const logB = db.prepare('SELECT origin FROM mutations WHERE id = ?').get(mB.id);
    const logC = db.prepare('SELECT origin FROM mutations WHERE id = ?').get(mC.id);
    expect(logA?.origin).toBe('remote');
    expect(logB?.origin).toBe('remote');
    expect(logC?.origin).toBe('remote');

    // All three rows in the live albums table
    const liveA = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowIdA);
    const liveB = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowIdB);
    const liveC = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowIdC);
    expect(liveA?.title).toBe('Row A');
    expect(liveB?.title).toBe('Row B');
    expect(liveC?.title).toBe('Row C');

    // Recursive _retryCausalQueue must have drained the queue completely
    expect(engine._causalQueue.heldCount).toBe(0);
  });

  // ── T-19 ──────────────────────────────────────────────────────────────────

  it('T-19: child held >30 min — checkStale() logs WARNING [N-103]', () => {
    const causalQueue = new CausalOrderQueue();
    const baseTime    = 1_700_000_000_000;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseTime));

    // hold() records Date.now() = baseTime as the hold timestamp
    const mParent = makeWireMutation({ row_id: uuidv4() });
    const mChild  = makeWireMutation({ row_id: uuidv4(), parent_mutation_id: mParent.id });
    causalQueue.hold(mChild);   // directly — isolates the queue's own staleness mechanism

    // Advance to 31 minutes later
    vi.setSystemTime(new Date(baseTime + 31 * 60 * 1000));

    const warnSpy = vi.spyOn(console, 'warn');
    causalQueue.checkStale();   // heldMs = 31min >= WARN_MS (30min) → warn

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[causal-order] mutation held >30min')
    );
    // Sanity: the warning names the correct mutation
    expect(warnSpy.mock.calls[0][0]).toContain(mChild.id);
    expect(warnSpy.mock.calls[0][0]).toContain(mParent.id);
  });

  // ── T-20 ──────────────────────────────────────────────────────────────────

  it('T-20: parent_mutation_id = null — Step 4 skipped; applied immediately in Step 5', () => {
    const causalQueue = new CausalOrderQueue();
    const engine = new MergeEngine(db, {
      localSchemaVersion: 16,
      causalQueue,
      onCursorAdvance: () => {},
    });

    const rowId = uuidv4();
    const m = makeWireMutation({
      row_id:             rowId,
      parent_mutation_id: null,   // explicit null — [N-104]: Step 4 must not run
      payload_after: {
        id: 1, uuid: rowId, title: 'No Parent Needed',
        artist_id: null, year: null, created_at: new Date().toISOString(),
        updated_at: null, deleted_at: null,
      },
    });

    const result = engine.apply(m);

    // Step 4 skipped → falls through to LWW → wins (no prior history for this row)
    expect(result).toBe('applied');

    // Row present in live table
    const liveRow = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow).not.toBeNull();
    expect(liveRow.title).toBe('No Parent Needed');

    // Queue was never touched
    expect(causalQueue.heldCount).toBe(0);
  });
});
