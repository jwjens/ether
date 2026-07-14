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
    tickMs = 1000,
  } = opts || {};

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
        refill0At: 0, playSkipAt: 0,
        degradedSince: 0, frozenSince: 0,
        level: "GREY", levelSince: nowMs(), reason: "init",
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
    // GREY — automation off
    if (r.enginestate === "off") return { level: "GREY", reason: "automation off" };
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
    if (r.framesPerSec > 1 && r.framesPerSec < GREEN_FRAME_FLOOR) {
      if (!r.degradedSince) r.degradedSince = t;
      if (t - r.degradedSince > DEGRADED_MS) return { level: "YELLOW", reason: `degraded frame rate ${Math.round(r.framesPerSec/1000)}k/s` };
    } else { r.degradedSince = 0; }
    // GREEN — automation on, frames >90%, peak >0.01 within 10s
    if (r.framesPerSec >= GREEN_FRAME_FLOOR && r.lastNonSilentAt && (t - r.lastNonSilentAt) < 10000) return { level: "GREEN", reason: "healthy" };
    // automation on but not yet clearly green (e.g. between tracks) — hold GREEN if frames advancing
    if (r.framesPerSec >= GREEN_FRAME_FLOOR) return { level: "GREEN", reason: "frames advancing" };
    return { level: "YELLOW", reason: "starting / no fresh audio" };
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
      if (ev.level !== r.level) {
        const prev = r.level; r.level = ev.level; r.levelSince = t; r.reason = ev.reason;
        onTransition(r, prev, t);
      } else { r.reason = ev.reason; }
    }
    broadcastSnapshot(t);
  }

  function onTransition(r, prevLevel, t) {
    const metrics = {
      framesPerSec: Math.round(r.framesPerSec), peak: +(+r.peak).toFixed(3), activeDecks: r.activeDecks,
      queueDepth: r.queueDepth, nextDeckReady: r.nextDeckReady, trackLeftSec: r.trackLeftMs != null ? Math.round(r.trackLeftMs/1000) : null,
      enginestate: r.enginestate, streaming: r.streaming, drainBps: r.drainBps, pingMs: lastPingMs, enginePid,
    };
    const ev = { ts: iso(t), stationUuid: r.uuid, stationName: r.name, level: r.level, prevLevel, reason: r.reason, metrics };
    // Iris feed: append JSONL (guarded — a logging failure must never affect anything)
    try { if (jsonlPath) fs.appendFileSync(jsonlPath, JSON.stringify(ev) + "\n"); } catch {}
    // in-memory ring for the live event feed (YELLOW/RED transitions, newest first)
    if (r.level === "YELLOW" || r.level === "RED") { recentEvents.unshift(ev); if (recentEvents.length > MAX_RECENT) recentEvents.length = MAX_RECENT; }
  }

  function snapshot(t = nowMs()) {
    return {
      ts: iso(t),
      engine: { pid: enginePid, uptimeSec: engineStartedAt ? Math.round((t - engineStartedAt)/1000) : null, restartCount, pingMs: lastPingMs },
      stations: [...stations.values()].map(r => ({
        uuid: r.uuid, stationId: r.stationId, name: r.name, level: r.level, reason: r.level === "GREEN" ? "" : r.reason,
        framesPerSec: Math.round(r.framesPerSec), peak: +(+r.peak).toFixed(3), activeDecks: r.activeDecks,
        queueDepth: r.queueDepth, nextDeckReady: r.nextDeckReady, track: r.track,
        trackLeftSec: r.trackLeftMs != null ? Math.round(r.trackLeftMs/1000) : null,
        streaming: r.streaming, drainBps: r.drainBps, enginestate: r.enginestate, levelSince: iso(r.levelSince),
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
    noteLevels, noteEngineState, noteDeck, noteQueue, notePlaySkip, notePlayStart, noteStreamStatus, noteEnginePid,
    start, stop, getSnapshot: () => snapshot(), getRecentEvents: (n = MAX_RECENT) => recentEvents.slice(0, n),
  };
}

module.exports = { createHealthMonitor };
