// Bench — WHO is allowed to start automation (2026-08-03).
//   node scripts/smoke-automation-senders.js   (exit 0 = pass)
//
// THE RULE (Jeff): the AUTO button is the only thing that engages automation. Exactly three senders are
// legitimate — the operator's press, a remote automation_on, and the watchdog after an UNCLEAN death.
// Everything else was deleted, not gated.
//
// Two senders were proven from logs and killed here:
//   1. HANDOVER PRIMING — _doInProcessToDaemonHandover sent automationStart to "prime the daemon" every
//      time the cold-stage race forced an in-process fallback that later reattached. No operator involved.
//      Receipt: "[AUDIO] HANDOVER (song boundary): in-process -> daemon for station 2" 20:24:33.573.
//   2. OBSERVATION-DERIVED INTENT — the enginestate handler registered AND PERSISTED intent for any
//      station the daemon reported live, so automation-intent.json refilled itself from what the daemon
//      happened to be doing and the next launch replayed it.
//      Receipt: "auto-resume: registered on-air intent for station 2 (observed live)" 20:24:34.026.
//
// Source-contract bench: main.js binds Electron and cannot be required from bare Node, and the only real
// database is the live one. This guards the structural invariant so the senders cannot creep back.
"use strict";
const fs = require("fs"), path = require("path");
const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; }
/** Strip // comment lines — the deletion notes deliberately NAME the thing they removed, so a raw text
 *  search matches the comment and reports a false FAIL. Assert against CODE only. */
function codeOnly(src) {
  const NL = String.fromCharCode(10);
  return src.split(NL).filter(l => !l.trim().startsWith("//")).join(NL);
}
/** Body of a named function through its closing brace at that indent. CRLF-tolerant by construction. */
function fnBody(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) return "";
  const k = src.slice(i).search(/\r?\n  \}/);
  return k < 0 ? src.slice(i) : src.slice(i, i + k);
}

console.log("── 1 · the HANDOVER never engages automation ──");
{
  const body = fnBody(main, "function _doInProcessToDaemonHandover(sid) {");
  check("1 · the handover function still exists (reattach is legitimate)", body.length > 0);
  check("1 · …and sends NO automationStart", !/automationStart/.test(codeOnly(body)));
  check("1 · …and the deletion is recorded, not silently dropped", /DELETED 2026-08-03/.test(body));
  check("1 · it still flips routing to the daemon (reattach preserved)", /AUDIO_DAEMON = true/.test(body));
}

console.log("\n── 2 · intent is NEVER derived from observing the daemon ──");
{
  check("2 · no 'observed live' intent registration anywhere", !/observed live/.test(codeOnly(main)));
  // The enginestate handler must not persist intent — that was the self-refilling loop.
  const i = main.indexOf('sendToAllWindows("audio:daemon-enginestate"');
  const seg = main.slice(i, i + 1800);
  check("2 · the enginestate handler does not set _automationIntent", !/_automationIntent\.set/.test(seg));
  check("2 · …and does not persist it", !/_persistAutomationIntent\(\)/.test(seg));
}

console.log("\n── 3 · the legitimate senders survive ──");
{
  check("3 · the operator/command path still records intent",
    /if \(cmd === "automationStart"\) \{ _automationIntent\.set\(sid, args\); _persistAutomationIntent\(\); \}/.test(main));
  check("3 · replayIntents still exists (the watchdog path is untouched)", /replayIntents/.test(main));
  check("3 · replay still announces its origin + watchdog flag", /watchdogSpawned=\$\{!!process\.env\.ETHER_WATCHDOG_PID\}/.test(main));
  check("3 · clean-launch suppression is still in place", /boot auto-resume SUPPRESSED/.test(main));
}

console.log("\n── 4 · main sends automationStart from NO other site ──");
{
  // Every remaining occurrence of the literal command name in main.js, excluding comments.
  const hits = main.split(/\r?\n/)
    .filter(l => l.includes('"automationStart"') && !l.trim().startsWith("//"))
    .map(l => l.trim());
  check(`4 · exactly ONE non-comment site remains (found ${hits.length})`, hits.length === 1);
  check("4 · …and it is the intent RECORD on the operator/command path, not a send",
    hits.length === 1 && hits[0].includes("_automationIntent.set"));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
