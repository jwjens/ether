'use strict';
// electron/local-output-sense.js — is this levels frame a MONITOR bypass? (2026-10-07, docs/monitor-bypass-diagnosis.md)
//
// Pure, so it is tested (local-output-sense.test.js). A frame carries `local_out_peak` — the post-MONITOR peak of what
// the engine wrote to local devices in the latest buffer (exact, no release; native/src/localout.rs) — and
// `master_monitor`, the MONITOR level it was scaled by. With MONITOR at 0 the peak is 0 by construction; above silence
// means a path bypasses the monitor. The PFL cue device is the approved exception and is not in local_out_peak.

/** Above this a post-MONITOR sample is sound, not float dust. */
const BYPASS_PEAK = 0.001;

/** True when the frame proves sound left for a local device while MONITOR was at 0. */
function isMonitorBypass(f) {
  const pk = Number(f && f.local_out_peak), mm = Number(f && f.master_monitor);
  if (!Number.isFinite(pk) || !Number.isFinite(mm)) return false;   // an older engine without the fields says nothing
  return mm === 0 && pk > BYPASS_PEAK;
}

module.exports = { isMonitorBypass, BYPASS_PEAK };
