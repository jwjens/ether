// ── generation-lease — who may auto-generate a station (Phase 1: OBSERVE ONLY) ──────────────────
//
// PHASE 1 ENFORCES NOTHING. _autoExtendTick still runs on every machine with auto_generate_enabled
// ON. This module reads and writes the lease, reports what it sees, and changes no behaviour — so
// the logic can be proven against two real machines before it is allowed to stop one of them.
//
// THE HAZARD IT EXISTS FOR: _autoExtendTick has no leader guard and generated_schedule syncs, so two
// machines with auto-generation ON build the same days independently and their logs merge by
// last-writer-wins. The current mitigation is that exactly one machine is switched on, enforced by
// nothing.
//
// STORAGE: station_config_kv, key `station:<id>:lease` — a SYNCED key, which is the whole point;
// a local record cannot arbitrate between machines that cannot see each other.
//   Receipt: station_config_kv is in the synced table list (synced-tables.js:49) and registered at
//   :833 with scope 'station'. Only keys in LOCAL_ONLY_KEYS are held back. (The design doc cited
//   :327 for this, which is generated_schedule.source — wrong line, right conclusion.)
//
// This file is PURE except for the two thin db helpers at the bottom: every decision is a function
// of (current lease, now, my machine id), so it is unit-testable without a database or a second PC.
"use strict";

const LEASE_TTL_SEC = 15 * 60;        // a lease with no renewal for this long is dead
const HEARTBEAT_SEC = 5 * 60;         // the holder renews this often — 3 chances before expiry
const LEASE_KEY = (stationId) => `station:${stationId}:lease`;

/** Parse a stored lease. Any malformed value is treated as ABSENT rather than trusted: an
 *  unreadable lease must not be able to look like someone else's valid claim. */
function parseLease(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || !v.machine_id || !v.last_renewal) return null;
    return { machine_id: String(v.machine_id), last_renewal: Number(v.last_renewal),
             ttl: Number(v.ttl) || LEASE_TTL_SEC, version: Number(v.version) || 1,
             machine_name: v.machine_name || null };
  } catch { return null; }
}

const isExpired = (lease, now) => !lease || (now - lease.last_renewal) > (lease.ttl || LEASE_TTL_SEC);

/**
 * The whole decision, as a pure function.
 *
 * @returns {{action:'claim'|'renew'|'observe'|'skip', reason:string, holder:string|null,
 *            expired:boolean, mine:boolean, ageSec:number|null}}
 */
function decide({ lease, now, machineId, autoOn, killSwitch }) {
  const ageSec = lease ? Math.max(0, now - lease.last_renewal) : null;
  const expired = isExpired(lease, now);
  const mine = !!(lease && lease.machine_id === machineId);
  const base = { holder: lease ? lease.machine_id : null, expired, mine, ageSec };

  // The kill switch restores today's behaviour completely: no claims, no renewals, no lease at all.
  // It exists so a bug in this file can be neutralised by an operator without a release.
  if (killSwitch) return { ...base, action: 'skip', reason: 'kill_lease set — lease logic bypassed' };

  // Opt-in first: only a machine the operator has switched ON may hold the lease. A machine that is
  // off has been told not to generate, and must not sit on a claim that stops one that should.
  if (!autoOn) return { ...base, action: 'observe', reason: 'auto-generation off on this machine' };

  if (!lease) return { ...base, action: 'claim', reason: 'no lease exists' };
  if (mine) return { ...base, action: 'renew', reason: 'holding the lease' };
  if (expired) return { ...base, action: 'claim', reason: `lease expired (${ageSec}s since renewal)` };
  return { ...base, action: 'observe', reason: `held by ${lease.machine_id}` };
}

/**
 * What the operator should be shown. Separate from decide() because the Health Monitor must describe
 * the STATION's situation, not this machine's next move.
 *
 * Two named hazards, deliberately as loud as each other:
 *   no-leaseholder  — nothing will top the log up. The zero-writer hazard is invisible by nature
 *                     (nothing happens), so it is stated rather than left to be inferred from a
 *                     runway that quietly stops moving.
 *   two-writers     — Phase 1 does not enforce, so an unclaimed lease with this machine ON means
 *                     any other ON machine is also generating right now.
 */
function status({ lease, now, machineId, autoOn, killSwitch }) {
  const ageSec = lease ? Math.max(0, now - lease.last_renewal) : null;
  const expired = isExpired(lease, now);
  if (killSwitch) {
    return { level: 'yellow', state: 'bypassed', holder: null, ageSec,
             text: 'Lease bypassed (kill_lease) — every switched-on machine generates' };
  }
  if (!lease || expired) {
    // Phase 1 never blocks generation, so this is not yet "the log will not top up" — it is
    // "nobody has claimed it, and nothing is arbitrating". Saying more would be a lie today.
    const why = !lease ? 'no leaseholder' : `lease expired ${ageSec}s ago`;
    return { level: autoOn ? 'yellow' : 'red', state: 'unheld', holder: lease ? lease.machine_id : null, ageSec,
             text: autoOn
               ? `${why} — this machine is generating, and so is any other switched-on machine`
               : `${why} — nothing is set to top up this station's log` };
  }
  const mine = lease.machine_id === machineId;
  return { level: 'green', state: mine ? 'held-by-me' : 'held-by-other',
           holder: lease.machine_id, holderName: lease.machine_name, ageSec,
           text: `${mine ? 'This machine' : (lease.machine_name || lease.machine_id)} — renewed ${ageSec}s ago` };
}

/** The value written when claiming or renewing. `version` increments so a reader can order writes
 *  even if two clocks disagree; the sync layer's own HLC is the ultimate arbiter of which row wins. */
function nextLease({ lease, now, machineId, machineName, claiming }) {
  return JSON.stringify({
    machine_id: machineId, machine_name: machineName || null, last_renewal: now,
    ttl: LEASE_TTL_SEC, version: (claiming || !lease ? (lease ? lease.version + 1 : 1) : lease.version),
  });
}

module.exports = { decide, status, parseLease, nextLease, isExpired, LEASE_KEY, LEASE_TTL_SEC, HEARTBEAT_SEC };
