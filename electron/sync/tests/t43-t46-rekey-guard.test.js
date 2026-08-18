'use strict';
// T-43..T-46 — THE RE-KEY GUARD.
//
// A peer must never be able to renumber this machine's rows, whatever ITS sync_uuid_identity flag
// says. The apply path is INSERT OR REPLACE and `uuid` is UNIQUE, so a REPLACE deletes the local row
// and re-inserts it under whatever integer `id` the payload carried. Before 2026-08-17 the guard
// against that was gated on the LOCAL `_uuidIdentity` flag, which is read once at construction — so a
// sender with the flag off re-keyed this install anyway. It happened twice: OV pushed its stations as
// ids 1-4, this install's 5-8 were REPLACE-deleted and re-inserted as 1-4, and 137,878
// generated_schedule rows plus 48,099 play_log rows were orphaned both times.
//
// Every test here constructs the MergeEngine with uuidIdentity OFF (the default, and the state the
// machine was actually in) — that is the whole point. If any of these pass only with the flag on,
// the fix has been re-gated and the defect is back.
//
// docs/fix-pass-2026-08-17-sync.md §2 · docs/sync-systems-map.md hazard A

const { createTestDb } = require('./helpers/create-test-db');
const { makeWireMutation, resetHlcCounter } = require('./helpers/wire-mutation');
const { MergeEngine } = require('../merge-engine');
const { _resetForTest } = require('../mutation-writer');
const { v4: uuidv4 } = require('uuid');

const causalQueue = { hold: () => {} };

// uuidIdentity is deliberately NOT passed → defaults to false → the OV configuration.
function makeEngineFlagOff(db) {
  return new MergeEngine(db, {
    localSchemaVersion: 16,
    causalQueue,
    onCursorAdvance: () => {},
  });
}

const stationRow = (over = {}) => ({
  id: 1, uuid: null, name: 'halloVeen', is_active: 1,
  created_at: '2026-07-06T17:44:54.379Z', updated_at: '2026-08-17T20:54:06.509Z', deleted_at: null,
  ...over,
});

const idOf   = (db, uuid) => db.prepare('SELECT id FROM stations WHERE uuid = ?').get(uuid)?.id ?? null;
const countOf = (db) => db.prepare('SELECT COUNT(*) n FROM stations').get().n;

