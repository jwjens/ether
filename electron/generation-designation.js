// ── generation-designation — which machine tops up a station's log ──────────────────────────────
//
// Replaces the lease election shipped in 4.4.187 (docs/single-writer-election-design-2026-08-11.md
// §0). No competition, no expiry, no automatic takeover: ONE machine is designated and stays
// designated until a person says otherwise. Takeover was already ruled human-only, and the runway
// gauge makes a stalled generator visible for days — so automatic failover was machinery for a
// decision nobody wanted made automatically.
//
// PHASE A ENFORCES NOTHING. _autoExtendTick still runs on every switched-on machine; this records
// and reports. Phase B adds the gate.
//
// Stored in station_config_kv under `designated_generator` — a SYNCED key, which is the point: a
// local record cannot tell two machines apart. Receipts: station_config_kv is in the synced list
// (synced-tables.js:49), registered with scope 'station' (:833); only LOCAL_ONLY_KEYS are withheld.
//
// Pure apart from JSON: every decision is a function of (record, machine, flags), so the cases that
// matter are testable without a database or a second PC.
"use strict";

const KEY = 'designated_generator';
const HOUR = 3600;
const STALE_YELLOW_SEC = 6 * HOUR;    // checked in within 6h: healthy
const STALE_RED_SEC = 24 * HOUR;      // nothing for a day: the designated machine is not watching

/** A malformed record is ABSENT, never a valid designation belonging to someone else. */
function parseRecord(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || !v.machine_id) return null;
    return {
      machine_id: String(v.machine_id),
      machine_name: v.machine_name || null,
      designated_at: Number(v.designated_at) || null,
      last_checked: Number(v.last_checked) || null,
      last_generated: Number(v.last_generated) || null,
    };
  } catch { return null; }
}

/**
 * What this machine should do on a tick.
 * @returns {{action:'designate'|'stamp'|'observe'|'skip', reason:string, designated:boolean}}
 */
function decide({ record, machineId, autoOn, killSwitch }) {
  const designated = !!(record && record.machine_id === machineId);
  const base = { designated, holder: record ? record.machine_id : null };
  if (killSwitch) return { ...base, action: 'skip', reason: 'kill_designation set — designation bypassed' };
  // Opt-in first: a machine the operator switched off must never take the designation, or it would
  // own a station it has been told not to generate.
  if (!autoOn) return { ...base, action: 'observe', reason: 'auto-generation off on this machine' };
  if (!record) return { ...base, action: 'designate', reason: 'no designated machine — claiming by first generate' };
  if (designated) return { ...base, action: 'stamp', reason: 'designated — recording heartbeat' };
  // NEVER taken automatically. This is the whole difference from the lease it replaced.
  return { ...base, action: 'observe', reason: `designated to ${record.machine_name || record.machine_id}` };
}

function fmtAgo(sec) {
  if (sec < 90) return `${sec}s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  if (sec < 172800) return `${Math.round(sec / HOUR)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

/** Operator-facing state for the Health Monitor. */
function status({ record, now, machineId, killSwitch }) {
  if (killSwitch) {
    return { level: 'yellow', state: 'bypassed', holder: null, lastChecked: null, lastGenerated: null,
             text: 'Designation bypassed (kill_designation) — every switched-on machine generates' };
  }
  if (!record) {
    // RED, and honest that it is not yet causing harm: Phase A does not gate generation.
    return { level: 'red', state: 'none', holder: null, lastChecked: null, lastGenerated: null,
             text: 'No designated machine — nothing owns keeping this log topped up' };
  }
  const age = record.last_checked != null ? Math.max(0, now - record.last_checked) : null;
  const level = age == null ? 'yellow' : age < STALE_YELLOW_SEC ? 'green' : age < STALE_RED_SEC ? 'yellow' : 'red';
  const mine = record.machine_id === machineId;
  return {
    level, state: mine ? 'mine' : 'other',
    holder: record.machine_id, holderName: record.machine_name,
    lastChecked: record.last_checked, lastGenerated: record.last_generated,
    checkedAgeSec: age,
    text: `${mine ? 'This machine' : (record.machine_name || record.machine_id)}` +
          (age == null ? ' — never checked in' : ` — checked in ${fmtAgo(age)}`),
  };
}

/** The value to store. `generated` also stamps last_generated — kept distinct from last_checked so a
 *  healthy machine with a long runway does not look idle. */
function nextRecord({ record, now, machineId, machineName, generated }) {
  const base = record && record.machine_id === machineId ? record : null;
  return JSON.stringify({
    machine_id: machineId,
    machine_name: machineName || (base && base.machine_name) || null,
    designated_at: (base && base.designated_at) || now,
    last_checked: now,
    last_generated: generated ? now : (base ? base.last_generated : null),
  });
}

module.exports = { KEY, decide, status, parseRecord, nextRecord, fmtAgo, STALE_YELLOW_SEC, STALE_RED_SEC };
