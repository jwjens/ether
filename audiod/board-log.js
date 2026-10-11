// audiod/board-log.js — every board setter the engine receives, in the daemon log (2026-10-11).
//
// docs/board-state-on-connect-diagnosis-2026-10-11.md: after a fresh start every Source fader was silent in the room.
// Moving the AUX row did not bring it back and touching the fader did, and nothing recorded which commands the engine
// actually received, so the difference could not be explained. Now each setter is a log line:
//   [board s2] setAuxMonitor S1=0.74 → true
// A fader drag sends dozens a second, so one key (command + station + fader) logs at most once a second, and the last
// value of a burst is always logged (trailing), so the line on record is what the fader ended at.
"use strict";

const BOARD_CMDS = new Set([
  "setVolume", "setMuted", "setAuxMonitor", "setDuck", "setDuckable", "setDuckParams", "setSlotKind",
  "setMonitorVolume", "setMasterVolume", "setMasterMonitorVolume", "setAuxDevice", "setCueDevice", "setOutputDevice",
  "setPfl", "setPflDim",
]);

/** The value a setter carries, as one short string. */
function valueOf(m) {
  if (!m || typeof m !== "object") return "";
  for (const k of ["volume", "gain", "kind", "device", "dimDb"]) if (m[k] !== undefined) return JSON.stringify(m[k]);
  for (const k of ["muted", "enabled", "duckable", "on"]) if (m[k] !== undefined) return String(!!m[k]);
  if (m.depthDb !== undefined) return `depth ${m.depthDb} thr ${m.thresholdDb} att ${m.attackMs} hold ${m.holdMs} rel ${m.releaseMs}`;
  return "";
}

const fmt = (m, result) => {
  const target = m.deck ?? m.slot;
  const res = result && typeof result === "object" ? JSON.stringify(result) : String(result);
  return `[board s${m.stationId ?? "-"}] ${m.cmd}${target != null ? " " + target : ""}=${valueOf(m)} → ${res}`;
};

/**
 * @param {(line: string) => void} log
 * @param {{ windowMs?: number, now?: () => number, setTimer?: Function }} [opt]
 */
function makeBoardLog(log, opt = {}) {
  const windowMs = opt.windowMs ?? 1000;
  const now = opt.now ?? (() => Date.now());
  const setTimer = opt.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; });
  const last = new Map();      // key → time of the last line
  const trailing = new Map();  // key → { line, timer }
  return function note(m, result) {
    if (!m || !BOARD_CMDS.has(m.cmd)) return;
    const key = `${m.cmd}|${m.stationId}|${m.deck ?? m.slot ?? ""}`;
    const line = fmt(m, result);
    const t = now();
    if (t - (last.get(key) ?? -Infinity) >= windowMs) {
      last.set(key, t);
      const tr = trailing.get(key); if (tr) { trailing.delete(key); tr.cancelled = true; }
      log(line);
      return;
    }
    const tr = trailing.get(key);
    if (tr) { tr.line = line; return; }
    const entry = { line, cancelled: false };
    trailing.set(key, entry);
    setTimer(() => {
      if (entry.cancelled || trailing.get(key) !== entry) return;
      trailing.delete(key);
      last.set(key, now());
      log(entry.line);
    }, windowMs);
  };
}

module.exports = { makeBoardLog, BOARD_CMDS, valueOf };
