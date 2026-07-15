// electron/audio-health.js — one source of truth for per-station audio health.
//
// DISPLAY + EVENT-LOGGING ONLY. This module is a PURE CONSUMER of signals the main process already
// receives from the daemon (levels/enginestate/deck/queue/playstart/stream) plus a read-only ping
// RTT. It NEVER mutates audio state, never calls a recovery/playout path, and every fs/compute op is
// guarded so a failure here can never propagate into the daemon event handler or playout. Identity is
// by station UUID. This is also Iris's future sensory feed: every level transition is appended as a
// structured JSONL event {ts, stationUuid, level, prevLevel, reason, metrics}.

"use strict";
const fs = require("fs");
const path = require("path");

// ── thresholds (per spec) ──────────────────────────────────────────────────────
const FULL_RATE          = 44100;      // program frames/sec at unity
const GREEN_FRAME_FLOOR  = 0.90 * FULL_RATE;   // >90% full rate
const PEAK_SILENT        = 0.01;       // peak <= this = "silent"
const FROZEN_MS          = 3000;       // frames frozen >= 3s → RED
const SILENT_RED_MS      = 30000;      // peak silent > 30s while playing → RED
const SILENT_YELLOW_MS   = 10000;      // peak silent 10–30s while playing → YELLOW
const QUEUE_LOW          = 5;          // depth < 5 → YELLOW
const NEXT_DECK_TRACK_LEFT_MS = 30000; // next deck not ready & track < 30s left → YELLOW
const PING_LAG_MS        = 500;        // ping RTT > 500ms → YELLOW
const REFILL0_RECENT_MS  = 8000;       // a "0 playable" refill counts as YELLOW for this long
const PLAYSKIP_RECENT_MS = 5000;       // a play-skip counts as RED for this long
const DEGRADED_MS        = 5000;       // frame rate < 90% (but not frozen) sustained this long → YELLOW
const RANK = { GREY: 0, GREEN: 1, YELLOW: 2, RED: 3 };

function nowMs() { return Date.now(); }
function iso(ms) { return new Date(ms).toISOString(); }

