'use strict';
// T-32..T-35 — Retention tests per sync-protocol-v0.md §23 Category H

const { createTestDb } = require('./helpers/create-test-db');
const { compactMutations, _resetForTest } = require('../mutation-writer');
const { resetHlcCounter } = require('./helpers/wire-mutation');
const { v4: uuidv4 } = require('uuid');

// ── Helper ─────────────────────────────────────────────────────────────────
// Direct-insert a mutation row. Lets tests control created_at, sync_status,
// and parent_mutation_id without going through withMutation (which would write
// a live-table row and require a specific op-payload shape).
function seedMutation(db, opts = {}) {
  const id    = opts.id ?? uuidv4();
  const now   = new Date().toISOString();
  const cli   = uuidv4();
  const rowId = uuidv4();
  db.prepare(`
    INSERT INTO mutations
      (id, client_id, station_id, actor_id, table_name, row_id, op,
       payload_before, payload_after, created_at, applied_at, hlc,
       parent_mutation_id, schema_version, origin, sync_status, conflict_resolution)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, cli, null, null,
    opts.table_name ?? 'albums', rowId, 'insert',
    null, JSON.stringify({ id: 1, uuid: rowId }),
    opts.created_at ?? now,
    opts.applied_at ?? now,
    `1700000000000:0:${cli}`,
    opts.parent_mutation_id ?? null,
    16, 'local',
    opts.sync_status ?? 'synced',
    null
  );
  return id;
}

// Use 91 days to stay well clear of the 90-day boundary [N-119]
const OLD    = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
const RECENT = new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────

describe('H: Retention tests', () => {
  let db, clientId;

  beforeEach(() => {
    _resetForTest();
    resetHlcCounter();
    ({ db, clientId } = createTestDb());
  });

  afterEach(() => {
    db.close();
  });

  // ── T-32 ──────────────────────────────────────────────────────────────────

  it('T-32: synced mutation >90 days old with no children — deleted by retention job [N-119]', () => {
    const id = seedMutation(db, { created_at: OLD, sync_status: 'synced' });

    const { deleted, stalePending } = compactMutations(db);

    expect(deleted).toBe(1);
    expect(stalePending).toBe(0);

    // Row must be gone from the mutations table
    const row = db.prepare('SELECT id FROM mutations WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  // ── T-33 ──────────────────────────────────────────────────────────────────

  it('T-33: pending mutation >90 days old — not deleted; stale-pending error logged [N-120]', () => {
    const errorSpy = vi.spyOn(console, 'error');

    const id = seedMutation(db, { created_at: OLD, sync_status: 'pending' });

    const { deleted, stalePending } = compactMutations(db);

    // Not deleted — pending mutations are never eligible for deletion [N-120]
    expect(deleted).toBe(0);
    expect(stalePending).toBe(1);

    // Row still present in mutations table
    const row = db.prepare('SELECT id FROM mutations WHERE id = ?').get(id);
    expect(row).not.toBeUndefined();

    // ERROR logged so the operator knows sync is not progressing [N-120]
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('stale pending mutation')
    );
    expect(errorSpy.mock.calls[0][0]).toContain(id);
  });

  // ── T-34 ──────────────────────────────────────────────────────────────────

  it('T-34: synced parent >90 days but referenced by pending child — neither deleted [N-119]/[N-121]', () => {
    const parentId = seedMutation(db, { created_at: OLD,    sync_status: 'synced' });
    const childId  = seedMutation(db, { created_at: RECENT, sync_status: 'pending',
                                        parent_mutation_id: parentId });

    const { deleted, stalePending } = compactMutations(db);

    // Parent: synced + old, BUT child references it → excluded by NOT IN subquery [N-121]
    // Child: pending + recent → not eligible for deletion, not stale [N-120]
    expect(deleted).toBe(0);
    expect(stalePending).toBe(0);

    // Both rows survive
    expect(db.prepare('SELECT id FROM mutations WHERE id = ?').get(parentId)).not.toBeUndefined();
    expect(db.prepare('SELECT id FROM mutations WHERE id = ?').get(childId)).not.toBeUndefined();
  });

  // ── T-35 ──────────────────────────────────────────────────────────────────

  it('T-35: synced parent + synced child both >90 days, no further refs — both deleted in one run [N-119]', () => {
    const parentId = seedMutation(db, { created_at: OLD, sync_status: 'synced' });
    const childId  = seedMutation(db, { created_at: OLD, sync_status: 'synced',
                                        parent_mutation_id: parentId });

    const { deleted, stalePending } = compactMutations(db);

    // Pass 1: child deleted (no one references it); pass 2: parent deleted (child gone)
    expect(deleted).toBe(2);
    expect(stalePending).toBe(0);

    // Both rows gone
    expect(db.prepare('SELECT id FROM mutations WHERE id = ?').get(parentId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM mutations WHERE id = ?').get(childId)).toBeUndefined();
  });
});
