'use strict';
// electron/sync/sync-scheduler.js — polling orchestrator for the push/pull/merge cycle.
//
// Wraps SyncEngine.syncCycle() behind a configurable timer.
// Default interval: 5 000 ms per protocol doc §15.
// Override: station_config_kv key 'sync_interval_ms' (minimum 1 000 ms).
//
// Backoff schedule on consecutive errors [N-95]:
//   1 failure → wait 10s, 2 → 30s, 3 → 60s, ≥4 → 60s
// Auth errors (4xx) use the same backoff — bad license = keep waiting, not crash.
//
// Power events: pause() on suspend/lock, resume() on resume/unlock.
// Stats: pushedToday / pulledToday reset at midnight; lastSyncAt in ISO-8601.

const { SyncEngine } = require('./sync-engine');

const DEFAULT_INTERVAL_MS = 5_000;
const BACKOFF_MS = [10_000, 30_000, 60_000]; // indexed by (failures - 1), capped at last

class SyncScheduler {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {import('./transport').EtherTransport} transport
   * @param {object} [opts]  forwarded to SyncEngine constructor
   */
  constructor(db, transport, opts = {}) {
    this._db        = db;
    this._transport = transport;
    this._engine    = new SyncEngine(db, transport, opts);
    this._timer     = null;
    this._running   = false;
    this._paused    = false;
    this._failures  = 0;

    this._stats = {
      pushedToday: 0,
      pulledToday: 0,
      lastSyncAt:  null,
    };
    this._statsDate = new Date().toDateString();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running = true;
    console.log('[SYNC] scheduler started (interval=' + this._getInterval() + 'ms)');
    this._schedule();
  }

  stop() {
    this._running = false;
    this._clearTimer();
    console.log('[SYNC] scheduler stopped');
  }

  pause() {
    if (this._paused) return;
    this._paused = true;
    this._clearTimer();
    console.log('[SYNC] paused');
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    console.log('[SYNC] resumed');
    if (this._running) this._schedule();
  }

  /** @returns {{ pushedToday: number, pulledToday: number, lastSyncAt: string|null }} */
  getStats() {
    return { ...this._stats };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  _clearTimer() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _getInterval() {
    try {
      const row = this._db.prepare(
        "SELECT value FROM station_config_kv WHERE key = 'sync_interval_ms' LIMIT 1"
      ).get();
      const v = parseInt(row?.value, 10);
      return v >= 1_000 ? v : DEFAULT_INTERVAL_MS;
    } catch (_) {
      return DEFAULT_INTERVAL_MS;
    }
  }

  _schedule() {
    if (!this._running || this._paused) return;
    const delay = this._failures > 0
      ? BACKOFF_MS[Math.min(this._failures - 1, BACKOFF_MS.length - 1)]
      : this._getInterval();
    this._timer = setTimeout(() => this._tick(), delay);
  }

  async _tick() {
    if (!this._running || this._paused) return;

    // Reset daily stats at midnight
    const today = new Date().toDateString();
    if (today !== this._statsDate) {
      this._stats.pushedToday = 0;
      this._stats.pulledToday = 0;
      this._statsDate = today;
    }

    try {
      const { push, pull } = await this._engine.syncCycle();

      const pushed  = push.accepted ?? 0;
      const pulled  = pull.pulled   ?? 0;
      const applied = pull.applied  ?? 0;

      this._stats.pushedToday += pushed;
      this._stats.pulledToday += pulled;
      this._stats.lastSyncAt   = new Date().toISOString();

      if (pushed > 0 || pulled > 0) {
        console.log(`[SYNC] tick: pulled ${pulled}, applied ${applied}, pushed ${pushed}`);
      }

      this._failures = 0;
    } catch (e) {
      this._failures++;
      const delay = BACKOFF_MS[Math.min(this._failures - 1, BACKOFF_MS.length - 1)];
      console.warn(`[SYNC] tick error (attempt ${this._failures}, backoff ${delay}ms): ${e.message}`);
    }

    this._schedule();
  }
}

module.exports = { SyncScheduler };
