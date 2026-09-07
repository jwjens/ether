// COMMITTED ON PURPOSE, and excluded from the installer.
//
// This is not a one-off diagnostic and it does not expire (CLAUDE.md: temporary tooling must be torn
// down). It is a RECEIPT TOOL: the way a claim about a BUILT ARTIFACT gets proved rather than argued.
// Point it at any ether-audio.node - the repo copy, or the one inside dist-electron/win-unpacked - and
// it answers from that binary. It keeps the diag- prefix so electron-builder's existing
// "!**/scripts/diag-*.js" rule keeps it out of the shipped app; .gitignore carries an explicit
// exception for it.
//
// scripts/diag-branch-split.js — the monitor and the stream are two chains, proven on the wire.
"use strict";
const A = require(process.argv[2]);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// audio_get_levels returns the snapshot the PREVIOUS nudge produced - prime, then read.
const get = async () => { A.audioGetLevels(1); await wait(250); return JSON.parse(A.audioGetLevels(1)); };
const LOCAL = 0, STREAM = 1;

// WAIT FOR THE DEVICE, do not assume it. The engine opens its audio output asynchronously, and until it
// does, the command thread consumes SetProcessorParams/SetProcessorBypass through the no-device path and
// does nothing. A fixed sleep produced a FALSE FAILURE here when the machine was busy - which is the
// cry-wolf failure this whole exercise is about. Send, read back, retry; and if it never lands, say THAT
// rather than reporting the feature broken.
const setAndConfirm = async (apply, check, what, tries = 12) => {
  for (let i = 0; i < tries; i++) {
    apply();
    const lv = await get();
    if (check(lv)) return lv;
    await wait(500);
  }
  console.error("");
  console.error("COMMANDS ARE NOT LANDING - no audio device in this process (" + what + ").");
  console.error("Not a product failure: close whatever holds the device, or re-run on an idle machine.");
  process.exit(2);
};


(async () => {
  await wait(3000);
  const keys = Object.keys(await get()).filter(k => k.startsWith("proc_stream_")).sort();
  console.log("stream keys on the wire (" + keys.length + "): " + keys.join(", ") + "\n");

  // Independent PARAMETERS
  const p = await setAndConfirm(() => {
    A.audioSetProcessorParams(1, LOCAL,  -14, -1.0, 120, 1.5, 12);
    A.audioSetProcessorParams(1, STREAM, -16, -3.0, 300, 4.0,  6);
  }, lv => lv.proc_ceiling_dbtp === -1 && lv.proc_stream_ceiling_dbtp === -3, "parameters");
  console.log("monitor: target=" + p.proc_target_lufs + " ceiling=" + p.proc_ceiling_dbtp +
              " release=" + p.proc_release_ms + " rate=" + p.proc_ride_rate + " clamp=" + p.proc_ride_clamp);
  console.log("stream : target=" + p.proc_stream_target_lufs + " ceiling=" + p.proc_stream_ceiling_dbtp +
              " release=" + p.proc_stream_release_ms + " rate=" + p.proc_stream_ride_rate + " clamp=" + p.proc_stream_ride_clamp);

  // Independent BYPASS - the whole point of per-branch state
  const b1 = await setAndConfirm(() => {
    A.audioSetProcessorBypass(1, STREAM, true, false);
    A.audioSetProcessorBypass(1, LOCAL,  false, false);
  }, lv => lv.proc_stream_ride_bypass === true, "stream bypass");
  console.log("\nstream ride bypassed only:");
  console.log("  monitor ride=" + b1.proc_ride_bypass + " limiter=" + b1.proc_limiter_bypass);
  console.log("  stream  ride=" + b1.proc_stream_ride_bypass + " limiter=" + b1.proc_stream_limiter_bypass);

  const b2 = await setAndConfirm(() => {
    A.audioSetProcessorBypass(1, LOCAL,  false, true);
    A.audioSetProcessorBypass(1, STREAM, false, false);
  }, lv => lv.proc_limiter_bypass === true, "monitor bypass");
  console.log("monitor limiter bypassed only:");
  console.log("  monitor ride=" + b2.proc_ride_bypass + " limiter=" + b2.proc_limiter_bypass);
  console.log("  stream  ride=" + b2.proc_stream_ride_bypass + " limiter=" + b2.proc_stream_limiter_bypass);

  const paramsIndependent = p.proc_ceiling_dbtp === -1 && p.proc_stream_ceiling_dbtp === -3 &&
                            p.proc_target_lufs === -14 && p.proc_stream_target_lufs === -16;
  const bypassIndependent = b1.proc_stream_ride_bypass === true && b1.proc_ride_bypass === false &&
                            b2.proc_limiter_bypass === true && b2.proc_stream_limiter_bypass === false;
  console.log("\nPARAMETERS INDEPENDENT : " + (paramsIndependent ? "YES" : "NO"));
  console.log("BYPASS INDEPENDENT     : " + (bypassIndependent ? "YES" : "NO"));
  process.exit(paramsIndependent && bypassIndependent ? 0 : 1);
})();
