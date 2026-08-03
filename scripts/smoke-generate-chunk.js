// Bench — the chunked-generate contract (2026-08-03).
//   node scripts/smoke-generate-chunk.js   (exit 0 = pass)
//
// WHY A SOURCE-CONTRACT BENCH AND NOT A BEHAVIOURAL ONE: the generator lives inside electron/main.js and
// binds live better-sqlite3 prepared statements to main's DB handle, so it cannot be required or driven
// from bare Node, and the only real database is the LIVE one (never written externally — standing rule).
// The behavioural gate is therefore the RUNTIME acceptance test (generate a week while a deck animates).
// What this bench does is guard the structural invariants that made the 2026-08-03 freeze possible, so
// they cannot silently return — the same regression-guard pattern as smoke-deck-identity's source scan.
"use strict";
const fs = require("fs"), path = require("path");
const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");
const cal  = fs.readFileSync(path.join(__dirname, "..", "src", "components", "BroadcastCalendar.tsx"), "utf8");

let pass = 0, fail = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
}
/** Body of a top-level `function name(` … through its closing brace at column 0. */
function fnBody(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  const k = src.slice(i).search(/\r?\n\}/);   // CRLF-tolerant: the file is CRLF
  return k < 0 ? src.slice(i) : src.slice(i, i + k + 3);
}
const dayHandler = (() => {
  const i = main.indexOf("ipcMain.handle('schedule:generateDay'");
  const k = main.slice(i).search(/\r?\n\}\);/);   // end of THIS handler, not the next thing in the file
  return k < 0 ? main.slice(i) : main.slice(i, i + k);
})();
const driver = fnBody(main, "_generateDayChunked");

console.log("── 1 · THE REGRESSION: main's event loop must not be held for a whole day ──");
check("1 · the generateDay handler is ASYNC (was a sync handler — the freeze)",
  /ipcMain\.handle\('schedule:generateDay',\s*async/.test(main));
check("1 · the driver YIELDS inside its hour loop",
  /await new Promise\(r => setImmediate\(r\)\)/.test(driver));
check("1 · …and the yield is INSIDE the for-loop, not after it",
  driver.indexOf("await new Promise(r => setImmediate(r))") < driver.search(/\}\r?\n\s*return \{ cancelled: false \}/));
check("1 · the day handler no longer calls the picker for all 24 hours at once",
  !/_generateDayRows\(dayBase, ctx, effStart\);/.test(dayHandler));
check("1 · it drives the chunked driver instead",
  /await _generateDayChunked\(/.test(dayHandler));

console.log("\n── 2 · the picker can be driven ONE hour at a time ──");
const picker = fnBody(main, "_generateDayRows");
check("2 · _generateDayRows accepts an hour slice", /_generateDayRows\(dayBaseDate, ctx, minTs = 0, onlyHour = null\)/.test(main));
check("2 · the hour guard is the FIRST statement in the loop (nothing runs for other hours)",
  /for \(let h = 0; h < 24; h\+\+\) \{\s*\n\s*if \(onlyHour !== null && h !== onlyHour\) continue;/.test(picker));
check("2 · the already-aired skip is still there (never regenerate a past hour)",
  /if \(hourStartTs < minTs\) continue;/.test(picker));

console.log("\n── 3 · CANCEL is real — checked every hour, and it reaches MAIN ──");
check("3 · the driver checks cancel at the top of each hour", /for \([^)]*\) \{\s*\n\s*if \(_genCancel\) return \{ cancelled: true \};/.test(driver));
check("3 · a cancel handler exists in main", /ipcMain\.handle\('schedule:generateCancel'/.test(main));
check("3 · the CANCEL button invokes it (a renderer ref alone could never stop main)",
  /schedule:generateCancel/.test(cal));
check("3 · a cancelled day is NEVER committed", /if \(run\.cancelled\) return \{ ok: true, cancelled: true, count: 0 \};/.test(dayHandler));

console.log("\n── 4 · the delete window is closed (generated_schedule is the playout source) ──");
check("4 · delete + insert happen inside ONE transaction", /db\.transaction\(\(\) => \{\s*\n\s*db\.prepare\("DELETE FROM generated_schedule/.test(main));
check("4 · the day handler no longer deletes before the pick",
  !/DELETE FROM generated_schedule[\s\S]{0,200}_buildScheduleCtx/.test(dayHandler));
check("4 · ctx is built BEFORE any delete (it reads play_log, never generated_schedule)",
  dayHandler.indexOf("_buildScheduleCtx") < dayHandler.indexOf("_commitDayRows"));

console.log("\n── 5 · the week is ONE pipeline, not seven blocking calls ──");
check("5 · a range handler exists", /ipcMain\.handle\('schedule:generateDays'/.test(main));
check("5 · the calendar calls it once", /invoke\("schedule:generateDays", tsList\)/.test(cal));
check("5 · the calendar no longer loops generateDay per day",
  !/for \(let i = 0; i < dates\.length; i\+\+\)[\s\S]{0,600}invoke\("schedule:generateDay"/.test(cal));
check("5 · the range commits each day atomically as it completes",
  /_commitDayRows\(stationId, effStart, dayEnd, dayRows\)/.test(main));
check("5 · progress is emitted per HOUR, not per day", /_genEmit\(\{ phase: "hour"/.test(main));
check("5 · the calendar subscribes to hour progress", /schedule:generate-progress/.test(cal));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
