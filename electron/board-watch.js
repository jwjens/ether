// electron/board-watch.js — THE BOARD IS WATCHED, NOT JUST CHECKED AT CONNECT (Jeff, 2026-10-12).
//
// docs/station-monitor-zeroed-at-attach-2026-10-12.md (why), docs/health-monitor-jump-and-freeze-2026-10-12.md (how).
// Jeff: "compare saved vs live engine values on every change the engine reports … raise the red
// board-state-mismatch-error within a second of any divergence, naming the setting" — and then: "the mismatch check must
// be event-driven and cheap, with no polling DB reads."
//
// EVENT-DRIVEN. Nothing here runs on a timer of its own. A station is compared only when something changed it:
//   · touched(sid)      — a board change went to or came from its engine (main's _boardSend, the blade's level events,
//                         a Take). Trailing debounce `quietMs` (a drag is one check, after it settles), but never later
//                         than `maxWaitMs` after the first change, so a long drag is still checked about once a second.
//   · savedChanged(sid) — a write to the saved board (electron/board-write-events.js). Drops that station's cached copy,
//                         then compares it.
// THE SAVED BOARD IS CACHED. It is read from the database only after a write said it changed (or on first use) — never
// polled. The live board is one async engine read (getBoardState over the daemon pipe; nothing blocks main).
// A DIFFERENCE MUST HOLD STILL. It is an error only when the SAME settings show the SAME live and saved values on two reads
// `confirmMs` apart. A fader being dragged (values moving, the callback's applied copy a buffer behind) is never an error;
// when it stops, the saved board has caught up and the check matches. Worst case from a lasting divergence to the red
// event: quietMs + confirmMs (+ one engine read) — under a second.
"use strict";

function createBoardWatch({ readSaved, readLive, compare, overlay, onMismatch, onMatch, log,
  quietMs = 200, maxWaitMs = 600, confirmMs = 300, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const say = (m) => { try { if (log) log(m); } catch {} };
  const st = new Map();
  const saved = new Map();       // sid → the saved board (cached)
  let paused = 0;
  let reads = { saved: 0, live: 0, checks: 0 };
  const of = (sid) => {
    let s = st.get(sid);
    if (!s) { s = { first: 0, timer: null, busy: false, again: false, pending: null, raised: undefined }; st.set(sid, s); }
    return s;
  };
  const sigOf = (diffs) => [...new Set(diffs.map(d => d.setting))].sort().join(",");
  const round = (v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v);
  const exactOf = (diffs) => JSON.stringify(diffs.map(d => [d.setting, d.where, round(d.saved), round(d.live)]).sort());

  function savedFor(sid) {
    if (!saved.has(sid)) { reads.saved++; saved.set(sid, readSaved(sid)); }
    return saved.get(sid);
  }

  function schedule(sid, delay) {
    const s = of(sid);
    if (s.timer) clearTimer(s.timer);
    s.timer = setTimer(() => { s.timer = null; s.first = 0; void check(sid); }, Math.max(0, delay));
  }

  async function check(sid) {
    const s = of(sid);
    if (paused) return;
    if (s.busy) { s.again = true; return; }
    s.busy = true; reads.checks++;
    try {
      let live;
      reads.live++;
      try { live = await readLive(sid); } catch (e) { live = { ok: false, reason: String(e && e.message || e) }; }
      if (!live || !live.ok || paused) return;        // no answer is not a mismatch; the connect pass reports it
      let sv;
      try { sv = savedFor(sid); } catch (e) { say(`[board-watch] s${sid} saved board unreadable ✗ ${e && e.message || e}`); return; }
      if (overlay) { try { sv = overlay(sid, sv) || sv; } catch { /* the cached copy stands */ } }
      const diffs = compare(sv, live);
      if (!diffs.length) {
        s.pending = null;
        if (s.raised !== null) { s.raised = null; try { if (onMatch) onMatch(sid); } catch {} }   // main says it once
        return;
      }
      const exact = exactOf(diffs), t = now();
      if (!s.pending || s.pending.exact !== exact) {
        // New, or still moving: look again once it has had confirmMs to hold still.
        s.pending = { exact, since: t };
        schedule(sid, confirmMs);
        return;
      }
      if (t - s.pending.since < confirmMs) { schedule(sid, confirmMs - (t - s.pending.since)); return; }
      const sig = sigOf(diffs);
      if (sig === s.raised) return;                   // already said, unchanged
      s.raised = sig;
      say(`[board-watch] s${sid} LIVE ≠ SAVED, unchanged for ${t - s.pending.since} ms: ${diffs.map(d => `${d.setting} saved ${JSON.stringify(d.saved)} live ${JSON.stringify(d.live)} (${d.where})`).join("; ")}`);
      try { onMismatch(sid, diffs); } catch {}
    } finally {
      s.busy = false;
      if (s.again) { s.again = false; void check(sid); }
    }
  }

  /** A board change went to / came from this station's engine. Trailing debounce, bounded by maxWaitMs. */
  function touched(sid) {
    const n = Number(sid); if (!Number.isFinite(n) || paused) return;
    const s = of(n), t = now();
    if (!s.first) s.first = t;
    schedule(n, Math.min(quietMs, maxWaitMs - (t - s.first)));
  }

  return {
    touched,
    /** Back-compatible name for touched(). */
    poke: touched,
    /** The saved board changed (a write said so). null = any station. Drops the cached copy, then compares. */
    savedChanged(sid, stationIds) {
      if (sid == null) { saved.clear(); for (const id of (stationIds ? stationIds() : [...st.keys()])) touched(id); return; }
      const n = Number(sid); saved.delete(n); touched(n);
    },
    check,
    /** While the connect pass re-applies the board, the board is between states: say nothing about it. Nested. */
    pause() { paused++; for (const s of st.values()) { s.pending = null; s.first = 0; if (s.timer) { clearTimer(s.timer); s.timer = null; } } },
    resume() { paused = Math.max(0, paused - 1); },
    stop() { for (const s of st.values()) if (s.timer) { clearTimer(s.timer); s.timer = null; } },
    /** The last raised difference per station. */
    raised(sid) { const s = st.get(Number(sid)); return s && s.raised ? s.raised : null; },
    /** What it has cost: database reads (saved boards), engine reads, comparisons. */
    stats() { return { ...reads, cachedStations: saved.size }; },
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
