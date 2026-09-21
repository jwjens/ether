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
// The Calendar was retired 2026-09-20 (Program Log slice 5). The renderer side of the contract now
// lives in the Program Log (Fill Day → schedule:generateDay) and GenerateProgressBar (the bar + CANCEL).
const plog = fs.readFileSync(path.join(__dirname, "..", "src", "components", "ProgramLog.tsx"), "utf8");
const bar  = fs.readFileSync(path.join(__dirname, "..", "src", "components", "GenerateProgressBar.tsx"), "utf8");

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
// The picker moved to electron/generate-core.js on 2026-08-11 (a pure move); read it there.
const core = fs.readFileSync(path.join(__dirname, "..", "electron", "generate-core.js"), "utf8");
const picker = fnBody(core, "_generateDayRows");
check("2 · _generateDayRows accepts an hour slice", /_generateDayRows\(dayBaseDate, ctx, minTs = 0, onlyHour = null\)/.test(core));
check("2 · the hour guard is the FIRST statement in the loop (nothing runs for other hours)",
  /for \(let h = 0; h < 24; h\+\+\) \{\s*\n\s*if \(onlyHour !== null && h !== onlyHour\) continue;/.test(picker));
check("2 · the already-aired skip is still there (never regenerate a past hour)",
  /if \(hourStartTs < minTs\) continue;/.test(picker));

console.log("\n── 3 · CANCEL is real — checked every hour, and it reaches MAIN ──");
check("3 · the driver checks cancel at the top of each hour", /for \([^)]*\) \{\s*\n\s*if \(_genCancel\) return \{ cancelled: true \};/.test(driver));
check("3 · a cancel handler exists in main", /ipcMain\.handle\('schedule:generateCancel'/.test(main));
check("3 · the CANCEL button invokes it (a renderer ref alone could never stop main)",
  /schedule:generateCancel/.test(bar));
check("3 · a cancelled day is NEVER committed", /if \(run\.cancelled\) \{[\s\S]{0,200}?return \{ ok: true, cancelled: true, count: 0 \};/.test(dayHandler) && dayHandler.indexOf("run.cancelled") < dayHandler.indexOf("_commitDayRows("));

console.log("\n── 4 · the delete window is closed (generated_schedule is the playout source) ──");
check("4 · delete + insert happen inside ONE transaction", (() => { const b = fnBody(main, "_commitDayRows"); const t = b.indexOf("db.transaction(() => {"); const ins = b.indexOf("generatedScheduleBulkCreate(db, stationId, fill)", t); return t > -1 && b.indexOf("DELETE FROM generated_schedule", t) > -1 && ins > -1 && b.indexOf("})();", ins) > ins; })());
check("4 · the day handler no longer deletes before the pick",
  !/DELETE FROM generated_schedule[\s\S]{0,200}buildScheduleCtx/.test(dayHandler));
check("4 · ctx is built BEFORE any delete (it reads play_log, never generated_schedule)",
  dayHandler.indexOf("buildScheduleCtx(") > -1 && dayHandler.indexOf("buildScheduleCtx(") < dayHandler.indexOf("_commitDayRows"));

console.log("\n── 5 · the week is ONE pipeline, not seven blocking calls ──");
check("5 · a range handler exists", /ipcMain\.handle\('schedule:generateDays'/.test(main));
check("5 · the Program Log's Fill Day is ONE generateDay call (Fill Week is not built — Jeff's ruling, slice 2a)",
  (plog.match(/invoke\("schedule:generateDay"/g) || []).length === 1 && !/invoke\("schedule:generateDays"/.test(plog));
check("5 · the Program Log never loops generateDay per hour or per day",
  !/for \([^)]*\)[\s\S]{0,600}invoke\("schedule:generateDay"/.test(plog));
check("5 · the range commits each day atomically as it completes",
  /_commitDayRows\(stationId, effStart, dayEnd, dayRows\)/.test(main));
check("5 · progress is emitted per HOUR, not per day", /_genEmit\(\{ phase: "hour"/.test(main));
check("5 · the progress bar subscribes to hour progress, and the Program Log pop-out mounts it",
  /schedule:generate-progress/.test(bar) && /<ProgramLog onClose=\{\(\) => window\.close\(\)\} \/><GenerateProgressBar \/>/.test(fs.readFileSync(path.join(__dirname, "..", "src", "components", "PopoutRenderer.tsx"), "utf8")));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
