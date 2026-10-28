'use strict';
// T-39..T-41 — the station_config_kv upsert NO-OP GUARD.
//
// A write that changes nothing must never journal a mutation. Every mutation is pushed, pulled,
// applied and retained by every peer forever, so an unguarded writer on a timer becomes permanent
// sync load. Measured on OVEVENTS 2026-08-17 before the guard: 2,312 `license_key` mutations, and
// json_extract(payload_before,'$.value') == json_extract(payload_after,'$.value') for ALL 2,312 —
// stampLicenseEverywhere re-stamping four stations every 20s from App.tsx's syncCloud interval.
//
// These tests pin the three behaviours that matter: a no-op is silent, a real change still
// journals, and resurrecting a tombstone counts as a real change (it is the point of the upsert).

const { createTestDb } = require('./helpers/create-test-db');
const { stationConfigKvUpsertByKey, stationConfigKvCreate, stationConfigKvUpdate } = require('../handlers/station_config_kv');

const mutationCount = (db) => db.prepare('SELECT COUNT(*) n FROM mutations').get().n;
const rowFor = (db, stationId, key) =>
  db.prepare('SELECT * FROM station_config_kv WHERE station_id = ? AND key = ?').get(stationId, key);

describe('J: station_config_kv no-op guard', () => {
  it('T-39: re-writing an identical value journals NOTHING and leaves the row untouched', () => {
    const { db } = createTestDb({ tables: ['station_config_kv'] });

    stationConfigKvUpsertByKey(db, 2, 'license_key', 'ETH-STN-BAA8-E056-6FC8');
    const afterFirst = mutationCount(db);
    const rowFirst   = rowFor(db, 2, 'license_key');
    expect(afterFirst).toBe(1);                       // the genuine insert

    // Twenty ticks of the 20s reconcile loop, same value every time.
    for (let i = 0; i < 20; i++) {
      stationConfigKvUpsertByKey(db, 2, 'license_key', 'ETH-STN-BAA8-E056-6FC8');
    }

    expect(mutationCount(db)).toBe(afterFirst);       // still 1 — the loop is silent
    const rowNow = rowFor(db, 2, 'license_key');
    expect(rowNow.value).toBe('ETH-STN-BAA8-E056-6FC8');
    expect(rowNow.updated_at).toBe(rowFirst.updated_at);   // not even a timestamp churned
  });

  it('T-40: a genuinely different value still journals exactly one mutation', () => {
    const { db } = createTestDb({ tables: ['station_config_kv'] });

    stationConfigKvUpsertByKey(db, 2, 'license_key', 'OLD-KEY');
    const base = mutationCount(db);

    stationConfigKvUpsertByKey(db, 2, 'license_key', 'NEW-KEY');
    expect(mutationCount(db)).toBe(base + 1);
    expect(rowFor(db, 2, 'license_key').value).toBe('NEW-KEY');

    // ...and repeating the NEW value is silent again.
    stationConfigKvUpsertByKey(db, 2, 'license_key', 'NEW-KEY');
    expect(mutationCount(db)).toBe(base + 1);

    const last = db.prepare('SELECT payload_before, payload_after FROM mutations ORDER BY rowid DESC LIMIT 1').get();
    expect(JSON.parse(last.payload_before).value).toBe('OLD-KEY');
    expect(JSON.parse(last.payload_after).value).toBe('NEW-KEY');
  });

  it('T-41: same value on a TOMBSTONED row is a real change — it resurrects and journals', () => {
    const { db } = createTestDb({ tables: ['station_config_kv'] });

    stationConfigKvUpsertByKey(db, 2, 'sync_enabled', 'true');
    db.prepare("UPDATE station_config_kv SET deleted_at = 1 WHERE station_id = 2 AND key = 'sync_enabled'").run();
    const base = mutationCount(db);

    // Value is identical to what is stored, but the row is deleted — the upsert must bring it back.
    stationConfigKvUpsertByKey(db, 2, 'sync_enabled', 'true');
    expect(mutationCount(db)).toBe(base + 1);
    expect(rowFor(db, 2, 'sync_enabled').deleted_at).toBeNull();
  });

  // The two other writers got the same guard on 2026-10-27 (docs/library-sync-open-items-2026-10-27.md §4).
  it('T-41b: Update with the value already stored (or only updated_at) journals NOTHING; a real change journals one', () => {
    const { db } = createTestDb({ tables: ['station_config_kv'] });
    const row = stationConfigKvUpsertByKey(db, 2, 'monitor_volume', '0.8');
    const base = mutationCount(db);

    stationConfigKvUpdate(db, row.uuid, { value: '0.8' });
    stationConfigKvUpdate(db, row.uuid, { updated_at: new Date().toISOString() });
    expect(mutationCount(db)).toBe(base);
    expect(rowFor(db, 2, 'monitor_volume').updated_at).toBe(row.updated_at);

    stationConfigKvUpdate(db, row.uuid, { value: '0.5' });
    expect(mutationCount(db)).toBe(base + 1);
    expect(rowFor(db, 2, 'monitor_volume').value).toBe('0.5');
  });

  it('T-41c: Create of a key this station already holds with the same value journals NOTHING and makes no second row', () => {
    const { db } = createTestDb({ tables: ['station_config_kv'] });
    const first = stationConfigKvCreate(db, { station_id: 2, key: 'board_levels', value: '{"a":1}' });
    const base = mutationCount(db);

    const again = stationConfigKvCreate(db, { station_id: 2, key: 'board_levels', value: '{"a":1}' });
    expect(again.uuid).toBe(first.uuid);
    expect(mutationCount(db)).toBe(base);
    expect(db.prepare("SELECT COUNT(*) n FROM station_config_kv WHERE station_id = 2 AND key = 'board_levels'").get().n).toBe(1);

    // the same key on ANOTHER station is a different row, and is created
    stationConfigKvCreate(db, { station_id: 3, key: 'board_levels', value: '{"a":1}' });
    expect(mutationCount(db)).toBe(base + 1);
  });

  // T-42 (was OPEN since 2026-08-17). Cause found 2026-10-27: better-sqlite3 binds the number 5 as REAL and the TEXT column
  // stored "5.0", so '5' compared "5" with "5.0". The writers now store a number as its own text.
  it("T-42: 5 then '5' (and back) is one stored value: one mutation, stored as 5 not 5.0", () => {
    const { db } = createTestDb({ tables: ['station_config_kv'] });
    stationConfigKvUpsertByKey(db, 2, 'monitor_volume', 5);
    const base = mutationCount(db);
    expect(rowFor(db, 2, 'monitor_volume').value).toBe('5');
    stationConfigKvUpsertByKey(db, 2, 'monitor_volume', '5');
    stationConfigKvUpsertByKey(db, 2, 'monitor_volume', 5);
    expect(mutationCount(db)).toBe(base);
    stationConfigKvUpsertByKey(db, 2, 'monitor_volume', 0.75);
    expect(mutationCount(db)).toBe(base + 1);
    expect(rowFor(db, 2, 'monitor_volume').value).toBe('0.75');
    stationConfigKvUpsertByKey(db, 2, 'monitor_volume', '0.75');
    expect(mutationCount(db)).toBe(base + 1);
  });

  it("T-42b: Create and Update treat 5 and '5' as the same value too", () => {
    const { db } = createTestDb({ tables: ['station_config_kv'] });
    const row = stationConfigKvCreate(db, { station_id: 2, key: 'board_levels', value: 5 });
    expect(row.value).toBe('5');
    const base = mutationCount(db);
    stationConfigKvCreate(db, { station_id: 2, key: 'board_levels', value: '5' });
    stationConfigKvUpdate(db, row.uuid, { value: '5' });
    stationConfigKvUpdate(db, row.uuid, { value: 5 });
    expect(mutationCount(db)).toBe(base);
  });

  it('T-42c: a row already stored as "5.0" (before this fix) is rewritten once as "5", then silent', () => {
    const { db } = createTestDb({ tables: ['station_config_kv'] });
    stationConfigKvUpsertByKey(db, 2, 'monitor_volume', '1');
    db.prepare("UPDATE station_config_kv SET value = '5.0' WHERE key = 'monitor_volume'").run();
    const base = mutationCount(db);
    stationConfigKvUpsertByKey(db, 2, 'monitor_volume', 5);
    expect(mutationCount(db)).toBe(base + 1);
    expect(rowFor(db, 2, 'monitor_volume').value).toBe('5');
    stationConfigKvUpsertByKey(db, 2, 'monitor_volume', '5');
    expect(mutationCount(db)).toBe(base + 1);
  });
});
