// COMMITTED ON PURPOSE, and excluded from the installer.
//
// This is not a one-off diagnostic and it does not expire (CLAUDE.md: temporary tooling must be torn
// down). It is a RECEIPT TOOL: the way a claim about a BUILT ARTIFACT gets proved rather than argued.
// Point it at any ether-audio.node - the repo copy, or the one inside dist-electron/win-unpacked - and
// it answers from that binary. It keeps the diag- prefix so electron-builder's existing
// "!**/scripts/diag-*.js" rule keeps it out of the shipped app; .gitignore carries an explicit
// exception for it.
//
// scripts/diag-levels-echo.js — does the PACKAGED native module actually put the processor echo on
// the wire? Loads a given ether-audio.node, calls audioGetLevels(), and prints the RAW JSON string.
//
// This exists because "I added the assignment" was reported twice and was wrong twice: once because the
// lines were never written, and once because they were written to the Rust struct while
// audio_get_levels hand-builds its JSON from a separate key list. The struct is not the wire. Only the
// string this prints is the wire.
//
//   node scripts/diag-levels-echo.js <path-to-ether-audio.node>
"use strict";
const p = process.argv[2];
if (!p) { console.error("usage: node scripts/diag-levels-echo.js <ether-audio.node>"); process.exit(2); }

const A = require(p);
console.log("module:", p);

const ECHO = ["proc_ceiling_dbtp", "proc_release_ms", "proc_ride_rate", "proc_ride_clamp",
              "proc_ride_bypass", "proc_limiter_bypass"];

const raw = A.audioGetLevels(1);
console.log("\nRAW audioGetLevels(1):\n" + raw + "\n");

const o = JSON.parse(raw);
let missing = 0;
for (const k of ECHO) {
  const present = Object.prototype.hasOwnProperty.call(o, k);
  if (!present) missing++;
  console.log(`  ${present ? "PRESENT" : "ABSENT "}  ${k}${present ? " = " + JSON.stringify(o[k]) : ""}`);
}
console.log(`\n${missing === 0 ? "ALL SIX ON THE WIRE" : missing + " OF 6 MISSING FROM THE WIRE"}`);

// Round-trip: does a bypass command change what the wire reports? Needs a live audio thread, which a
// bare script may not have (the no-device path consumes the command and does nothing), so a `false`
// here is inconclusive rather than a failure. Key PRESENCE above is the load-bearing result.
if (typeof A.audioSetProcessorBypass === "function") {
  A.audioSetProcessorBypass(1, true, false);
  setTimeout(() => {
    const after = JSON.parse(A.audioGetLevels(1));
    console.log(`\nafter audioSetProcessorBypass(1, true, false):`);
    console.log(`  proc_ride_bypass    = ${JSON.stringify(after.proc_ride_bypass)}`);
    console.log(`  proc_limiter_bypass = ${JSON.stringify(after.proc_limiter_bypass)}`);
    console.log(after.proc_ride_bypass === true
      ? "  ROUND TRIP CONFIRMED - the command reached the bus and the wire reports it"
      : "  inconclusive - no audio thread in a bare script; presence of the keys above is the receipt");
    process.exit(missing === 0 ? 0 : 1);
  }, 400);
} else {
  console.log("\naudioSetProcessorBypass NOT EXPORTED by this module");
  process.exit(missing === 0 ? 0 : 1);
}
