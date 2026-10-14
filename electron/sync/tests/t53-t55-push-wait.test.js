'use strict';
// T-53..T-55 — THE PUSH NEVER WALKS A HUGE QUEUE ON MAIN (2026-10-13, docs/air-machine-stalls-plan-2026-10-13.md §2/§4).
//
// The push index is built in the background, only in silence (electron/startup-heavy.js). Until it exists: a small queue
// is pushed with the plain query (0.5 ms after a cleanup); a queue over PUSH_WAIT_OVER pending entries makes the push
// WAIT and send nothing (the plain query took 741 ms on a 241,064-entry copy). The status count is the pushable count
// through the index, never COUNT(*) of every pending row.

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('./helpers/create-test-db');
const { FakeTransport } = require('./helpers/fake-transport');
const { SyncEngine, ensurePushPendingIndex, PUSH_PENDING_INDEX, PUSH_WAIT_OVER } = require('../sync-engine');

function seed(db, tableName, n) {
  const ins = db.prepare(`INSERT INTO mutations (id, client_id, station_id, actor_id, table_name, row_id, op, payload_before, payload_after,
    created_at, applied_at, hlc, parent_mutation_id, schema_version, origin, sync_status, conflict_resolution)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const now = new Date().toISOString(), ids = [];
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const id = uuidv4(), cli = uuidv4(), rowId = uuidv4();
      ins.run(id, cli, null, null, tableName, rowId, 'insert', null, JSON.stringify({ id: 1, uuid: rowId, name: 'x' }), now, now,
              `${1700000000000 + i}:0:${cli}`, null, 16, 'local', 'pending', null);
      ids.push(id);
    }
  })();
  return ids;
}
const dropIndex = (db) => db.exec(`DROP INDEX IF EXISTS ${PUSH_PENDING_INDEX}`);

describe('M: the push never walks a huge queue on main', () => {
  it('T-53: no index + a small queue → the plain query pushes', async () => {
    const { db } = createTestDb({ tables: ['albums'] });
    dropIndex(db);
    const ids = seed(db, 'albums', 3);
    const t = new FakeTransport();
    await new SyncEngine(db, t).push();
    expect(t._store.map((m) => m.id).sort()).toEqual(ids.sort());
  });

  it('T-54: no index + over PUSH_WAIT_OVER pending → the push waits (sends nothing, says so); with the index it sends', async () => {
    const { db } = createTestDb({ tables: ['albums'] });
    dropIndex(db);
    seed(db, 'generated_schedule', PUSH_WAIT_OVER + 5);       // the stuck entries
    const real = seed(db, 'albums', 2);
    const t = new FakeTransport();
    const e = new SyncEngine(db, t);
    await e.push();
    expect(t._store.length).toBe(0);
    expect(e.pushWaiting).toBe(true);
    ensurePushPendingIndex(db);
    const e2 = new SyncEngine(db, t);
    await e2.push();
    expect(t._store.map((m) => m.id).sort()).toEqual(real.sort());
  });

  it('T-55: the status count is what the push can send (through the index); null without the index', () => {
    const { db } = createTestDb({ tables: ['albums'] });
    ensurePushPendingIndex(db);
    seed(db, 'generated_schedule', 50);
    seed(db, 'albums', 4);
    expect(new SyncEngine(db, new FakeTransport()).pendingPushableCount()).toBe(4);
    dropIndex(db);
    expect(new SyncEngine(db, new FakeTransport()).pendingPushableCount()).toBeNull();
  });
});
