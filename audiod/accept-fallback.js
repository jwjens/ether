// Item 10 — proves the dead-air safety net: when the daemon is DESIRED but can't be brought
// up, the app falls back to the in-process engine (today's behavior) instead of going silent.
// Drives the REAL main-process client (electron/audio-daemon-client) pointed at a daemon forced
// to die on startup (ETHER_AUDIOD_DIE=1), and replicates electron/main.js setupAudioBackend's
// exact decision, asserting the outcome is "in-process engine inited", not "daemon".
//   node audiod/accept-fallback.js
process.env.ETHER_AUDIO_DAEMON = "1";                       // daemon desired
process.env.ETHER_AUDIOD_PIPE  = "\\\\.\\pipe\\ether-audiod-fallbacktest-" + process.pid;
process.env.ETHER_AUDIOD_DIE   = "1";                       // ...but every spawned daemon exits immediately

const client = require("../electron/audio-daemon-client");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Mirror electron/main.js setupAudioBackend() exactly, with a stub addon to observe the init.
  let AUDIO_DAEMON = false, initedLocal = false;
  const audio = { initAudioEngine: () => { initedLocal = true; } };
  const DESIRED = client.isEnabled();
  console.log("daemon desired:", DESIRED, "| forcing daemon to die on startup (ETHER_AUDIOD_DIE=1)");

  const t0 = Date.now();
  if (DESIRED) {
    client.ensure();   // self-retries on failure (debounced); just poll for the result
    while (!client.isConnected() && Date.now() - t0 < 5000) { await sleep(150); }
    if (client.isConnected()) { AUDIO_DAEMON = true; }
    else { AUDIO_DAEMON = false; audio.initAudioEngine(); }
  } else {
    audio.initAudioEngine();
  }
  const waited = Math.round((Date.now() - t0) / 100) / 10;

  client.stop();
  console.log(`after ${waited}s: daemon connected=${client.isConnected()} | AUDIO_DAEMON(effective)=${AUDIO_DAEMON} | in-process engine inited=${initedLocal}`);
  const ok = AUDIO_DAEMON === false && initedLocal === true;
  console.log("\n→ FALLBACK: " + (ok
    ? "✅ daemon unreachable → app fell back to the in-process engine (NO dead air; worst case = today's behavior)"
    : "❌ did not fall back correctly"));
  // best-effort: clean any die-looping daemon spawns (they exit on their own, but be sure)
  setTimeout(() => process.exit(ok ? 0 : 1), 200);
})();
