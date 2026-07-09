'use strict';
// Daemon auto-resume replay (4.4.43 Phase D). On every fresh daemon (re)connect the main process
// must restore what was airing BEFORE the daemon died — not just playout+monitor, but the Icecast
// STREAM too. Before Phase D the reconnect handler replayed only automationStart, so a reload left
// every stream DOWN until a manual restart → each reload = listener dead air (jensj 4.4.41, streams
// dropped every ~10 min). This replays BOTH intents so a reload is a brief blip, not silence.
//
// Extracted as a pure-ish unit (client injected) so the "simulated reload restores streams" behavior
// is unit-testable without booting Electron. Covered by scripts/test-auto-resume-streams.js.
//
// streamIntent is replayed AFTER a short delay so the fresh engine's program bus is producing audio
// before the encoder attaches (mirrors the natural operator gap: automationStart then startStream a
// few seconds later — a cold-bus stream start can attach to silence).

function replayIntents(client, automationIntent, streamIntent, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const streamDelayMs = opts.streamDelayMs != null ? opts.streamDelayMs : 1500;
  const setTimer = opts.setTimeout || setTimeout;

  // 1) Restore playout/monitor for every on-air station.
  for (const [sid, args] of automationIntent) {
    client.cmd('automationStart', args || { stationId: sid })
      .then(() => log(`auto-resume: replayed automationStart for station ${sid}`))
      .catch((e) => log(`auto-resume: automationStart replay FAILED for station ${sid}: ${e && e.message || e}`));
  }

  // 2) Restore the Icecast stream for every station that was streaming (Phase D — the fix). Delayed
  //    so playout is up first; a reload can never again mean silent listener dead air.
  const fireStreams = () => {
    for (const [sid, args] of streamIntent) {
      client.cmd('startStream', args || { stationId: sid })
        .then(() => log(`auto-resume: replayed startStream for station ${sid}`))
        .catch((e) => log(`auto-resume: startStream replay FAILED for station ${sid}: ${e && e.message || e}`));
    }
  };
  if (streamIntent.size > 0) {
    if (streamDelayMs > 0) setTimer(fireStreams, streamDelayMs);
    else fireStreams();
  }

  return { automationCount: automationIntent.size, streamCount: streamIntent.size };
}

module.exports = { replayIntents };
