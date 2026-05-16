'use strict';
// T-05..T-10 — Writer unit tests per sync-protocol-v0.md §23 Category B

const { createTestDb } = require('./helpers/create-test-db');
const {
  toWireFormat,
  serializePayload,
  deserializePayload,
  withMutation,
  _resetForTest,
} = require('../mutation-writer');
const { v4: uuidv4 } = require('uuid');

// ─────────────────────────────────────────────────────────────────────────────

describe('B: Writer unit tests', () => {
  let db, clientId;

  beforeEach(() => {
    _resetForTest();
    ({ db, clientId } = createTestDb());
  });

  afterEach(() => {
    db.close();
  });

  // ── T-05 ──────────────────────────────────────────────────────────────────

  it('T-05: toWireFormat — exactly 14 fields; applied_at/origin/sync_status absent', () => {
    const rowId = uuidv4();
    const row17 = {
      id:                  uuidv4(),
      client_id:           clientId,
      station_id:          null,
      actor_id:            null,
      table_name:          'albums',
      row_id:              rowId,
      op:                  'insert',
      payload_before:      null,
      // DB stores payloads as JSON strings; toWireFormat must parse them [N-51]
      payload_after:       JSON.stringify({ id: 1, uuid: rowId, title: 'Blue Train' }),
      created_at:          '2024-01-01T00:00:00.000Z',
      applied_at:          '2024-01-01T00:00:00.000Z',  // LOCAL-ONLY — must be stripped
      hlc:                 '1700000000000:0:' + clientId,
      parent_mutation_id:  null,
      schema_version:      16,
      origin:              'local',    // LOCAL-ONLY — must be stripped
      sync_status:         'pending',  // LOCAL-ONLY — must be stripped
      conflict_resolution: null,
    };

    const wire = toWireFormat(row17);

    expect(Object.keys(wire)).toHaveLength(14);
    expect(wire).not.toHaveProperty('applied_at');
    expect(wire).not.toHaveProperty('origin');
    expect(wire).not.toHaveProperty('sync_status');

    // Core fields must pass through unchanged
    expect(wire.id).toBe(row17.id);
    expect(wire.table_name).toBe('albums');
    expect(wire.op).toBe('insert');
    expect(wire.hlc).toBe(row17.hlc);
    expect(wire.schema_version).toBe(16);
    expect(wire.payload_before).toBeNull();

    // Payload parsed to object, not a raw JSON string [N-51]
    expect(typeof wire.payload_after).toBe('object');
    expect(wire.payload_after.title).toBe('Blue Train');
  });

  // ── T-06 ──────────────────────────────────────────────────────────────────

  it('T-06: serializePayload / deserializePayload round-trip for scalar column', () => {
    const uuid = uuidv4();
    const row = {
      id:         1,
      uuid,
      title:      'Blue Train',
      artist_id:  42,
      year:       1957,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: null,
      deleted_at: null,
    };

    const payload  = serializePayload(row, 'albums');
    const restored = deserializePayload(payload, 'albums');

    expect(restored.title).toBe('Blue Train');
    expect(restored.year).toBe(1957);
    expect(restored.artist_id).toBe(42);
    expect(restored.uuid).toBe(uuid);
    expect(restored.updated_at).toBeNull();
    // Scalar columns survive round-trip identically
    expect(restored.created_at).toBe('2024-01-01T00:00:00.000Z');
  });

  // ── T-07 ──────────────────────────────────────────────────────────────────

  it('T-07: serializePayload / deserializePayload round-trip for json-text column', () => {
    // format_clocks.slots_json is json-text; format_clocks.slots is local-only [N-24]
    const slots = [{ type: 'music', duration_min: 4 }, { type: 'spot' }];
    const row = {
      id:         1,
      name:       'Morning Clock',
      slots:      null,              // local-only — must not appear in payload
      created_at: '2024-01-01T00:00:00.000Z',
      daypart:    null,
      slots_json: JSON.stringify(slots),  // DB stores as TEXT
      station_id: '1',
      uuid:       uuidv4(),
      updated_at: null,
      deleted_at: null,
    };

    const payload = serializePayload(row, 'format_clocks');

    // After serialize: json-text column is a parsed object — not a double-encoded string [N-17]
    expect(typeof payload.slots_json).toBe('object');
    expect(Array.isArray(payload.slots_json)).toBe(true);
    expect(payload.slots_json[0].type).toBe('music');
    expect(payload.slots_json[1].type).toBe('spot');

    // local-only column absent from payload [N-25]
    expect('slots' in payload).toBe(false);

    const restored = deserializePayload(payload, 'format_clocks');

    // After deserialize: json-text is stringified back to TEXT for DB storage
    expect(typeof restored.slots_json).toBe('string');
    const roundTripped = JSON.parse(restored.slots_json);
    expect(roundTripped).toEqual(slots);
  });

  // ── T-08 ──────────────────────────────────────────────────────────────────

  it('T-08: serializePayload on blob-ref column produces {__blob_ref, __blob_size, __blob_origin}', () => {
    const filePath = '/audio/jingle.mp3';
    const row = {
      id:             1,
      title:          'Morning Jingle',
      file_path:      filePath,   // blob-ref column [N-22]
      trigger_time:   null,
      days:           null,
      duck_music:     null,
      resume_music:   null,
      duck_level:     null,
      is_active:      1,
      last_played_at: null,
      created_at:     '2024-01-01T00:00:00.000Z',
      station_id:     '1',
      uuid:           uuidv4(),
      updated_at:     null,
      deleted_at:     null,
    };

    const payload = serializePayload(row, 'announcements');

    // blob-ref must be wrapped as the 3-key envelope [N-22]/[N-23]
    expect(typeof payload.file_path).toBe('object');
    expect(payload.file_path.__blob_ref).toBe(filePath);
    expect(payload.file_path.__blob_size).toBeNull();
    expect(payload.file_path.__blob_origin).toBe(filePath);

    // Round-trip via deserializePayload restores the original path string
    const restored = deserializePayload(payload, 'announcements');
    expect(restored.file_path).toBe(filePath);
  });

  // ── T-09 ──────────────────────────────────────────────────────────────────

  it('T-09: withMutation — dataOpFn throws — no mutation row written; DB state unchanged', () => {
    const countBefore = db.prepare('SELECT COUNT(*) AS n FROM mutations').get().n;

    expect(() => {
      withMutation(
        db,
        {
          table_name:     'albums',
          row_id:         uuidv4(),
          op:             'insert',
          payload_before: null,
          payload_after:  { id: 1, uuid: uuidv4(), title: 'Should Not Exist' },
          station_id:     null,
        },
        () => { throw new Error('deliberate dataOpFn failure'); }
      );
    }).toThrow('deliberate dataOpFn failure');

    // Transaction must have rolled back — no mutation logged [N-36]
    const countAfter = db.prepare('SELECT COUNT(*) AS n FROM mutations').get().n;
    expect(countAfter).toBe(countBefore);
  });

  // ── T-10 ──────────────────────────────────────────────────────────────────

  it('T-10: withMutation — null payload_before for op=update — throws; no mutation row written', () => {
    const countBefore = db.prepare('SELECT COUNT(*) AS n FROM mutations').get().n;

    // op=update requires payload_before [N-30]; omitting it is a logic bug upstream.
    // logMutation must throw inside the transaction, rolling back fn's effects [N-36].
    expect(() => {
      withMutation(
        db,
        {
          table_name:     'albums',
          row_id:         uuidv4(),
          op:             'update',
          payload_before: null,   // invalid — must be the pre-update row snapshot
          payload_after:  { id: 1, uuid: uuidv4(), title: 'Updated Title' },
          station_id:     null,
        },
        () => {}  // fn succeeds; logMutation throws afterward, rolling back the txn
      );
    }).toThrow();

    // No mutation row must exist — rollback succeeded [N-36]
    const countAfter = db.prepare('SELECT COUNT(*) AS n FROM mutations').get().n;
    expect(countAfter).toBe(countBefore);
  });
});
