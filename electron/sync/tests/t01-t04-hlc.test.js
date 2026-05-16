'use strict';
// T-01..T-04 — HLC unit tests per sync-protocol-v0.md §23 Category A
//
// All tests run in one in-memory DB per test.
// _resetForTest() clears the mutation-writer's module-level cachedClientId
// before each test so each fresh DB's client_id is picked up correctly.

// vitest globals (describe/it/expect/beforeEach/afterEach/vi) are injected by
// vitest via globals:true in run-sync-tests.js — do not require('vitest') here.
const { createTestDb }  = require('./helpers/create-test-db');
const { compareHLC }    = require('../merge-engine');

// Static require is fine here — _resetForTest() handles module-level state.
const { nextClock, _resetForTest } = require('../mutation-writer');

// ─────────────────────────────────────────────────────────────────────────────

describe('A: HLC unit tests', () => {
  let db, clientId;

  beforeEach(() => {
    _resetForTest();
    ({ db, clientId } = createTestDb());
  });

  afterEach(() => {
    vi.useRealTimers();  // ensure T-03's fake timers never bleed into other tests
    db.close();
  });

  // ── T-01 ──────────────────────────────────────────────────────────────────

  it('T-01: clock advances — second nextClock() is higher than first', () => {
    const hlc1 = db.transaction(() => nextClock(db))();
    const hlc2 = db.transaction(() => nextClock(db))();

    const [w1, l1] = hlc1.split(':').map(Number);
    const [w2, l2] = hlc2.split(':').map(Number);

    const wallAdvanced    = w2 > w1;
    const logicalAdvanced = w2 === w1 && l2 > l1;
    expect(wallAdvanced || logicalAdvanced).toBe(true);
  });

  // ── T-02 ──────────────────────────────────────────────────────────────────

  it('T-02: clock skew — wall stays at hlc_last.wall_ms, logical increments', () => {
    // Seed hlc_last to a wall_ms far in the future so Date.now() < last_wall
    const futureWall = Date.now() + 100_000;
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE system_state SET value = ?, updated_at = ? WHERE key = 'hlc_last'"
    ).run(`${futureWall}:5:${clientId}`, now);

    const hlc = db.transaction(() => nextClock(db))();
    const parts = hlc.split(':');
    const wall    = parseInt(parts[0], 10);
    const logical = parseInt(parts[1], 10);

    // Wall must NOT regress — stays at futureWall per [N-44]
    expect(wall).toBe(futureWall);
    // Logical increments from 5 → 6
    expect(logical).toBe(6);
  });

  // ── T-03 ──────────────────────────────────────────────────────────────────

  it('T-03: same-ms batch of 100 — all unique, logical 0..99, wall identical', () => {
    // Freeze Date.now() at a fixed value. The initial hlc_last is 0:0:clientId
    // so the first call advances the wall from 0 → fixedMs (logical=0).
    // Subsequent 99 calls all see fixedMs === last_wall so logical increments.
    const fixedMs = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedMs));

    const hlcs = [];
    db.transaction(() => {
      for (let i = 0; i < 100; i++) hlcs.push(nextClock(db));
    })();

    vi.useRealTimers();

    const walls    = hlcs.map(h => h.split(':')[0]);
    const logicals = hlcs.map(h => parseInt(h.split(':')[1], 10));

    expect(new Set(hlcs).size).toBe(100);               // all unique
    expect(new Set(walls).size).toBe(1);                // same wall component
    expect(walls[0]).toBe(String(fixedMs));             // correct wall value
    expect(logicals[0]).toBe(0);                        // starts at 0
    expect(logicals[99]).toBe(99);                      // ends at 99
    // Verify monotonicity: each logical is exactly one more than the previous
    for (let i = 1; i < 100; i++) {
      expect(logicals[i]).toBe(logicals[i - 1] + 1);
    }
  });

  // ── T-04 ──────────────────────────────────────────────────────────────────

  it('T-04: equal wall+logical, different client_id — higher client_id sorts later', () => {
    // Use client_ids where 'a...' < 'b...' lexicographically
    const clientA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const clientB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const wall    = '1700000000000';
    const logical = '5';

    const hlcA = `${wall}:${logical}:${clientA}`;
    const hlcB = `${wall}:${logical}:${clientB}`;

    // B sorts later (higher client_id) → compareHLC(A, B) < 0
    expect(compareHLC(hlcA, hlcB)).toBe(-1);
    // A sorts earlier → compareHLC(B, A) > 0
    expect(compareHLC(hlcB, hlcA)).toBe(1);
    // Same HLC → 0
    expect(compareHLC(hlcA, hlcA)).toBe(0);

    // Verify: higher wall wins regardless of client_id
    const hlcLaterWall = `${parseInt(wall) + 1}:0:${clientA}`;
    expect(compareHLC(hlcLaterWall, hlcB)).toBe(1);

    // Verify: higher logical wins when wall is equal
    const hlcHigherLogical = `${wall}:6:${clientA}`;
    expect(compareHLC(hlcHigherLogical, hlcB)).toBe(1);  // logical 6 > 5

    // N-47: same (wall, logical) + different client_id = concurrent
    // Tie-break is deterministic but not semantic — both values are simultaneous
    // (no causal ordering possible between them)
  });
});
