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

// Persisted in system_state. Set to '1' the first time pull() returns
// pulled === 0, then never cleared. Survives app restarts so interrupted
// initial-bulk-pulls resume correctly: a second session with non-empty
// cursor still emits sync:initial-complete on the next drain to zero.
const INITIAL_DRAINED_KEY = 'sync_initial_drained';

class SyncScheduler {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {import('./transport').EtherTransport} transport
   * @param {object} [opts]  forwarded to SyncEngine constructor (less onProgress,
   *                         which scheduler manages internally so it can broadcast
   *                         sync:progress to all renderer windows).
   */
  constructor(db, transport, opts = {}) {
    // Accept a Database OR a () => Database getter. The scheduler resolves the live connection via
    // _getDb and REBUILDS its engine (_ensureEngine) if the connection is reopened (restore/self-heal),
    // so the sync stack never runs on a dead handle. Engine/MergeEngine internals are unchanged — they
    // bind to whatever Database they're constructed with, and get a fresh instance on rebuild.
    this._getDb     = (typeof db === 'function') ? db : () => db;
    this._transport = transport;

    // ── Progress tracking (for sync:get-state + sync:initial-complete) ──
    // _initialCompleteSent reflects the persisted flag in system_state at
    // boot. Once true (whether read from disk or set by this session), the
    // initial-complete event never fires again.
    this._initialCompleteSent = this._readInitialDrainedFlag();
    this._appliedTotal        = 0;
    this._byTableTotal        = {};

    // Wrap any caller-supplied onProgress so scheduler also gets per-pull
    // events for accumulation + broadcast. Engine invokes our wrapper, our
    // wrapper invokes the caller's (if any) and does the Electron-side work.
    const callerOnProgress = opts.onProgress ?? null;
    const engineOpts = {
      ...opts,
      onProgress: (event) => {
        this._appliedTotal += event.applied;
        for (const [t, n] of Object.entries(event.byTable || {})) {
          this._byTableTotal[t] = (this._byTableTotal[t] || 0) + n;
        }
        this._broadcast('sync:progress', event);
        if (callerOnProgress) {
          try { callerOnProgress(event); }
          catch (err) { console.error('[sync-scheduler] caller onProgress threw:', err.message); }
        }
      },
    };

    this._engineOpts = engineOpts;                          // kept so _ensureEngine can rebuild
    this._engineConn = this._getDb();                       // the Database the engine is bound to
    this._engine     = new SyncEngine(this._engineConn, transport, engineOpts);
    this._timer    = null;
    this._running  = false;
    this._paused   = false;
    this._failures = 0;

    // On-air predicate (Tier-2 re-baseline safety). Gates ONLY the heavy one-shot corrective re-pull;
    // normal incremental sync always flows. Defaults to never-on-air. _rebaselineInFlight prevents two
    // re-baseline drains from overlapping when start() and a tick both try to drive it.
    this._isOnAir            = opts.isOnAir ?? (() => false);
    this._rebaselineInFlight = false;

    this._stats = {
      pushedToday: 0,
      pulledToday: 0,
      lastSyncAt:  null,
    };
    this._statsDate = new Date().toDateString();
  }

  /**
   * Cumulative progress state for the renderer's sync:get-state IPC. Used by
   * Screen 4 on mount to catch up on events that may have fired before
   * subscription.
   * @returns {{ initialComplete: boolean, appliedTotal: number, byTable: Record<string,number> }}
   */
  getProgressState() {
    return {
      initialComplete: this._initialCompleteSent,
      appliedTotal:    this._appliedTotal,
      byTable:         { ...this._byTableTotal },
    };
  }

  // Live connection, resolved through the injected getter every access (self-heal-aware).
  get _db() { return this._getDb(); }

