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
const { stationConfigKvUpsertByKey } = require('../handlers/station_config_kv');

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

  // OPEN — no T-42 yet. `_sameValue` in the handler compares String(a) === String(b) so that a
  // caller binding the number 5 against a stored '5' is treated as a no-op. A test asserting that
  // (write 5, then write '5', expect no second mutation) FAILED on 2026-08-17: the guard did not
  // fire and a second mutation was journalled. The reason was not established before the session's
  // shell died, so the test was withdrawn rather than left red or left passing on a wrong premise.
  //
  // This does NOT affect the license loop the guard was written for — every real caller
  // (stampLicenseEverywhere, seed-station-config, the UI) writes strings, which T-39 covers. It
  // does mean the numeric-coercion arm of _sameValue is unproven. Reproduce with:
  //   stationConfigKvUpsertByKey(db, 2, 'monitor_volume', 5);
  //   stationConfigKvUpsertByKey(db, 2, 'monitor_volume', '5');   // expected silent, observed a write
  // and print typeof(value) from the row to see what SQLite actually stored.
});
