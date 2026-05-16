'use strict';
// T-36..T-38 — Schema compatibility tests per sync-protocol-v0.md §23 Category I

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const { createTestDb } = require('./helpers/create-test-db');
const { makeWireMutation, resetHlcCounter } = require('./helpers/wire-mutation');
const { MergeEngine } = require('../merge-engine');
const { setScriptsDir, clearCache } = require('../transformer-chain');
const { _resetForTest } = require('../mutation-writer');
const { v4: uuidv4 } = require('uuid');

const causalQueue = { hold: () => {} };

function makeEngine(db, localSchemaVersion, cursorCalls = []) {
  return new MergeEngine(db, {
    localSchemaVersion,
    causalQueue,
    onCursorAdvance: (cid, hlc) => cursorCalls.push({ cid, hlc }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('I: Schema compatibility tests', () => {
  let db, clientId;
  let tmpDir = null;

  beforeEach(() => {
    _resetForTest();
    resetHlcCounter();
    ({ db, clientId } = createTestDb());
  });

  afterEach(() => {
    db.close();
    // Restore transformer-chain to production state regardless of which test ran.
    setScriptsDir(null);
    clearCache();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  // ── T-36 ──────────────────────────────────────────────────────────────────

  it('T-36: mutation at schema_version N-1 received by N-local — transformer chain runs; applied to live table [N-62]', () => {
    // Local schema is 16; incoming mutation carries schema_version 15.
    // The v16 migration's payloadTransformer (identity) runs, then the
    // mutation is applied as a normal LWW winner.
    const engine = makeEngine(db, 16);

    const rowId = uuidv4();
    const now   = new Date().toISOString();
    const m = makeWireMutation({
      schema_version: 15,   // one behind local — triggers backward-compat transform [N-62]
      row_id:         rowId,
      payload_after:  { id: 1, uuid: rowId, title: 'Pre-Migration Row',
                        artist_id: null, year: null, created_at: now,
                        updated_at: null, deleted_at: null },
    });

    const result = engine.apply(m);

    // Transformer chain ran and did not conflict — mutation applied
    expect(result).toBe('applied');

    // Row present in live albums table — transformer + LWW path completed [N-62]
    const liveRow = db.prepare('SELECT title FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow).not.toBeUndefined();
    expect(liveRow.title).toBe('Pre-Migration Row');

    // Mutation logged as synced (not conflicted, not quarantined)
    const logRow = db.prepare('SELECT sync_status FROM mutations WHERE id = ?').get(m.id);
    expect(logRow?.sync_status).toBe('synced');
  });

  // ── T-37 ──────────────────────────────────────────────────────────────────

  it('T-37: mutation at schema_version N+1 received by N-local — quarantined; not in mutations; cursor advances [N-64]', () => {
    const cursorCalls = [];
    const engine = makeEngine(db, 16, cursorCalls);

    const rowId = uuidv4();
    const now   = new Date().toISOString();
    const m = makeWireMutation({
      schema_version: 17,   // one ahead of local — forward-compat quarantine [N-64]
      row_id:         rowId,
      payload_after:  { id: 1, uuid: rowId, title: 'Future Row',
                        artist_id: null, year: null, created_at: now,
                        updated_at: null, deleted_at: null },
    });

    const result = engine.apply(m);

    // Step 3 fires the quarantine path [N-64]
    expect(result).toBe('quarantined');

    // Cursor must advance — caller's pull loop can move on [N-64]
    expect(cursorCalls).toHaveLength(1);

    // Mutation in quarantine_mutations, not in mutations table [N-64]
    const qRow = db.prepare(
      'SELECT id, foreign_schema_version FROM quarantine_mutations WHERE id = ?'
    ).get(m.id);
    expect(qRow).not.toBeUndefined();
    expect(qRow.foreign_schema_version).toBe(17);

    const mRow = db.prepare('SELECT id FROM mutations WHERE id = ?').get(m.id);
    expect(mRow).toBeUndefined();

    // Row must NOT be in the live albums table — not applied [N-64]
    const liveRow = db.prepare('SELECT id FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow).toBeUndefined();
  });

  // ── T-38 ──────────────────────────────────────────────────────────────────

  it('T-38: transformer throws during backward-compat replay — sync_status=conflicted; live table unchanged [N-63]', () => {
    // Inject a scripts directory containing a v16 transformer that always throws.
    // setScriptsDir() + clearCache() force re-discovery from the fake dir.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'migrate-test-phase-sync-16.js'),
      [
        "'use strict';",
        "module.exports = {",
        "  payloadTransformer: function() {",
        "    throw new Error('deliberate transformer failure for T-38');",
        "  }",
        "};",
      ].join('\n')
    );
    setScriptsDir(tmpDir);
    clearCache();

    const errorSpy = vi.spyOn(console, 'error');
    const engine = makeEngine(db, 16);

    const rowId = uuidv4();
    const now   = new Date().toISOString();
    const m = makeWireMutation({
      schema_version: 15,   // one behind — triggers transformer chain (which will throw) [N-62]
      row_id:         rowId,
      payload_after:  { id: 1, uuid: rowId, title: 'Should Not Apply',
                        artist_id: null, year: null, created_at: now,
                        updated_at: null, deleted_at: null },
    });

    const result = engine.apply(m);

    // Transformer threw → conflicted path [N-63]
    expect(result).toBe('conflicted');

    // Error logged with mutation id [N-63]
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('transformer chain failed')
    );
    expect(errorSpy.mock.calls[0][0]).toContain(m.id);

    // Mutation logged as conflicted — not silently dropped
    const logRow = db.prepare('SELECT sync_status FROM mutations WHERE id = ?').get(m.id);
    expect(logRow?.sync_status).toBe('conflicted');

    // Live table must be unchanged — no apply step on conflicted path [N-63]
    const liveRow = db.prepare('SELECT id FROM albums WHERE uuid = ?').get(rowId);
    expect(liveRow).toBeUndefined();
  });
});
