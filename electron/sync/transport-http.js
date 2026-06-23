'use strict';
// electron/sync/transport-http.js — HTTP transport per protocol doc §21 [N-113].
//
// First concrete EtherTransport implementation. Calls the Railway backend.
// Uses native fetch (Node 24 / Electron 41). No network imports beyond fetch.
//
// Auth: x-license-key header; key read from station_config_kv at first call [N-116].
// Retry: exponential backoff on 5xx, up to 4 attempts [N-95].
//
// Pull cursor strategy: backend assigns a server_seq (BIGSERIAL) to each stored
// mutation. The transport tracks the max server_seq seen and sends it as
// since_seq on the next pull. This is simpler and more efficient than the
// per-client HLC cursor the merge engine uses internally; the engine-level
// cursor is still maintained by SyncEngine for LWW semantics [N-96..N-99].

const { EtherTransport } = require('./transport');

const RETRY_DELAYS_MS = [500, 1000, 2000, 4000];   // 4 attempts max [N-95]
const SERVER_SEQ_KEY  = 'sync_server_seq';

class HttpTransport extends EtherTransport {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} [opts]
   * @param {string} [opts.baseUrl]     backend root URL (no trailing slash)
   *                                    defaults to process.env.ETHER_SYNC_URL
   * @param {string} [opts.licenseKey]  pre-resolved license key;
   *                                    if omitted, resolved from station_config_kv
   */
  constructor(db, opts = {}) {
    super();
    this._db = db;
    this._baseUrl = (opts.baseUrl || process.env.ETHER_SYNC_URL || '').replace(/\/$/, '');
    if (!this._baseUrl) {
      throw new Error(
        'HttpTransport: baseUrl required — pass opts.baseUrl or set ETHER_SYNC_URL [N-113]'
      );
    }
    this._licenseKey = opts.licenseKey ?? null;
    // Member peer-sync (desktop member-sync bridge): when set, authorize as a MEMBER of ANOTHER
    // account with a Bearer token instead of this install's x-license-key. Default null → owner
    // install, byte-for-byte unchanged. The backend gate (RBAC_MEMBERSHIP_SYNC) accepts this token.
    this._memberToken = opts.memberToken ?? null;
    // Per-context pull cursor key. A member sync must NOT share the owner sync's 'sync_server_seq'
    // (they would clobber each other's high-water mark). Owner install defaults to the legacy key.
    this._serverSeqKey = opts.cursorKey || SERVER_SEQ_KEY;
    this._serverSeq  = this._loadServerSeq();
  }

  // ── EtherTransport interface ───────────────────────────────────────────────

  /**
   * Push pending local mutations to the backend [§17].
   * @param {object} batch  PushBatch: { client_id, station_id, batch: WireMutation[] }
   * @returns {Promise<{accepted: string[], rejected: Array<{id,reason}>}>}
   */
  async push(batch) {
    const result = await this._fetchWithRetry('POST', '/sync/mutations', batch);
    return {
      accepted: result.accepted ?? [],
      rejected: result.rejected ?? [],
    };
  }

  /**
   * Fetch mutations this client has not yet seen [§18].
   * @param {object} cursor  SyncCursor: { client_id, station_id, cursor }
   * @returns {Promise<{mutations: WireMutation[], server_hlc: string|null}>}
   */
  async pull(cursor) {
    const { client_id, station_id = null, station_uuid = null } = cursor;
    const params = new URLSearchParams({
      client_id,
      since_seq: String(this._serverSeq),
    });
    if (station_id) params.set('station_id', station_id);
    // UUID-identity (Tier-2): when present, the backend scopes station rows by stable station_uuid
    // instead of the local integer station_id. Absent for legacy clients → unchanged scoping.
    if (station_uuid) params.set('station_uuid', station_uuid);

    const result = await this._fetchWithRetry('GET', '/sync/mutations?' + params.toString());

    // Advance our server_seq pointer so the next pull is incremental
    const newSeq = Number(result.server_seq ?? 0);
    if (newSeq > this._serverSeq) this._saveServerSeq(newSeq);

    return {
      mutations:  result.mutations  ?? [],
      server_hlc: result.server_hlc ?? null,
    };
  }

  /**
   * Ping the backend [N-114].
   * @returns {Promise<{ok: boolean, latencyMs: number}>}
   */
  async healthCheck() {
    const t0 = Date.now();
    await this._fetchWithRetry('GET', '/health');
    return { ok: true, latencyMs: Date.now() - t0 };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  _getLicenseKey() {
    if (this._licenseKey) return this._licenseKey;
    // License key is stored in station_config_kv under 'license_key' [N-116]
    const row = this._db
      .prepare("SELECT value FROM station_config_kv WHERE key = 'license_key' LIMIT 1")
      .get();
    if (row?.value) {
      this._licenseKey = row.value;
      return this._licenseKey;
    }
    throw new Error(
      'HttpTransport: license_key not found in station_config_kv [N-116]' +
      ' — activate a license before syncing'
    );
  }

  // Re-baseline (Tier-2): reset the pull high-water mark to 0 so the next pulls re-fetch the full
  // history under the current (UUID-identity) scoping — delivering station rows a divergent install
  // previously missed under legacy local-integer scoping. Already-applied mutations are idempotent on
  // re-apply (merge Step 1), so this corrects/augments without disturbing existing rows.
  resetCursor() { this._saveServerSeq(0); }

  _loadServerSeq() {
    const row = this._db
      .prepare(`SELECT value FROM system_state WHERE key = ?`)
      .get(this._serverSeqKey);
    return parseInt(row?.value ?? '0', 10) || 0;
  }

  _saveServerSeq(seq) {
    const val    = String(seq);
    const exists = this._db
      .prepare(`SELECT 1 FROM system_state WHERE key = ?`)
      .get(this._serverSeqKey);
    if (exists) {
      this._db
        .prepare(`UPDATE system_state SET value = ?, updated_at = ? WHERE key = ?`)
        .run(val, new Date().toISOString(), this._serverSeqKey);
    } else {
      this._db
        .prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)`)
        .run(this._serverSeqKey, val, new Date().toISOString());
    }
    this._serverSeq = seq;
  }

  /**
   * HTTP request with exponential backoff on 5xx [N-95].
   * Throws immediately on 4xx (client errors are not retried).
   */
  async _fetchWithRetry(method, path, body = null) {
    const url  = this._baseUrl + path;
    // Member peer-sync uses a Bearer token (no license key); owner installs use x-license-key as
    // before. Only one of the two is ever sent — the default path is unchanged.
    const hdrs = { 'Content-Type': 'application/json' };
    if (this._memberToken) hdrs['Authorization'] = 'Bearer ' + this._memberToken;
    else hdrs['x-license-key'] = this._getLicenseKey();

    let lastErr;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
      }

      let res;
      try {
        res = await fetch(url, {
          method,
          headers: hdrs,
          body:    body !== null ? JSON.stringify(body) : undefined,
        });
      } catch (netErr) {
        lastErr = new Error('HttpTransport: network error — ' + netErr.message + ' [N-117]');
        if (attempt < RETRY_DELAYS_MS.length) continue;
        throw lastErr;
      }

      if (res.ok) return res.json();

      // 4xx → do not retry; surface immediately [N-95]
      if (res.status >= 400 && res.status < 500) {
        let detail = '';
        try { detail = ' — ' + ((await res.json()).error ?? ''); } catch (_) {}
        const err = new Error(
          'HttpTransport: HTTP ' + res.status + ' ' + method + ' ' + path + detail + ' [N-117]'
        );
        err.status = res.status;
        throw err;
      }

      // 5xx → retry
      lastErr = new Error('HttpTransport: HTTP ' + res.status + ' ' + method + ' ' + path);
      if (attempt < RETRY_DELAYS_MS.length) continue;
    }

    throw lastErr ?? new Error('HttpTransport: exhausted retries [N-95]');
  }
}

module.exports = { HttpTransport };
