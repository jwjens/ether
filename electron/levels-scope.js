'use strict';
// Station-scoping for the VU levels channel (v4.5 levels-slice; docs/vu-meter-crosstalk-2026-07-08.md).
// Pure + shared: the main-process relay uses scopeLevelsFrame; the renderer meters mirror matchesStation.
// Covered by scripts/test-levels-scope.js. UUID identity only — no per-machine integer id crosses.

// Relay transform: forward the WHOLE daemon frame (forward-whole-frames invariant), swapping the
// per-machine integer stationId for the station UUID. Never reconstruct-and-drop (that was the bug).
// resolveUuid(id) → uuid | null.
function scopeLevelsFrame(m, resolveUuid) {
  const { event, stationId, ...rest } = m || {};   // drop the pipe envelope + the integer id
  const out = { ...rest, stationUuid: resolveUuid ? resolveUuid(stationId) : null };
  if (typeof out.master !== 'number') out.master = Math.max(out.a || 0, out.b || 0, out.c || 0);
  return out;
}

// Renderer predicate: should a meter bound to `myUuid` render this frame?
//  • other station's tagged frame → NO (this kills the cross-talk).
//  • own station's frame → YES.
//  • untagged frame or my-uuid-not-resolved-yet → YES (never go dark; the fixed build always tags,
//    and both the daemon relay AND the in-process fallback tag, so this net is only for boot/edge).
function matchesStation(lvl, myUuid) {
  if (!myUuid) return true;
  if (!lvl || lvl.stationUuid == null) return true;
  return lvl.stationUuid === myUuid;
}

module.exports = { scopeLevelsFrame, matchesStation };