describe('K: re-key guard (peer flag state must never renumber us)', () => {
  let db;

  beforeEach(() => {
    _resetForTest();
    resetHlcCounter();
    ({ db } = createTestDb({ tables: ['stations'] }));
  });

  afterEach(() => db.close());

  // ── T-43: the exact incident ────────────────────────────────────────────────
  it('T-43: inbound stations UPDATE carrying a foreign id, uuid-identity OFF — local id unchanged', () => {
    const stationUuid = '43889edc-203d-4743-9e4f-6ea311d6e035';   // halloVeen, the real uuid
    const engine = makeEngineFlagOff(db);

    // This install has halloVeen as local id 6 (what OVEVENTS actually had).
    db.prepare(`INSERT INTO stations (id, uuid, name, is_active, created_at, updated_at, deleted_at)
                VALUES (6, ?, 'halloVeen', 1, '2026-07-06T17:44:54.379Z', NULL, NULL)`).run(stationUuid);
    expect(idOf(db, stationUuid)).toBe(6);

    // The peer (OV) pushes the same station — same uuid — as ITS local id 2.
    const client = '041ceb96-3d66-4d39-85c0-e2f5aa6e3b1e';
    const m = makeWireMutation({
      table_name: 'stations',
      row_id:     stationUuid,
      client_id:  client,
      op:         'update',
      hlc:        `${1_787_000_000_000}:0:${client}`,
      payload_before: stationRow({ id: 2, uuid: stationUuid }),
      payload_after:  stationRow({ id: 2, uuid: stationUuid, name: 'halloVeen' }),
    });

    expect(engine.apply(m)).toBe('applied');

    // THE ASSERTION. Local identity survived a peer whose flag was off.
    expect(idOf(db, stationUuid)).toBe(6);
    expect(countOf(db)).toBe(1);                     // not deleted-and-reinserted as a second row
    expect(db.prepare('SELECT name FROM stations WHERE id = 6').get().name).toBe('halloVeen');
  });

  // ── T-44: same, through the INSERT OR REPLACE path ──────────────────────────
  it('T-44: inbound stations INSERT for a uuid we already hold — REPLACE keeps OUR id', () => {
    const stationUuid = 'dfbc68ac-e4d2-4769-9519-a28ead7884ae';   // Magical Forest
    const engine = makeEngineFlagOff(db);

    db.prepare(`INSERT INTO stations (id, uuid, name, is_active, created_at, updated_at, deleted_at)
                VALUES (7, ?, 'Magical Forest', 0, '2026-07-06T17:44:54.380Z', NULL, NULL)`).run(stationUuid);

    const client = '041ceb96-3d66-4d39-85c0-e2f5aa6e3b1e';
    const m = makeWireMutation({
      table_name: 'stations',
      row_id:     stationUuid,
      client_id:  client,
      op:         'insert',
      hlc:        `${1_787_000_000_000}:0:${client}`,
      payload_before: null,
      payload_after:  stationRow({ id: 3, uuid: stationUuid, name: 'Magical Forest', is_active: 0 }),
    });

    expect(engine.apply(m)).toBe('applied');
    expect(idOf(db, stationUuid)).toBe(7);
    expect(countOf(db)).toBe(1);
  });

  // ── T-45: the second data-loss path — a foreign id colliding with an unrelated local row ──
  it('T-45: inbound row we do NOT have — id omitted; an unrelated local row holding that id survives', () => {
    const ourUuid      = '75532b61-fa0c-4bc5-a5f0-0298b94c0123';  // Open Format, our id 5
    const incomingUuid = 'f6ac7a00-d905-4b87-b0ef-f219ac3b1e1e';  // Christmas in July, not here yet
    const engine = makeEngineFlagOff(db);

    db.prepare(`INSERT INTO stations (id, uuid, name, is_active, created_at, updated_at, deleted_at)
                VALUES (5, ?, 'Open Format', 0, '2026-07-06T17:44:54.376Z', NULL, NULL)`).run(ourUuid);

    // The peer sends a DIFFERENT station that happens to carry integer id 5 on ITS machine.
    const client = '041ceb96-3d66-4d39-85c0-e2f5aa6e3b1e';
    const m = makeWireMutation({
      table_name: 'stations',
      row_id:     incomingUuid,
      client_id:  client,
      op:         'insert',
      hlc:        `${1_787_000_000_000}:0:${client}`,
      payload_before: null,
      payload_after:  stationRow({ id: 5, uuid: incomingUuid, name: 'Christmas in Jully', is_active: 0 }),
    });

    expect(engine.apply(m)).toBe('applied');

    // Our Open Format was NOT REPLACE-deleted by a colliding foreign id.
    expect(idOf(db, ourUuid)).toBe(5);
    expect(db.prepare('SELECT name FROM stations WHERE id = 5').get().name).toBe('Open Format');
    // The new station landed, under an id SQLite chose — never the sender's.
    expect(countOf(db)).toBe(2);
    expect(idOf(db, incomingUuid)).not.toBe(5);
    expect(idOf(db, incomingUuid)).not.toBeNull();
  });

  // ── T-46: no regression for tables with no id/uuid pair ─────────────────────
  it('T-46: a table with no integer id (station_config_kv) still applies normally', () => {
    const { db: db2 } = createTestDb({ tables: ['station_config_kv'] });
    const engine = makeEngineFlagOff(db2);
    const rowUuid = uuidv4();
    const client  = '041ceb96-3d66-4d39-85c0-e2f5aa6e3b1e';

    const m = makeWireMutation({
      table_name: 'station_config_kv',
      row_id:     rowUuid,
      client_id:  client,
      station_id: 2,
      op:         'insert',
      hlc:        `${1_787_000_000_000}:0:${client}`,
      payload_before: null,
      payload_after: {
        station_id: 2, key: 'station_name', value: 'halloVeen', uuid: rowUuid,
        created_at: 1787000000, updated_at: 1787000000, deleted_at: null, station_uuid: null,
      },
    });

    expect(engine.apply(m)).toBe('applied');
    expect(db2.prepare("SELECT value FROM station_config_kv WHERE uuid = ?").get(rowUuid).value)
      .toBe('halloVeen');
    db2.close();
  });

  // NOTE — the "local row exists with id NULL" branch (incoming id allowed through, [N-108c]
  // shows null->real) is not testable against `stations`: its id is INTEGER PRIMARY KEY, which is
  // the rowid alias and cannot hold NULL. That branch exists for tables where `id` is an ordinary
  // nullable column, and is exercised by the existing [N-108c] coverage.
});

// ── T-47: the flag is live, not construction-time ─────────────────────────────
// `sync:set-uuid-identity` could only ever report restartRequired:true, because the engine read the
// flag once at construction. A toggle that looks like it worked but does nothing until a full quit
// is how the wrong value stayed live on OVEVENTS for a day.
describe('K: uuid-identity is settable on a running scheduler', () => {
  it('T-47: setUuidIdentity flips the stored opt and rebuilds the engine in place', () => {
    const { SyncScheduler } = require('../sync-scheduler');
    const { FakeTransport } = require('./helpers/fake-transport');
    const { db } = createTestDb({ tables: ['stations'] });

    const scheduler = new SyncScheduler(db, new FakeTransport(), {
      getStationId: () => '1',
      uuidIdentity: false,
    });

    const before = scheduler._engine;
    expect(scheduler._engineOpts.uuidIdentity).toBe(false);

    const r = scheduler.setUuidIdentity(true);
    expect(r).toEqual({ changed: true, uuidIdentity: true });
    expect(scheduler._engineOpts.uuidIdentity).toBe(true);
    expect(scheduler._engine).not.toBe(before);          // a NEW engine, carrying the new opt

    // Idempotent: setting the same value again is a no-op and does not churn the engine.
    const same = scheduler._engine;
    expect(scheduler.setUuidIdentity(true)).toEqual({ changed: false, uuidIdentity: true });
    expect(scheduler._engine).toBe(same);

    db.close();
  });
});
