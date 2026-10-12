// electron/board-watch.js — THE BOARD IS WATCHED, NOT JUST CHECKED AT CONNECT (Jeff, 2026-10-12).
//
// docs/station-monitor-zeroed-at-attach-2026-10-12.md. Jeff: "Make it continuous: compare saved vs live engine values on
// every change the engine reports (and a periodic check), and raise the red board-state-mismatch-error within a second
// of any divergence, naming the setting."
//
// The connect pass (electron/board-sync.js) compares once per connect; a write that lands after it (2026-10-12: the
// window zeroed halloVeen's station MONITOR half a second after the engine restored it) was only seen by the NEXT pass.
// This watches every station all the time:
//   · poke(sid)  — a change went to or came from the engine (every board setter main routes, the blade's level and Take
//                  events): that station is compared now.
//   · the beat   — every station is compared every `periodMs`, so a change nobody announced is still seen.
// A difference must SURVIVE `confirmMs` before it is an error: an operator's change reaches the engine a moment before it
// is saved (the strip sends, then saves), and that moment is not a fault. Worst case from divergence to the red event:
// periodMs + confirmMs (500 + 300 ms by default).
//
// Saved = the database, overlaid with what main is about to save (`overlay` — board_levels is written at most once a
// second, so a fader drag is "saved" the moment main holds it). One red event per distinct set of differences; a later
// match says so once (board-state-match). An engine that cannot answer is not a mismatch (the connect pass owns that).
"use strict";

function createBoardWatch({ stations, readSaved, readLive, compare, overlay, onMismatch, onMatch, log,
  periodMs = 500, confirmMs = 300, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, setBeat = setInterval, clearBeat = clearInterval }) {
  const say = (m) => { try { if (log) log(m); } catch {} };
  const st = new Map();          // sid → { since, raised, busy, again, timer }
  let beat = null, paused = 0;
  // raised: undefined = never compared (the first match is reported too, so a mismatch raised elsewhere — the connect
  // pass — is cleared by the watch), null = matching, a string = the differences already reported.
  const of = (sid) => { let s = st.get(sid); if (!s) { s = { since: null, raised: undefined, busy: false, again: false, timer: null }; st.set(sid, s); } return s; };
  const sigOf = (diffs) => [...new Set(diffs.map(d => d.setting))].sort().join(",");

  async function check(sid) {
    const s = of(sid);
    if (paused) return;
    if (s.busy) { s.again = true; return; }
    s.busy = true;
    try {
      let live;
      try { live = await readLive(sid); } catch (e) { live = { ok: false, reason: String(e && e.message || e) }; }
      if (!live || !live.ok || paused) return;        // no answer is not a mismatch; the connect pass reports it
      let saved;
      try { saved = readSaved(sid); } catch (e) { say(`[board-watch] s${sid} saved board unreadable ✗ ${e && e.message || e}`); return; }
      if (overlay) { try { saved = overlay(sid, saved) || saved; } catch { /* the database copy stands */ } }
      const diffs = compare(saved, live);
      if (!diffs.length) {
        s.since = null;
        if (s.timer) { clearTimer(s.timer); s.timer = null; }
        if (s.raised !== null) { s.raised = null; try { if (onMatch) onMatch(sid); } catch {} }
        return;
      }
      const t = now();
      if (s.since === null) s.since = t;
      if (t - s.since < confirmMs) {
        // Seen once. Look again when it has had confirmMs to settle.
        if (!s.timer) s.timer = setTimer(() => { s.timer = null; void check(sid); }, confirmMs - (t - s.since));
        return;
      }
      const sig = sigOf(diffs);
      if (sig === s.raised) return;                   // already said, unchanged
      s.raised = sig;
      say(`[board-watch] s${sid} LIVE ≠ SAVED for ${t - s.since} ms: ${diffs.map(d => `${d.setting} saved ${JSON.stringify(d.saved)} live ${JSON.stringify(d.live)} (${d.where})`).join("; ")}`);
      try { onMismatch(sid, diffs); } catch {}
    } finally {
      s.busy = false;
      if (s.again) { s.again = false; void check(sid); }
    }
  }

  async function tick() {
    let ids = [];
    try { ids = stations() || []; } catch { ids = []; }
    for (const sid of ids) await check(sid);
  }

  return {
    /** A change went to / came from this station's engine: compare it now. */
    poke(sid) { const n = Number(sid); if (Number.isFinite(n)) void check(n); },
    check, tick,
    start() { if (!beat) beat = setBeat(() => { void tick(); }, periodMs); return this; },
    stop() { if (beat) { clearBeat(beat); beat = null; } for (const s of st.values()) if (s.timer) { clearTimer(s.timer); s.timer = null; } },
    /** While the connect pass re-applies the saved board, the board is between states: say nothing about it. Nested. */
    pause() { paused++; for (const s of st.values()) { s.since = null; if (s.timer) { clearTimer(s.timer); s.timer = null; } } },
    resume() { paused = Math.max(0, paused - 1); },
    /** The last raised difference per station (tests, and the Health Monitor's "still mismatched"). */
    raised(sid) { const s = st.get(Number(sid)); return s && s.raised ? s.raised : null; },
  };
}

/**
 * main's not-yet-written board_levels, laid over the saved board: { slot: gain, master: gain } as the blade reported it.
 * Only faders the saved board already lists are touched (the same rows the applier restores).
 */
function overlayLevels(saved, levels) {
  if (!saved || !levels || typeof levels !== "object") return saved;
  const out = { ...saved, slots: { ...(saved.slots || {}) } };
  for (const [k, v] of Object.entries(levels)) {
    const n = Number(v); if (!Number.isFinite(n)) continue;
    if (k === "master") { if (out.masterVol !== undefined) out.masterVol = n; continue; }
    const e = out.slots[k]; if (e && e.volume !== undefined) out.slots[k] = { ...e, volume: n };
  }
  return out;
}

module.exports = { createBoardWatch, overlayLevels };
