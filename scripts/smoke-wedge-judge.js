// smoke-wedge-judge.js — the silent-wedge verdict (electron/wedge-judge.js).   npm run test:wedge
// The OV 4.6.51 case first: callback stale 19.5 min, levels "fresh" (the last meter frame re-reported) — must be a
// WEDGE, never suppressed. Then the cases the old watchdog handled, unchanged.
"use strict";
const { judge, CB_STALE_MS } = require("../electron/wedge-judge");
let fails = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fails++; };
const base = { cbStaleMs: null, levelsAgeMs: Infinity, playing: false, engineLive: false, wedgeMs: 0 };

const ov = judge({ ...base, cbStaleMs: 19.5 * 60000, levelsAgeMs: 200, playing: true, engineLive: true });
ok(ov.verdict === "wedge", `OV: callback stale 19.5 min + levels fresh (200 ms) + enginestate=live → ${ov.verdict} — ${ov.reason}`);
ok(judge({ ...base, cbStaleMs: CB_STALE_MS, levelsAgeMs: 0 }).verdict === "wedge", "stale at the threshold (3000 ms) with levels fresh → wedge");
ok(judge({ ...base, cbStaleMs: 5000, playing: false }).verdict === "wedge", "stale callback with nothing playing → wedge (a dead card is dead for the mic and the Link too)");
ok(judge({ ...base, cbStaleMs: 5000, engineLive: true, wedgeMs: 0 }).verdict === "wedge", "stale callback is never held by enginestate=live");
ok(judge({ ...base, cbStaleMs: 40, levelsAgeMs: 60000, playing: true }).verdict === "healthy", "fresh callback + silent levels (a quiet track) → healthy");
// No stamp (an engine that cannot report one): the old levels-based rules
ok(judge({ ...base, levelsAgeMs: 1000, playing: true }).verdict === "healthy", "no stamp, levels fresh → healthy");
ok(judge({ ...base, levelsAgeMs: 9000, playing: false }).verdict === "idle", "no stamp, levels stale, nothing playing → idle");
ok(judge({ ...base, levelsAgeMs: 9000, playing: true, engineLive: true, wedgeMs: 5000 }).verdict === "held", "no stamp, enginestate=live under the ceiling → held");
ok(judge({ ...base, levelsAgeMs: 9000, playing: true, engineLive: true, wedgeMs: 13000 }).verdict === "wedge", "no stamp, enginestate=live past the 12 s ceiling → wedge");

// NEVER REOPEN BECAUSE MAIN IS LATE (2026-10-13)
const { tickWasLate, recheck } = require("../electron/wedge-judge");
ok(tickWasLate(10_000, 10_000 + 2000 + 5000, 2000) === true, "main stuck 5 s → the watchdog round is skipped");
ok(tickWasLate(10_000, 10_000 + 2100, 2000) === false, "a tick 100 ms late is judged normally");
ok(tickWasLate(0, 99_999, 2000) === false, "the first round is never 'late'");
// main stuck 5 s: the first look (main's math) said stale; the engine's own stamp kept moving → alive → no reopen
ok(recheck(1_000_000, 1_000_950) === "alive", "the callback moved between two looks 1 s apart → alive, no reopen");
ok(recheck(1_000_000, 1_000_000) === "dead", "the callback did not move → dead → reopen");
ok(recheck(1_000_000, 0) === "unknown", "the engine did not answer the second look → no reopen this round");
ok(/callbackAge/.test(require("fs").readFileSync(require("path").join(__dirname, "..", "audiod", "ether-audiod.js"), "utf8")), "the engine measures the callback age on its own clock (callbackAge)");

// main.js uses the judge, and the old "levels fresh → skip" first line is gone
const main = require("fs").readFileSync(require("path").join(__dirname, "..", "electron", "main.js"), "utf8");
ok(/WedgeJudge\.judge\(/.test(main), "main.js's watchdog asks wedge-judge");
ok(/WedgeJudge\.recheck\(/.test(main) && /WedgeJudge\.tickWasLate\(/.test(main), "main.js takes the second look and skips a late round before any reopen");
ok(!/if \(_stationAudioAgeMs\(sid\) < 6000\) \{ _wedgeAt\.delete\(sid\); continue; \}/.test(main), "main.js no longer skips a station on fresh levels before reading the callback");
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