  // Rebuild the engine if the underlying connection was reopened (restore / self-heal). better-sqlite3
  // prepared statements (cached in the engine + merge engine) are bound to a specific Database, so on a
  // reopen we must construct a fresh engine against the new handle. Cheap pointer compare each call.
  _ensureEngine() {
    const cur = this._getDb();
    if (cur !== this._engineConn) {
      console.warn('[SYNC] db connection changed — rebuilding sync engine against the new handle');
      this._engineConn = cur;
      this._engine = new SyncEngine(cur, this._transport, this._engineOpts);
    }
    return this._engine;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    this._ensureEngine();
    if (this._running) return;
    this._running = true;
    console.log('[SYNC] scheduler started (interval=' + this._getInterval() + 'ms)');
    // Drain quarantine on startup: replay any mutations held for a newer schema
    // that are now compatible after a local schema upgrade. Failures log at ERROR
    // but do not block the sync schedule from starting.
    try {
      const drain = this._engine.drainQuarantine();
      if (drain.drained > 0 || drain.failed > 0) {
        console.log('[SYNC] quarantine drain: drained=' + drain.drained + ' failed=' + drain.failed);
      }
    } catch (err) {
      console.error('[SYNC] quarantine drain failed: ' + err.message);
    }
    // Tier-2 one-shot re-baseline: corrective re-pull under UUID-identity scoping so a divergent
    // install gets station programming it missed under legacy local-integer scoping. Self-skips when
    // uuid-identity is off or already done. Now OFF-AIR-GATED + resumable: it only runs/continues while
    // the station is off air (driven here and re-driven from _tick), so the full-history re-pull burst
    // never fights the audio daemon. Resolve-to-existing-local-ids / no renumber is enforced by merge.
    this._driveRebaseline();
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

  /** MANUAL BY DEFAULT once the install is provisioned (2026-08-14).
   *
   *  This used to tick every 5 seconds forever. Continuous sync between two installs means a change
   *  made on a secondary machine — a wrong delete, a bad edit, a half-finished import — reaches the
   *  main studio machine before anyone notices it was made, and the operator gets no window in which
   *  to catch it. Transfers now happen when a person presses Push Now or Pull Now
   *  (Preferences → Backup & Restore → Multi-Machine Sync).
   *
   *  THE FIRST DRAIN STILL RUNS AUTOMATICALLY. A brand-new install pulls its whole station down from
   *  the cloud on first run, and the onboarding screen waits on `sync:initial-complete` to say so.
   *  Making that manual would strand a new machine on a screen with nothing to press. So the timer
   *  runs until `sync_initial_drained` is set, and stops after.
   *
   *  Set `sync_auto = 'true'` in station_config_kv to restore continuous ticking. */
  _autoTickAllowed() {
    if (!this._readInitialDrainedFlag()) return true;   // first-run pull-down: still automatic
    try {
      const row = this._db.prepare(
        "SELECT value FROM station_config_kv WHERE key = 'sync_auto' AND deleted_at IS NULL LIMIT 1"
      ).get();
      return row?.value === 'true';
    } catch (_) {
      return false;   // unreadable -> manual, the safe direction
    }
  }

  _schedule() {
    if (!this._running || this._paused) return;
    if (!this._autoTickAllowed()) {
      // The engine stays built and reachable — sync:push-now / sync:pull-now still work on demand.
      console.log('[SYNC] manual mode — no automatic cycle (set sync_auto=true to re-enable)');
      return;
    }
    const delay = this._failures > 0
      ? BACKOFF_MS[Math.min(this._failures - 1, BACKOFF_MS.length - 1)]
      : this._getInterval();
    this._timer = setTimeout(() => this._tick(), delay);
  }

  async _tick() {
    if (!this._running || this._paused) return;
    this._ensureEngine();   // rebuild against the live handle if the connection was reopened

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

      // Initial-bulk-pull-complete signal. Fires the first time a pull comes
      // back with zero mutations after the flag has never been set. The flag
      // is persisted, so this fires exactly once per durable lifetime — even
      // if the previous session was interrupted mid-bulk-pull.
      if (!this._initialCompleteSent && pulled === 0) {
        this._writeInitialDrainedFlag();
        this._initialCompleteSent = true;
        this._broadcast('sync:initial-complete');
        console.log('[SYNC] initial bulk pull complete — sync:initial-complete emitted');
      }

      this._failures = 0;
    } catch (e) {
      this._failures++;
      const delay = BACKOFF_MS[Math.min(this._failures - 1, BACKOFF_MS.length - 1)];
      console.warn(`[SYNC] tick error (attempt ${this._failures}, backoff ${delay}ms): ${e.message}`);
    }

    // Resume a pending re-baseline if (and only if) we're now off air. Cheap no-op once done / on air /
    // already running. This is what lets a re-baseline that suspended on-air finish during a quiet window.
    this._driveRebaseline();

    this._schedule();
  }

  // Drive the one-shot Tier-2 re-baseline, off-air-gated and non-overlapping. Fire-and-forget so it never
  // blocks the tick cadence; the engine re-checks on-air between pages and suspends cleanly if the station
  // goes live mid-drain (resuming from the persisted cursor on a later off-air tick).
  _driveRebaseline() {
    if (this._rebaselineInFlight) return;
    if (!this._engine.rebaselinePending()) return;   // uuid-identity off, or already complete
    if (this._isOnAir()) return;                      // stay deferred; normal incremental sync still flows
    this._rebaselineInFlight = true;
    this._engine.rebaseline()
      .then(r => {
        if (!r || r.skipped) return;
        if (r.suspended) console.log(`[SYNC] re-baseline suspended (station went on air) — will resume off air (applied so far=${r.applied})`);
        else console.log(`[SYNC] re-baseline complete: applied=${r.applied} dangling ${r.danglingBefore}→${r.danglingAfter}`);
      })
      .catch(err => console.error('[SYNC] re-baseline failed: ' + err.message))
      .finally(() => { this._rebaselineInFlight = false; });
  }

  // ── Persistence + broadcast helpers ───────────────────────────────────────

  /** Read sync_initial_drained from system_state. Missing/parse-fail returns false. */
  _readInitialDrainedFlag() {
    try {
      const row = this._db.prepare(
        "SELECT value FROM system_state WHERE key = ?"
      ).get(INITIAL_DRAINED_KEY);
      return row?.value === '1';
    } catch (err) {
      console.error('[SYNC] _readInitialDrainedFlag failed:', err.message);
      return false;
    }
  }

  /** Write sync_initial_drained = '1' to system_state. Idempotent. */
  _writeInitialDrainedFlag() {
    try {
      this._db.prepare(
        `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(INITIAL_DRAINED_KEY, '1', new Date().toISOString());
    } catch (err) {
      console.error('[SYNC] _writeInitialDrainedFlag failed:', err.message);
    }
  }

  /**
   * Broadcast an IPC event to every renderer window. Lazy-requires `electron`
   * so the engine module stays importable from non-Electron contexts (test
   * scripts, sync verification scripts). Swallows errors — a failed
   * broadcast must not break the sync cycle.
   */
  _broadcast(channel, payload) {
    try {
      const { BrowserWindow } = require('electron');
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send(channel, payload);
        }
      }
    } catch (err) {
      console.error(`[SYNC] _broadcast(${channel}) failed:`, err.message);
    }
  }
}

module.exports = { SyncScheduler };
