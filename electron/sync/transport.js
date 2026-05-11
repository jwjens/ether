'use strict';
// electron/sync/transport.js — transport interface definition per protocol doc §21.
//
// The sync engine calls ONLY the three methods below. Concrete implementations
// (HTTP, P2P) extend EtherTransport. Swapping transports requires changing only
// which implementation is constructed at startup in Stage 4 [N-113].
//
// Auth is the transport's responsibility, not the protocol's [N-116].
// The engine never sees tokens; it receives only resolved PushResult / PullResult.

'use strict';

/**
 * EtherTransport — base class / interface definition.
 *
 * Method signatures are normative per [N-114]/[N-115].
 * Type shapes below use TypeScript-style notation (comments only; file is plain JS).
 *
 * PushBatch = { client_id: string, station_id: string|null, batch: WireMutation[] }
 * PushResult = { accepted: string[], rejected: Array<{id:string, reason:string}> }
 * SyncCursor = { client_id: string, station_id: string|null, cursor: Record<string,string> }
 * PullResult = { mutations: WireMutation[], server_hlc: string }
 * HealthResult = { ok: boolean, latencyMs: number }
 *
 * WireMutation (14 fields, per [N-48]/[N-115]):
 *   id, client_id, station_id, actor_id, table_name, row_id, op,
 *   payload_before, payload_after, created_at, hlc,
 *   parent_mutation_id, schema_version, conflict_resolution
 */
class EtherTransport {
  /**
   * Send pending local mutations to the backend [§17].
   * @param {object} batch  PushBatch
   * @returns {Promise<object>}  PushResult
   * @throws on unrecoverable error [N-117]
   */
  async push(batch) {   // eslint-disable-line no-unused-vars
    throw new Error('transport: push() not implemented — provide a concrete transport [N-114]');
  }

  /**
   * Fetch mutations this client has not yet seen [§18].
   * @param {object} cursor  SyncCursor
   * @returns {Promise<object>}  PullResult
   * @throws on unrecoverable error [N-117]
   */
  async pull(cursor) {  // eslint-disable-line no-unused-vars
    throw new Error('transport: pull() not implemented — provide a concrete transport [N-114]');
  }

  /**
   * Check transport availability [N-114].
   * @returns {Promise<object>}  HealthResult: { ok: boolean, latencyMs: number }
   * @throws on unrecoverable error [N-117]
   */
  async healthCheck() {
    throw new Error('transport: healthCheck() not implemented — provide a concrete transport [N-114]');
  }
}

module.exports = { EtherTransport };
