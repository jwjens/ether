// Bench — the automation controls are ABSOLUTE (2026-08-03).
//   node scripts/smoke-absolute-automation.js   (exit 0 = pass)
//
// THE DEFECT: the old control computed `const n = !autoAdv` — its meaning came from the LABEL. The label
// was stuck on MANUAL while the daemon was provably _started, so every press computed n=true and sent
// START. There was NO WAY for the operator to stop automation from the board.
// Jeff, verbatim: "the only job it had to stop the automation why is it still automating".
//
// THE RULE: the press IS the state. Neither control may read autoAdv / observedAutomation / the pill.
"use strict";
const fs = require("fs"), path = require("path");
const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
let pass = 0, fail = 0;
const check = (n, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); c ? pass++ : fail++; };
const NL = String.fromCharCode(10);
function body(src, decl) {
  const i = src.indexOf(decl); if (i < 0) return "";
  const k = src.slice(i).search(/\r?\n  \};/); return k < 0 ? "" : src.slice(i, i + k);
}

console.log("── 1 · STOP is unconditional and label-independent ──");
{
  const b = body(app, "const stopAutomation = async () => {");
  check("1 · stopAutomation exists", b.length > 0);
  check("1 · it sends stopDaemonAutomation", /stopDaemonAutomation/.test(b));
  check("1 · it NEVER reads autoAdv", !/\bautoAdv\b/.test(b.replace(/setAutoAdv/g, "")));
  check("1 · it NEVER reads observedAutomation", !/observedAutomation/.test(b));
  check("1 · no negation-of-label anywhere in it", !/!autoAdv/.test(b));
}

console.log(NL + "── 2 · ENGAGE is absolute too (not !label) ──");
{
  check("2 · the AUTO control is wired to toggleAuto", app.includes("onClick={() => { toggleAuto(); }}"));
  check("2 · AUTO-off routes through the ABSOLUTE stop, not label arithmetic", app.includes("if (autoAdv === true) await stopAutomation(); else await runEngage();"));
  check("2 · the STOP AUTO button is REMOVED (Jeff never asked for it)", !/STOP AUTO/.test(app));
  check("2 · runEngage hardcodes n = true (never derived)", /const runEngage = async \(\) => \{[\s\S]{0,120}const n = true;/.test(app));
  check("2 · the old `const n = !autoAdv` toggle is GONE", !/const n = !autoAdv;/.test(app));
}

console.log(NL + "── 3 · the operator origin is named at the choke point ──");
{
  check("3 · startDaemonAutomation is called with origin \"operator\"", /startDaemonAutomation\("operator"\)/.test(app));
}


console.log(`${NL}${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
