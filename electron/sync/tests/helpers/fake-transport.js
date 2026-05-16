'use strict';
// electron/sync/tests/helpers/fake-transport.js
//
// In-memory EtherTransport for integration tests beyond T-01..T-38.
// Not used in the 38-test unit suite (all those tests call mergeEngine.apply()
// directly — no transport needed). Built here so future multi-client convergence
// tests have a ready harness.
//
// Usage:
//   const transport = new FakeTransport();
//   const engine = new SyncEngine(db, transport, { getStationId: () => '1' });
//   transport.setFailMode('push');  // next push() throws

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
