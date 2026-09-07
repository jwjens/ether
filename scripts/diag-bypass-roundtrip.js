// COMMITTED ON PURPOSE, and excluded from the installer.
//
// This is not a one-off diagnostic and it does not expire (CLAUDE.md: temporary tooling must be torn
// down). It is a RECEIPT TOOL: the way a claim about a BUILT ARTIFACT gets proved rather than argued.
// Point it at any ether-audio.node - the repo copy, or the one inside dist-electron/win-unpacked - and
// it answers from that binary. It keeps the diag- prefix so electron-builder's existing
// "!**/scripts/diag-*.js" rule keeps it out of the shipped app; .gitignore carries an explicit
// exception for it.
//
// scripts/diag-bypass-roundtrip.js — does a BYPASS command actually change what the wire reports?
// Waits for the audio device to come up first: the engine opens it asynchronously, and a command sent
// before that is consumed by the no-device path and lost.
"use strict";
const A = require(process.argv[2]);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// audio_get_levels SENDS a GetLevel nudge and returns the snapshot the PREVIOUS nudge produced, so a
// single call reports one poll behind. The daemon polls continuously at ~15Hz so this is ~66ms there
// and invisible; a one-shot script must prime. Reading once and discarding is the whole fix, and
// missing it made a working toggle look broken.
const get = async () => { A.audioGetLevels(1); await wait(250); return JSON.parse(A.audioGetLevels(1)); };

(async () => {
  await wait(3000);                       // let the device open
  const before = await get();
  console.log("baseline      : ride=" + JSON.stringify(before.proc_ride_bypass) +
              " limiter=" + JSON.stringify(before.proc_limiter_bypass));

  A.audioSetProcessorBypass(1, true, false);
  await wait(600);
  const on = await get();
  console.log("after ON      : ride=" + JSON.stringify(on.proc_ride_bypass) +
              " limiter=" + JSON.stringify(on.proc_limiter_bypass));

  A.audioSetProcessorBypass(1, false, true);
  await wait(600);
  const flip = await get();
  console.log("after FLIP    : ride=" + JSON.stringify(flip.proc_ride_bypass) +
              " limiter=" + JSON.stringify(flip.proc_limiter_bypass));

  A.audioSetProcessorBypass(1, false, false);
  await wait(600);
  const off = await get();
  console.log("after OFF     : ride=" + JSON.stringify(off.proc_ride_bypass) +
              " limiter=" + JSON.stringify(off.proc_limiter_bypass));

  // ALSO prove the numbers command cannot clear a bypass any more - the 15s re-assert defect.
  A.audioSetProcessorBypass(1, true, true);
  await wait(400);
  A.audioSetProcessorParams(1, -2.0, 200, 2.0, 9.0);      // exactly what the re-assert sends
  await wait(600);
  const after = await get();
  console.log("bypass ON, then a numbers re-assert:");
  console.log("  ride=" + JSON.stringify(after.proc_ride_bypass) +
              " limiter=" + JSON.stringify(after.proc_limiter_bypass) +
              " ceiling=" + JSON.stringify(after.proc_ceiling_dbtp));

  const toggles = on.proc_ride_bypass === true && flip.proc_limiter_bypass === true &&
                  flip.proc_ride_bypass === false && off.proc_ride_bypass === false;
  const survives = after.proc_ride_bypass === true && after.proc_limiter_bypass === true;
  console.log("\nTOGGLES ON AND OFF ON THE WIRE : " + (toggles ? "YES" : "NO"));
  console.log("SURVIVES A NUMBERS RE-ASSERT   : " + (survives ? "YES" : "NO"));
  process.exit(toggles && survives ? 0 : 1);
})();
