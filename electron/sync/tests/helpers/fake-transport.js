'use strict';
// electron/sync/tests/helpers/fake-transport.js
//
// In-memory EtherTransport used by T-17/T-18 (causal ordering via SyncEngine)
// and available for future integration tests.
//
// Usage:
//   const transport = new FakeTransport();
//   const engine = new SyncEngine(db, transport, { getStationId: () => '1' });
//   await transport.push({ client_id: 'remote', station_id: null, batch: [m1, m2] });
//   await engine.pull();
//   transport.setFailMode('push');  // next push() throws
//
// ── KNOWN LIMITATION: cursor / since_seq is NOT modelled ─────────────────────
//
// pull() ignores the SyncCursor's `cursor` and `since_seq` fields entirely.
// Every call returns the ENTIRE _store (minus the local client's own mutations),
// regardless of how many prior pulls have already processed those mutations.
//
// This is correct for SINGLE-pull-cycle tests (T-17, T-18) where all mutations
// are delivered in one pull() call and MergeEngine's idempotency check (Step 1)
// handles any incidental re-delivery.
//
// DO NOT use FakeTransport for multi-pull-cycle tests without accounting for this.
// A second pull() re-delivers the full store; cursor and heldCount assertions
// become unreliable. Options if you need multi-pull tests:
//   (a) call transport.reset() between pulls to clear the store, or
//   (b) extend FakeTransport with a seq counter that advances per pull() call.

const { EtherTransport } = require('../../transport');

class FakeTransport extends EtherTransport {
  constructor() {
    super();
    this._store    = [];  // all pushed mutations, shared across "peers"
    this._failPush = false;
    this._failPull = false;
  }

  /** Make push, pull, or both throw on next call. Pass null to reset. */
  setFailMode(mode) {
    this._failPush = mode === 'push' || mode === 'both';
    this._failPull = mode === 'pull' || mode === 'both';
  }

  async push(batch) {
    if (this._failPush) throw new Error('FakeTransport: push failed (test-controlled failure)');
    const ids = batch.batch.map(m => m.id);
    this._store.push(...batch.batch);
    return { accepted: ids, rejected: [] };
  }

  async pull({ client_id }) {
    if (this._failPull) throw new Error('FakeTransport: pull failed (test-controlled failure)');
    // Return all mutations not originated by this client (simulate a different peer's writes)
    const mutations = this._store.filter(m => m.client_id !== client_id);
    return { mutations, server_hlc: '0' };
  }

  async healthCheck() {
    return { ok: true, latencyMs: 0 };
  }

  /** Clear the store and reset fail modes. */
  reset() {
    this._store    = [];
    this._failPush = false;
    this._failPull = false;
  }

  get storedCount() { return this._store.length; }
}

module.exports = { FakeTransport };
