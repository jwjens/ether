// ── generation-designation — which machine tops up a station's log ──────────────────────────────
//
// Replaces the lease election shipped in 4.4.187 (docs/single-writer-election-design-2026-08-11.md
// §0). No competition, no expiry, no automatic takeover: ONE machine is designated and stays
// designated until a person says otherwise. Takeover was already ruled human-only, and the runway
// gauge makes a stalled generator visible for days — so automatic failover was machinery for a
// decision nobody wanted made automatically.
//
// PHASE B IS LIVE (4.4.201). _autoExtendTick skips a station designated to another machine, so this
// module's `decide()` now governs whether an unattended generate happens at all. Manual Generate is
// never gated — an operator pressing the button is an explicit instruction from a human present at
// that machine.
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

/**
 * PHASE B — THE GATE. May THIS machine run an unattended generate for this station?
 *
 * Pure, so the rule that can stop a station being built is testable without two machines. Called by
 * _autoExtendTick only; MANUAL Generate is never gated — an operator pressing the button is an
 * explicit instruction from a human present at that machine.
 *
 * @returns {{ allow: boolean, reason: string, holder: string|null }}
 */
function mayAutoGenerate({ record, machineId, killSwitch }) {
  // The emergency switch outranks the gate. If designation itself is misbehaving, the operator must
  // still be able to get their log built — a gate with no override is a way to lose a station.
  if (killSwitch) return { allow: true, reason: 'kill_designation set — enforcement bypassed', holder: null };
  // NO RECORD → ALLOWED, and the caller's tick will claim it (the zero-config rule, design §1).
  // Refusing here would mean a brand-new station never builds a log at all: the enforcement causing
  // dead air, which is worse than the two-writer problem it exists to prevent.
  if (!record) return { allow: true, reason: 'no designated machine — this machine claims it by generating', holder: null };
  if (!machineId) return { allow: true, reason: 'this machine has no identity — cannot prove it is not the holder', holder: record.machine_id };
  if (record.machine_id === machineId) return { allow: true, reason: 'this machine is designated', holder: machineId };
  return { allow: false, reason: `designated to ${record.machine_name || record.machine_id}`, holder: record.machine_id };
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
    // STILL NEUTRAL UNDER PHASE B, and that is a deliberate choice in the gate rather than an
    // oversight here. An earlier note predicted this would become a warning once enforcement landed,
    // because an undesignated station would stop being topped up. The gate was built the other way:
    // a station with NO record is ALLOWED to generate, and the machine that does so claims it (the
    // zero-config rule). Refusing would mean a brand-new station never builds a log at all — the
    // enforcement causing dead air, which is worse than the two-writer problem it prevents.
    //
    // So this state is still normal, still not at risk, and still grey. An alarm that is usually
    // wrong is one people learn to ignore.
    return { level: 'grey', state: 'none', holder: null, lastChecked: null, lastGenerated: null,
             text: 'none — no machine has auto-generated this station yet' };
  }
  const age = record.last_checked != null ? Math.max(0, now - record.last_checked) : null;
  const level = age == null ? 'yellow' : age < STALE_YELLOW_SEC ? 'green' : age < STALE_RED_SEC ? 'yellow' : 'red';
  const mine = record.machine_id === machineId;
  return {
    level, state: mine ? 'mine' : 'other',
    holder: record.machine_id, holderName: record.machine_name,
    lastChecked: record.last_checked, lastGenerated: record.last_generated,
    checkedAgeSec: age,
    // Under Phase B the 'other' case is no longer just information: it is the reason THIS machine
    // is not building this station's log. Saying so on the row means an operator watching the runway
    // fall never has to guess why nothing is being generated here.
    text: `${mine ? 'This machine' : (record.machine_name || record.machine_id)}` +
          (age == null ? ' — never checked in' : ` — checked in ${fmtAgo(age)}`) +
          (mine ? '' : ' · this machine will not auto-generate it'),
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

module.exports = { KEY, decide, status, parseRecord, nextRecord, mayAutoGenerate, fmtAgo,
                   STALE_YELLOW_SEC, STALE_RED_SEC };
