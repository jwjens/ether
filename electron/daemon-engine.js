// ── Daemon ENGINE match (2026-10-10, docs/monitor-failed-test-diagnosis-2026-10-10.md) ───────────────────────────
//
// Pure: given what the running daemon says it loaded (`engine` command → sha256 of ether-audio.node + of the daemon
// code) and what is installed, decide what the operator is told. The version check (daemon-version.js) cannot see this:
// on OVEVENTS the installed build and the running daemon both said "4.6.59" while the daemon ran the PRE-FIX engine,
// and MONITOR "did nothing".
//
// Returns null for "no conclusion" (a plain connection error — the daemon may be starting). Otherwise:
//   { stale, reason: "mismatch" | "unknown" | null, daemon: {native, code}, installed: {native, code}, parts: [...] }
//   · mismatch — the running engine's bytes differ from the installed ones (parts names which: native, code)
//   · unknown  — the daemon predates the `engine` command, so it was started from a build older than this one;
//                its hash cannot be read, and is reported as unknown, never guessed
"use strict";

const short = (h) => (h ? String(h).slice(0, 12) : "unknown");

/**
 * @param {{ daemon?: {native?:string|null, code?:string|null}|null, installed?: {native?:string|null, code?:string|null}|null, error?: any }} input
 */
function decideDaemonEngine({ daemon, installed, error } = {}) {
  const inst = { native: (installed && installed.native) || null, code: (installed && installed.code) || null };
  if (error) {
    if (/unknown cmd/i.test(String(error && error.message ? error.message : error))) {
      return { stale: true, reason: "unknown", daemon: { native: null, code: null }, installed: inst, parts: ["native", "code"],
        message: `The running audio engine predates engine reporting — it is older than the installed engine ${short(inst.native)}. It is replaced at the next restart while no station is on air.` };
    }
    return null;
  }
  const run = { native: (daemon && daemon.native) || null, code: (daemon && daemon.code) || null };
  // Nothing installed to compare with (dev tree without a built engine, unreadable install) — no conclusion.
  if (!inst.native && !inst.code) return null;
  const parts = [];
  if (inst.native && run.native !== inst.native) parts.push("native");
  if (inst.code && run.code !== inst.code) parts.push("code");
  if (!parts.length) return { stale: false, reason: null, daemon: run, installed: inst, parts };
  const what = parts.map(p => p === "native" ? `engine ${short(run.native)} ≠ installed ${short(inst.native)}` : `daemon code ${short(run.code)} ≠ installed ${short(inst.code)}`).join("; ");
  return { stale: true, reason: "mismatch", daemon: run, installed: inst, parts,
    message: `The running audio engine is not the installed one: ${what}. It is replaced at the next restart while no station is on air.` };
}

module.exports = { decideDaemonEngine };
