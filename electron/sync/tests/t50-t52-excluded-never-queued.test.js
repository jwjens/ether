'use strict';
// T-50..T-52 — A TABLE THAT NEVER SYNCS NEVER ENTERS THE QUEUE (2026-10-12, docs/sync-queue-excluded-leak-2026-10-12.md).
//
// The push has always refused to SEND an excluded table (T-25/T-26), but the writer still QUEUED it: on OVEVENTS 217,002
// generated_schedule mutations sat 'pending' forever, walked by every 10 s push tick. These pin the writer side:
// an excluded table's write makes no queue entry and no causal parent, and a synced table's write is unchanged.

const { createTestDb } = require('./helpers/create-test-db');
const { logMutation, withMutation } = require('../mutation-writer');
const { REGISTRY, isSyncExcluded } = require('../synced-tables');

const queued = (db, table) => db.prepare('SELECT COUNT(*) n FROM mutations WHERE table_name = ?').get(table).n;
const albumPayload = (uuid) => ({ id: 1, name: 'A', uuid, created_at: 'x', updated_at: 'x', deleted_at: null });

describe('L: excluded tables never enter the queue', () => {
  it('T-50: every excluded table (syncExcluded or local-only) is refused by logMutation — nothing is queued', () => {
    const { db } = createTestDb({ tables: ['albums'] });
    const excluded = Object.keys(REGISTRY).filter(isSyncExcluded);
    expect(excluded.sort()).toEqual(['generated_schedule', 'install_secrets_kv', 'monitor_routing']);
    for (const t of excluded) {
      const r = logMutation(db, { table_name: t, row_id: 'row-' + t, op: 'insert', payload_before: null, payload_after: { x: 1 }, station_id: '2' });
      expect(r).toBeNull();
      expect(queued(db, t)).toBe(0);
    }
    expect(db.prepare('SELECT COUNT(*) n FROM mutations').get().n).toBe(0);
  });

  it('T-51: withMutation on an excluded table still runs the write, queues nothing, and is no causal parent', () => {
    const { db } = createTestDb({ tables: ['albums'] });
    db.exec('CREATE TABLE gs_probe (id INTEGER PRIMARY KEY, v TEXT)');
    let childParent;
    withMutation(db, { table_name: 'generated_schedule', row_id: 'gs-1', op: 'insert', payload_before: null, payload_after: { x: 1 }, station_id: '2' }, () => {
      db.prepare("INSERT INTO gs_probe (v) VALUES ('written')").run();
      // A synced write nested inside it: its parent must NOT be a mutation id that is never written.
      withMutation(db, { table_name: 'albums', row_id: 'al-1', op: 'insert', payload_before: null, payload_after: albumPayload('al-1'), station_id: null }, () => {});
      childParent = db.prepare("SELECT parent_mutation_id p FROM mutations WHERE table_name = 'albums'").get().p;
    });
    expect(db.prepare('SELECT v FROM gs_probe').get().v).toBe('written');   // the table write itself happened
    expect(queued(db, 'generated_schedule')).toBe(0);
    expect(queued(db, 'albums')).toBe(1);
    expect(childParent).toBeNull();
  });

  it('T-52: a synced table is queued exactly as before', () => {
    const { db } = createTestDb({ tables: ['albums'] });
    const r = logMutation(db, { table_name: 'albums', row_id: 'al-2', op: 'insert', payload_before: null, payload_after: albumPayload('al-2'), station_id: null });
    expect(r).not.toBeNull();
    const row = db.prepare("SELECT sync_status, origin FROM mutations WHERE row_id = 'al-2'").get();
    expect(row).toEqual({ sync_status: 'pending', origin: 'local' });
  });
});
