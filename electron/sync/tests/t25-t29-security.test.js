'use strict';
// T-25..T-29 — Security and filter tests per sync-protocol-v0.md §23 Category F

const { createTestDb } = require('./helpers/create-test-db');
const { makeWireMutation, resetHlcCounter } = require('./helpers/wire-mutation');
const { FakeTransport } = require('./helpers/fake-transport');
const { MergeEngine } = require('../merge-engine');
const { SyncEngine } = require('../sync-engine');
const { serializePayload, _resetForTest } = require('../mutation-writer');
const { v4: uuidv4 } = require('uuid');

// ── Helper: seed a raw pending mutation row directly into the mutations table ──
//
// Used by T-25/T-26 to plant excluded-table mutations without going through
// withMutation (which would also try to write a live-table row for the table,
// and excluded tables like install_secrets_kv and monitor_routing are not
// set up as live application tables in the test DB).
function seedPending(db, tableName, id = uuidv4()) {
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
    tableName, rowId, 'insert',
    null, JSON.stringify({ id: 1, uuid: rowId }),
    now, now, `1700000000000:0:${cli}`,
    null, 16, 'local', 'pending', null
  );
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('F: Security and filter tests', () => {
  let db, clientId;

  beforeEach(() => {
    _resetForTest();
    resetHlcCounter();
    ({ db, clientId } = createTestDb());
  });

  afterEach(() => {
    db.close();
  });

  // ── T-25 ──────────────────────────────────────────────────────────────────

  it('T-25: push batch excludes install_secrets_kv — syncExcluded:true [N-92]', async () => {
    const transport = new FakeTransport();
    const engine    = new SyncEngine(db, transport);

    const secretId = seedPending(db, 'install_secrets_kv');
    const albumId  = seedPending(db, 'albums');

    await engine.push();

    const storedIds     = transport._store.map(m => m.id);
    const storedTables  = transport._store.map(m => m.table_name);

    // Non-excluded table must reach the transport
    expect(storedIds).toContain(albumId);

    // Secrets must never leave the device [N-92]
    expect(storedIds).not.toContain(secretId);
    expect(storedTables).not.toContain('install_secrets_kv');
  });

  // ── T-26 ──────────────────────────────────────────────────────────────────

  it('T-26: push batch excludes monitor_routing — scope:local-only [N-92]', async () => {
    const transport = new FakeTransport();
    const engine    = new SyncEngine(db, transport);

    const routingId = seedPending(db, 'monitor_routing');
    const albumId   = seedPending(db, 'albums');

    await engine.push();

    const storedIds    = transport._store.map(m => m.id);
    const storedTables = transport._store.map(m => m.table_name);

    expect(storedIds).toContain(albumId);

    // Local-only routing config must not propagate to other clients [N-92]
    expect(storedIds).not.toContain(routingId);
    expect(storedTables).not.toContain('monitor_routing');
  });

  // ── T-27 ──────────────────────────────────────────────────────────────────

  it('T-27: rtmp_destinations payload — stream_key absent (local-only) [N-24]/[N-25]', () => {
    const now   = new Date().toISOString();
    const rowId = uuidv4();

    const row = {
      id:         1,
      uuid:       rowId,
      name:       'YouTube Live',
      url:        'rtmp://a.rtmp.youtube.com/live2',
      stream_key: 'SUPER_SECRET_KEY',   // local-only — must be stripped [N-24]
      is_active:  1,
      station_id: '1',
      created_at: now,
      updated_at: null,
      deleted_at: null,
    };

    const payload = serializePayload(row, 'rtmp_destinations');

    // Credential column must be absent from the payload envelope [N-24]/[N-25]
    expect('stream_key' in payload).toBe(false);

    // Non-sensitive columns pass through unchanged
    expect(payload.name).toBe('YouTube Live');
    expect(payload.url).toBe('rtmp://a.rtmp.youtube.com/live2');
    expect(payload.is_active).toBe(1);
  });

  // ── T-28 ──────────────────────────────────────────────────────────────────

  it('T-28: stations payload — icecast_password and mount_pending_provision absent [N-24]/[N-25]', () => {
    const now   = new Date().toISOString();
    const rowId = uuidv4();

    const row = {
      id:                      1,
      uuid:                    rowId,
      name:                    'WRDK-FM',
      callsign:                'WRDK',
      frequency:               '99.1',
      city:                    'Boston',
      state:                   'MA',
      country:                 'US',
      website:                 null,
      is_active:               1,
      icecast_server_url:      'http://stream.example.com:8000',
      icecast_mount:           '/live',
      icecast_password:        'hunter2',   // local-only — must be stripped [N-24]
      icecast_bitrate:         128,
      icecast_format:          'mp3',
      icecast_port:            8000,
      audio_device_output:     null,
      mic_device:              null,
      mount_pending_provision: 1,           // local-only — must be stripped [N-24]
      created_at:              now,
      updated_at:              null,
      deleted_at:              null,
    };

    const payload = serializePayload(row, 'stations');

    // Both credential/per-machine columns must be absent [N-24]/[N-25]
    expect('icecast_password' in payload).toBe(false);
    expect('mount_pending_provision' in payload).toBe(false);

    // Non-sensitive columns present
    expect(payload.name).toBe('WRDK-FM');
    expect(payload.icecast_server_url).toBe('http://stream.example.com:8000');
    expect(payload.icecast_mount).toBe('/live');
  });

  // ── T-29 ──────────────────────────────────────────────────────────────────

  it('T-29: remote install_secrets_kv mutation — Step 2 rejects; error logged; cursor does not advance [N-101]', () => {
    const cursorCalls = [];
    const engine = new MergeEngine(db, {
      localSchemaVersion: 16,
      causalQueue: { hold: () => {} },
      onCursorAdvance: (cid, hlc) => cursorCalls.push({ cid, hlc }),
    });

    const errorSpy = vi.spyOn(console, 'error');

    const m = makeWireMutation({
      table_name:    'install_secrets_kv',
      row_id:        uuidv4(),
      op:            'insert',
      payload_before: null,
      payload_after:  { key: 'license_key', value: 'ETHER-OWNER-2026' },
    });

    const result = engine.apply(m);

    // Step 2 filter fires for syncExcluded tables [N-101]
    expect(result).toBe('rejected');

    // Protocol violation logged as error [N-101]
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('install_secrets_kv')
    );

    // Cursor must NOT advance — rejected path returns before _advanceCursor [N-101]
    expect(cursorCalls).toHaveLength(0);

    // Mutation must NOT be written to mutations log — discarded without logging
    const logRow = db.prepare('SELECT id FROM mutations WHERE id = ?').get(m.id);
    expect(logRow).toBeUndefined();
  });
});
