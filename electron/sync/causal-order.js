'use strict';
// electron/sync/causal-order.js — in-memory causal hold queue per protocol doc §19 Step 4.
//
// Mutations whose parent_mutation_id has not yet been applied locally are held here
// until their parent arrives and is applied.
//
// [N-103]: hold() called when parent not found in local mutations table.
// [N-104]: release() called after each successful apply; returns held children.
// [N-103]: held >30min → WARNING; held >24h → ERROR. No auto-discard.

class CausalOrderQueue {
  constructor() {
    // Map: parent_mutation_id → WireMutation[]
    this._waitingOn = new Map();
    // Set of held mutation ids — prevents double-adding
    this._heldIds = new Set();
    // Map: mutation.id → hold timestamp (ms) — for stale detection
    this._holdTimes = new Map();
  }

  /**
   * Place a mutation in the hold queue because its parent has not yet arrived.
   * No-op if the mutation is already held (prevents duplicate entries).
   * @param {object} wireMutation  14-field wire-format mutation
   */
  hold(wireMutation) {
    const { id, parent_mutation_id } = wireMutation;
    if (!parent_mutation_id) {
      throw new Error('causal-order: hold() called with null parent_mutation_id [N-103]');
    }
    if (this._heldIds.has(id)) return;

    if (!this._waitingOn.has(parent_mutation_id)) {
      this._waitingOn.set(parent_mutation_id, []);
    }
    this._waitingOn.get(parent_mutation_id).push(wireMutation);
    this._heldIds.add(id);
    this._holdTimes.set(id, Date.now());
  }

  /**
   * Release all mutations waiting on parentId.
   * Removes them from the queue; caller is responsible for applying them.
   * Returns empty array if nothing was waiting.
   * @param {string} parentId  mutation UUID that just applied
   * @returns {object[]}  wire mutations that were waiting on this parent
   */
  release(parentId) {
    const waiting = this._waitingOn.get(parentId);
    if (!waiting || waiting.length === 0) return [];

    this._waitingOn.delete(parentId);
    for (const m of waiting) {
      this._heldIds.delete(m.id);
      this._holdTimes.delete(m.id);
    }
    return waiting;
  }

  /**
   * Returns true if a mutation with this id is currently held.
   * Used by the engine to avoid re-adding on re-delivery [N-100].
   */
  hasHeld(mutationId) {
    return this._heldIds.has(mutationId);
  }

  /** Number of currently held mutations. */
  get heldCount() {
    return this._heldIds.size;
  }

  /**
   * All currently held mutations as a flat array.
   * Useful for logging and diagnostics.
   */
  allHeld() {
    const result = [];
    for (const batch of this._waitingOn.values()) {
      result.push(...batch);
    }
    return result;
  }

  /**
   * Log WARNING / ERROR for mutations held too long per [N-103].
   * Call this periodically from the sync scheduler.
   */
  checkStale() {
    const now = Date.now();
    const WARN_MS  = 30 * 60 * 1000;       // 30 minutes
    const ERROR_MS = 24 * 60 * 60 * 1000;  // 24 hours

    for (const m of this.allHeld()) {
      const heldMs = now - (this._holdTimes.get(m.id) ?? now);
      if (heldMs >= ERROR_MS) {
        console.error(
          '[causal-order] mutation held >24h: id=' + m.id +
          ' parent=' + m.parent_mutation_id + ' [N-103]'
        );
      } else if (heldMs >= WARN_MS) {
        console.warn(
          '[causal-order] mutation held >30min: id=' + m.id +
          ' parent=' + m.parent_mutation_id + ' [N-103]'
        );
      }
    }
  }
}

module.exports = { CausalOrderQueue };