function createHealthMonitor(opts) {
  const {
    logDir,                              // dir for health-events.jsonl
    broadcast = () => {},                // (channel, payload) — sendToAllWindows
    ping = async () => null,             // async () => round-trip ms (or null on failure)
    drainRate = () => null,              // (stationId) => latest drain B/s (or null); read-only
    stationName = () => "",              // (stationId) => display name
    uuidOf = (id) => String(id),         // (stationId) => station UUID (identity)
    enginePidProvider = () => null,      // () => current daemon pid (read-only; drives uptime/restart)
    engineStartedAtProvider = () => null,// v4.4.51: () => daemon process startedAt ms (from its ping reply)
    modeProvider = () => "daemon",       // () => "daemon" | "in-process" — playout mode (for the RED banner)
    tickMs = 1000,
  } = opts || {};
  const DISPLAY_HYSTERESIS_MS = 5000;    // v4.4.51: a WORSE level must hold this long before the UI shows it (JSONL logs raw)

  const stations = new Map();            // uuid -> record
  const recentEvents = [];               // last N YELLOW/RED transitions (newest first)
  const MAX_RECENT = 20;
  let jsonlPath = null;
  try { jsonlPath = path.join(logDir, "health-events.jsonl"); fs.mkdirSync(logDir, { recursive: true }); } catch { jsonlPath = null; }
  let timer = null;
  let enginePid = null;
  let engineStartedAt = null;
  let restartCount = 0;
  let lastPingMs = null;

  function rec(uuid) {
    let r = stations.get(uuid);
    if (!r) {
      r = {
        uuid, stationId: null, name: "",
        enginestate: "off",
        framesTotal: null, framesAt: 0, framesPerSec: 0,
        lastFramesAdvanceAt: 0,
        peak: 0, lastNonSilentAt: 0, activeDecks: 0, monVol: 1,
        queueDepth: null, nextDeckReady: false,
        track: null, trackLeftMs: null, trackDurMs: null, trackStartAt: 0,
        streaming: false, drainBps: null,
        jingle: null,   // JINGLES v1: { state:'ARMED'|'FIRING', title, categoryId, since } or null
        refill0At: 0, playSkipAt: 0,
        degradedSince: 0, frozenSince: 0,
        level: "GREY", levelSince: nowMs(), reason: "init",
        displayLevel: "GREY", worseSince: 0,   // v4.4.51: debounced level shown in the UI (5s hysteresis)
      };
      stations.set(uuid, r);
    }
    return r;
  }

  // ── signal intake (called from main.js's EXISTING daemon-event handlers) ───────
  function noteLevels(stationId, lv) {
    try {
      const r = rec(uuidOf(stationId)); r.stationId = stationId; r.name = stationName(stationId);
      const t = nowMs();
      if (lv && typeof lv.frames_total === "number") {
        if (r.framesTotal != null && t > r.framesAt) {
          const df = lv.frames_total - r.framesTotal;
          const dt = (t - r.framesAt) / 1000;
          if (dt > 0) r.framesPerSec = Math.max(0, df / dt);
          if (df > 0) r.lastFramesAdvanceAt = t;
        }
        r.framesTotal = lv.frames_total; r.framesAt = t;
      }
      if (typeof lv.master === "number") { r.peak = lv.master; if (lv.master > PEAK_SILENT) r.lastNonSilentAt = t; }
      if (typeof lv.active_decks === "number") r.activeDecks = lv.active_decks;
      if (typeof lv.mon_vol === "number") r.monVol = lv.mon_vol;
      // next-deck-ready: a non-active deck that already has a source loaded = a preloaded standby.
      if (Array.isArray(lv.decks)) r.nextDeckReady = lv.decks.some(d => d && d.source_present && !d.active);
    } catch {}
  }
  function noteEngineState(stationId, state) { try { const r = rec(uuidOf(stationId)); r.stationId = stationId; r.enginestate = state || "off"; } catch {} }
  function noteDeck(stationId, deck, ready, state) {
    try {
      const r = rec(uuidOf(stationId));
      // current track + time-remaining from the PLAYING deck's state (title/duration/position).
      if (state && state.status === "playing") {
        if (state.title) r.track = state.artist ? `${state.title} — ${state.artist}` : state.title;
        if (typeof state.durationSec === "number" && state.durationSec > 0) r.trackDurMs = state.durationSec * 1000;
        r.trackStartAt = nowMs() - (typeof state.positionSec === "number" ? state.positionSec * 1000 : 0);
      }
    } catch {}
  }
  function noteQueue(stationId, items, source, addedCount) {
    try { const r = rec(uuidOf(stationId)); if (Array.isArray(items)) r.queueDepth = items.length;
      if (source && addedCount === 0) r.refill0At = nowMs(); } catch {}
  }
  function notePlaySkip(stationId) { try { rec(uuidOf(stationId)).playSkipAt = nowMs(); } catch {} }
  function notePlayStart(stationId, title, artist, durationMs) {
    try { const r = rec(uuidOf(stationId)); r.track = title ? (artist ? `${title} — ${artist}` : title) : r.track;
      r.trackStartAt = nowMs(); if (typeof durationMs === "number") r.trackDurMs = durationMs; } catch {}
  }
  function noteStreamStatus(stationId, state) { try { const r = rec(uuidOf(stationId)); r.streaming = state === "live" || state === "connecting"; } catch {} }
  // JINGLES overlay v1: ARMED/FIRING/ARMED_CANCELLED/CLEARED from the daemon overlay orchestrator. Both a
  // live per-station cell (snapshot) AND a ledger event (rider #2: an armed-but-cancelled jingle emits
  // ARMED_CANCELLED here and leaves NO play_log row). Observed states — FIRING means samples were flowing.
  function noteJingle(stationId, m) {
    try {
      const r = rec(uuidOf(stationId)); r.stationId = stationId; r.name = stationName(stationId);
      const t = nowMs(); const state = m && m.state;
      if (!state) return;
      if (state === "CLEARED" || state === "ARMED_CANCELLED") r.jingle = null;
      else r.jingle = { state, title: (m.title || null), categoryId: (m.categoryId ?? null), since: t };
      const ev = { ts: iso(t), type: "jingle", stationUuid: r.uuid, stationName: r.name, state,
        deck: (m.deck || null), title: (m.title || null), categoryId: (m.categoryId ?? null),
        leadInSec: (m.leadInSec ?? null), underlapSec: (m.underlapSec ?? null) };
      try { if (jsonlPath) fs.appendFileSync(jsonlPath, JSON.stringify(ev) + "\n"); } catch {}
    } catch {}
  }
  function noteEnginePid(pid) {
    try {
      if (pid && pid !== enginePid) {
        if (enginePid != null) { restartCount++; for (const r of stations.values()) r._restartFlag = nowMs(); }
        enginePid = pid; engineStartedAt = nowMs();
      }
    } catch {}
  }

  // ── state machine (per station, per tick) ─────────────────────────────────────
  function evaluate(r, t) {
    // GREY — genuinely idle (no engine, no decks, no frames). NOTE: in-process playout emits no
    // enginestate events, so we must NOT treat "off" alone as GREY — infer activity from decks/frames.
    if (r.enginestate === "off" && r.activeDecks === 0 && r.framesPerSec <= 1) return { level: "GREY", reason: "automation off" };
    const playing = r.activeDecks > 0 || r.enginestate === "live";
    // frozen detection
    const framesStaleMs = r.lastFramesAdvanceAt ? (t - r.lastFramesAdvanceAt) : 0;
    if (r.framesPerSec <= 1 && r.framesAt && (t - r.framesAt) > FROZEN_MS && framesStaleMs > FROZEN_MS) {
      return { level: "RED", reason: `frames frozen ${Math.round(framesStaleMs/1000)}s` };
    }
    // RED conditions
    if (r._restartFlag && (t - r._restartFlag) < 3000) return { level: "RED", reason: "engine restarted" };
    if (r.playSkipAt && (t - r.playSkipAt) < PLAYSKIP_RECENT_MS) return { level: "RED", reason: "play-skip event" };
    if (r.queueDepth === 0) return { level: "RED", reason: "queue empty" };
    const silentMs = r.lastNonSilentAt ? (t - r.lastNonSilentAt) : 0;
    if (playing && r.lastNonSilentAt && silentMs > SILENT_RED_MS) return { level: "RED", reason: `silent ${Math.round(silentMs/1000)}s while playing` };
    // YELLOW conditions
    if (r.queueDepth != null && r.queueDepth < QUEUE_LOW) return { level: "YELLOW", reason: `queue depth ${r.queueDepth} < ${QUEUE_LOW}` };
    if (r.refill0At && (t - r.refill0At) < REFILL0_RECENT_MS) return { level: "YELLOW", reason: "refill returned 0 playable" };
    if (playing && r.lastNonSilentAt && silentMs > SILENT_YELLOW_MS) return { level: "YELLOW", reason: `silent ${Math.round(silentMs/1000)}s while playing` };
    if (r.trackLeftMs != null && r.trackLeftMs < NEXT_DECK_TRACK_LEFT_MS && !r.nextDeckReady) return { level: "YELLOW", reason: "next deck not ready, <30s left" };
    if (lastPingMs != null && lastPingMs > PING_LAG_MS) return { level: "YELLOW", reason: `event-loop lag ${lastPingMs}ms` };
    // GREEN — frames at full rate (the clearest healthy signal)
    if (r.framesPerSec >= GREEN_FRAME_FLOOR) { r.degradedSince = 0; return { level: "GREEN", reason: "healthy" }; }
    // quiet ≠ no data (v4.4.51): if the levels STREAM is still ARRIVING, PCM is flowing even if this
    // sample's frames/s dipped (getLevels delta jitter) or the peak is merely low — do NOT flap to
    // YELLOW. Real freezes are still caught above (frames-frozen RED via lastFramesAdvanceAt); this only
    // suppresses the single-sample "no fresh audio" false positives while audio is demonstrably flowing.
    const levelsFresh = r.framesAt && (t - r.framesAt) < 2500;
    if (levelsFresh) { r.degradedSince = 0; return { level: "GREEN", reason: "healthy" }; }
    // sustained sub-rate WITH a stale levels stream = a genuine early warning
    if (r.framesPerSec > 1) { if (!r.degradedSince) r.degradedSince = t; if (t - r.degradedSince > DEGRADED_MS) return { level: "YELLOW", reason: "degraded frame rate" }; }
    return { level: "YELLOW", reason: "no fresh audio (levels stale)" };
  }

  function tick() {
    const t = nowMs();
    // daemon pid (read-only) — a change = engine restart (resets uptime, bumps restart count)
    try { const pid = enginePidProvider(); if (pid) noteEnginePid(pid); } catch {}
    // refresh derived per-station fields
    for (const r of stations.values()) {
      if (r.trackStartAt && r.trackDurMs != null) r.trackLeftMs = Math.max(0, r.trackDurMs - (t - r.trackStartAt));
      if (r.streaming) { try { const d = drainRate(r.stationId); if (typeof d === "number") r.drainBps = d; } catch {} } else { r.drainBps = null; }
      const ev = evaluate(r, t);
      // RAW level → JSONL (Iris feed): full fidelity, logged immediately on every transition.
      if (ev.level !== r.level) { const prev = r.level; r.level = ev.level; r.levelSince = t; r.reason = ev.reason; logJsonl(r, prev, t); }
      else { r.reason = ev.reason; }
      // DISPLAY level → 5s hysteresis: a WORSE level must hold that long before it surfaces in the UI;
      // recovery (improvement) surfaces immediately. Kills the sub-5s GREEN↔YELLOW flapping in the UI
      // while the JSONL keeps every raw transition.
      const rawRank = RANK[r.level], dispRank = RANK[r.displayLevel];
      if (rawRank <= dispRank) {
        r.worseSince = 0;
        if (r.displayLevel !== r.level) { const prevD = r.displayLevel; r.displayLevel = r.level; pushRecent(r, prevD, t); }
      } else {
        if (!r.worseSince) r.worseSince = t;
        if (t - r.worseSince >= DISPLAY_HYSTERESIS_MS) { const prevD = r.displayLevel; r.displayLevel = r.level; r.worseSince = 0; pushRecent(r, prevD, t); }
      }
    }
    broadcastSnapshot(t);
  }

  function _metrics(r) {
    return { framesPerSec: Math.round(r.framesPerSec), peak: +(+r.peak).toFixed(3), activeDecks: r.activeDecks,
      queueDepth: r.queueDepth, nextDeckReady: r.nextDeckReady, trackLeftSec: r.trackLeftMs != null ? Math.round(r.trackLeftMs/1000) : null,
      enginestate: r.enginestate, streaming: r.streaming, drainBps: r.drainBps, pingMs: lastPingMs, enginePid };
  }
  // JSONL (Iris feed) — RAW transition, full fidelity.
  function logJsonl(r, prevLevel, t) {
    const ev = { ts: iso(t), stationUuid: r.uuid, stationName: r.name, level: r.level, prevLevel, reason: r.reason, metrics: _metrics(r) };
    try { if (jsonlPath) fs.appendFileSync(jsonlPath, JSON.stringify(ev) + "\n"); } catch {}
  }
  // UI event ring — DEBOUNCED (display) transition, so the on-screen feed doesn't flap on sub-5s blips.
  function pushRecent(r, prevLevel, t) {
    if (r.displayLevel !== "YELLOW" && r.displayLevel !== "RED") return;
    const ev = { ts: iso(t), stationUuid: r.uuid, stationName: r.name, level: r.displayLevel, prevLevel, reason: r.reason, metrics: _metrics(r) };
    recentEvents.unshift(ev); if (recentEvents.length > MAX_RECENT) recentEvents.length = MAX_RECENT;
  }

  function snapshot(t = nowMs()) {
    let mode = "daemon"; try { mode = modeProvider() || "daemon"; } catch {}
    let startedAt = null; try { startedAt = engineStartedAtProvider(); } catch {}   // v4.4.51: prefer the daemon's reported start
    if (!startedAt) startedAt = engineStartedAt;
    return {
      ts: iso(t),
      mode,   // v4.4.50: "daemon" | "in-process" — the Health Monitor shows a RED banner when in-process
      engine: { pid: enginePid, uptimeSec: startedAt ? Math.round((t - startedAt)/1000) : null, restartCount, pingMs: lastPingMs },
      stations: [...stations.values()].map(r => ({
        uuid: r.uuid, stationId: r.stationId, name: r.name, level: r.displayLevel, reason: r.displayLevel === "GREEN" ? "" : r.reason,
        framesPerSec: Math.round(r.framesPerSec), peak: +(+r.peak).toFixed(3), activeDecks: r.activeDecks,
        queueDepth: r.queueDepth, nextDeckReady: r.nextDeckReady, track: r.track,
        trackLeftSec: r.trackLeftMs != null ? Math.round(r.trackLeftMs/1000) : null,
        streaming: r.streaming, drainBps: r.drainBps, enginestate: r.enginestate, levelSince: iso(r.levelSince),
        jingle: r.jingle,   // JINGLES v1: live overlay state (null when idle)
      })),
      recentEvents: recentEvents.slice(0, MAX_RECENT),
    };
  }
  function broadcastSnapshot(t) { try { broadcast("audio:health", snapshot(t)); } catch {} }

  async function pingTick() { try { const ms = await ping(); if (ms != null) lastPingMs = ms; } catch {} }

  function start() {
    if (timer) return;
    timer = setInterval(() => { pingTick().finally(() => { try { tick(); } catch {} }); }, tickMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return {
    noteLevels, noteEngineState, noteDeck, noteQueue, notePlaySkip, notePlayStart, noteStreamStatus, noteEnginePid, noteJingle,
    start, stop, getSnapshot: () => snapshot(), getRecentEvents: (n = MAX_RECENT) => recentEvents.slice(0, n),
  };
}

module.exports = { createHealthMonitor };
