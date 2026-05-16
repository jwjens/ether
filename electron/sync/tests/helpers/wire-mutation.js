'use strict';
// electron/sync/tests/helpers/wire-mutation.js
//
// Factory for 14-field wire-format mutations used in sync tests.
//
// makeWireMutation(overrides) returns a valid WireMutation with safe defaults.
// Any field can be overridden. row_id is shared with payload_after.uuid by
// default so INSERT and UPDATE apply correctly in the merge-engine.
//
// makeHlc(clientId, wallMs?) — produce a deterministic HLC string.
// resetHlcCounter()          — reset the logical counter between test files.

const { v4: uuidv4 } = require('uuid');

// Module-level counter so successive makeHlc() calls within one test are
// ordered without relying on wall-clock precision.
let _counter = 0;

/**
 * Build a WireMutation with all 14 wire fields populated.
 * Defaults produce a valid insert on the `albums` table.
 *
 * Important: if you override op='update' or op='delete', also override
 * payload_before/payload_after as required by the protocol:
 *   insert: payload_before = null, payload_after = <row>
 *   update: both populated
 *   delete: payload_before = <row>, payload_after = null
 *
 * @param {object} [overrides]
 * @returns {object} 14-field wire mutation
 */
function makeWireMutation(overrides = {}) {
  const clientId = uuidv4();
  const rowId    = uuidv4();
  const now      = new Date().toISOString();
  const hlc      = makeHlc(clientId);

  const defaultPayloadAfter = {
    id:         1,
    uuid:       rowId,   // uuid matches row_id so UPDATE WHERE uuid = ? works
    title:      'Test Album',
    artist_id:  null,
    year:       null,
    created_at: now,
    updated_at: null,
    deleted_at: null,
  };

  const base = {
    id:                  uuidv4(),
    client_id:           clientId,
    station_id:          null,          // install-scoped [N-89]
    actor_id:            null,
    table_name:          'albums',
    row_id:              rowId,
    op:                  'insert',
    payload_before:      null,          // null for insert [N-29]
    payload_after:       defaultPayloadAfter,
    created_at:          now,
    hlc,
    parent_mutation_id:  null,
    schema_version:      16,
    conflict_resolution: null,
  };

  // Merge overrides. If caller supplies a different row_id but no payload_after,
  // patch payload_after.uuid to stay consistent.
  const merged = { ...base, ...overrides };
  if (
    overrides.row_id &&
    !overrides.payload_after &&
    merged.op === 'insert' &&
    merged.payload_after
  ) {
    merged.payload_after = { ...merged.payload_after, uuid: overrides.row_id };
  }

  return merged;
}

/**
 * Build an HLC string for a given client_id.
 * Uses a module-level counter as the logical component so calls within a
 * single test are ordered without depending on wall-clock milliseconds.
 *
 * @param {string} clientId
 * @param {number} [wallMs=Date.now()]
 * @returns {string}  "<wallMs>:<counter>:<clientId>"
 */
function makeHlc(clientId, wallMs = Date.now()) {
  return `${wallMs}:${_counter++}:${clientId}`;
}

/**
 * Reset the HLC logical counter. Call in afterEach to keep counters
 * deterministic across test files.
 */
function resetHlcCounter() {
  _counter = 0;
}

module.exports = { makeWireMutation, makeHlc, resetHlcCounter };
