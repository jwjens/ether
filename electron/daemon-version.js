// ── Daemon version decision (2026-08-10) ─────────────────────────────────────────────────────────
//
// Pure: given what the `version` command returned (or how it failed), decide what the operator
// should be told. Extracted from checkStaleDaemon so the rule can be tested — particularly the
// UNKNOWN case, which is the one that is easy to get subtly wrong by substituting a confident guess.
//
// Returning null means "no conclusion" — say nothing and change nothing. A plain connection error is
// not evidence of staleness: the daemon may simply be starting, and reporting a mismatch from it
// would be inventing news.
//
// backlog 2026-08-03 "VERSION-MISMATCH GUARD"
"use strict";

/**
 * @param {{ daemonVersion?: any, appVersion?: string, error?: any }} input
 * @returns {{stale:boolean, reason:"mismatch"|"unknown"|null, daemonVersion:string|null, appVersion:string|null}|null}
 */
function decideDaemonVersion({ daemonVersion, appVersion, error } = {}) {
  const appV = appVersion == null ? null : String(appVersion);

  if (error) {
    // A daemon too old to know the `version` command is stale BY DEFINITION — and its build cannot
    // be determined, so it is reported as unknown rather than guessed at.
    if (/unknown cmd/i.test(String(error && error.message ? error.message : error))) {
      return { stale: true, reason: "unknown", daemonVersion: null, appVersion: appV };
    }
    return null;   // connection error — no conclusion
  }

  // "0" is the daemon's own placeholder for "I don't know my version", so it is not a mismatch.
  const dv = daemonVersion == null || daemonVersion === "" ? null : String(daemonVersion);
  if (dv && dv !== "0" && dv !== appV) {
    return { stale: true, reason: "mismatch", daemonVersion: dv, appVersion: appV };
  }
  return { stale: false, reason: null, daemonVersion: dv && dv !== "0" ? dv : null, appVersion: appV };
}

module.exports = { decideDaemonVersion };
