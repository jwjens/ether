// audiod/smoke-meter-contract.js
//
// THE CONTRACT: every field a consumer reads off the engine's levels payload must be a key the engine
// actually emits.
//
// WHY THIS EXISTS, AND WHY THE FIRST VERSION OF THIS TEST WAS WRONG.
//
// In 4.6.9 six fields were added to the Rust `AudioLevels` struct — including proc_ride_bypass — and
// assigned by the audio thread. The Processor rack's BYPASS button was dead for two releases anyway,
// because `audio_get_levels` (native/src/lib.rs) does NOT serialize that struct: it HAND-BUILDS its
// JSON with `serde_json::json!` from an explicit key list. A field assigned to `lvl.` and not named in
// that list never crosses the NAPI boundary. `lv.proc_ride_bypass` was `undefined`, `!!undefined`
// fabricated a literal `false` onto every frame, and because `false` is not nullish the UI's
// `?? intent` fallback could never fire — the engine's fabricated answer overwrote the operator's own
// click. lib.rs carries a comment warning about exactly this, written after the SAME mistake lost the
// proc_* meters on 2026-07-31.
//
// The first version of this test checked for `lvl.<field> =` assignments in audio.rs. That is the
// WRONG BOUNDARY. It passed green while the six fields still never reached JS, and it fabricated a
// failure on `lv.master` — which IS emitted, as the key "master", mapped from `level_master`. A test
// aimed at the wrong seam is worse than no test: it certifies the defect and slanders working code.
//
// THE SEAM IS THE json! KEY LIST. That is the wire. This checks it.
//
// Static, deliberately: it must run in CI on a tree with no engine and no audio. It cannot prove a
// value is CORRECT — only that a producer exists for every key a consumer reads. That is exactly the
// class of defect that shipped twice.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log(`  OK   ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };

const libRs    = read("native/src/lib.rs");
const audioRs  = read("native/src/audio.rs");
const engineJs = read("audiod/engine.js");
const daemonJs = read("audiod/ether-audiod.js");

// Slice a brace-matched block and strip line comments — comments cannot define keys.
const blockFrom = (src, openIdx) => {
  let depth = 0, end = openIdx;
  for (let k = openIdx; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) { end = k; break; } }
  }
  return src.slice(openIdx, end + 1).replace(/\/\/[^\n]*/g, "");
};

// ── THE WIRE: the keys audio_get_levels actually emits ───────────────────────
const emitted = (() => {
  const fn = libRs.indexOf("pub fn audio_get_levels");
  if (fn < 0) throw new Error("audio_get_levels not found — has lib.rs been restructured?");
  const j = libRs.indexOf("serde_json::json!", fn);
  if (j < 0) throw new Error("audio_get_levels no longer hand-builds JSON — re-point this test at the new producer");
  const body = blockFrom(libRs, libRs.indexOf("{", j));
  const keys = new Set();
  for (const m of body.matchAll(/"([a-z0-9_]+)"\s*:/gi)) keys.add(m[1]);
  return keys;
})();

// ── THE CONSUMERS: every lv.<key> the JS side reads ──────────────────────────
const readsOf = (src) => {
  const s = new Set();
  for (const m of src.matchAll(/\blv\.([a-z0-9_]+)/g)) s.add(m[1]);
  return s;
};
const allReads = new Set([...readsOf(engineJs), ...readsOf(daemonJs)]);

console.log(`\naudio_get_levels emits ${emitted.size} keys - JS reads ${allReads.size} distinct lv.* keys\n`);

// A read with no emitter is ACCEPTABLE only as the dead half of an OR whose primary IS emitted. Each
// entry names the expression that saves it; if that expression changes, the tolerance must be revisited.
const TOLERATED = {
  // engine.js: `const legacy = lv.cart || lv.level_cart || 0;`  The json! key is "cart" (mapped from
  // the struct field level_cart), so the PRIMARY is live and the second term is a dead legacy fallback.
  level_cart: 'dead half of `lv.cart || lv.level_cart || 0` - the primary key "cart" is emitted',
};

// ── RULE 1 — no consumer reads a key the engine does not emit ────────────────
console.log("RULE 1 - every lv.<key> read in JS is emitted by audio_get_levels");
{
  for (const [k, why] of Object.entries(TOLERATED)) {
    if (allReads.has(k) && !emitted.has(k)) console.log(`  --   lv.${k} tolerated - ${why}`);
  }
  const orphans = [...allReads].filter(k => !emitted.has(k) && !TOLERATED[k]).sort();
  if (!orphans.length) {
    ok(`all ${allReads.size} keys read by the frame builders are emitted`);
  } else {
    for (const k of orphans) {
      // Two distinct failure shapes: a field that exists in Rust but never reached the wire (the
      // 4.6.9 defect), versus a name that exists nowhere (a typo).
      const inStruct = new RegExp(`\\blvl\\.${k}\\s*=`).test(audioRs);
      bad(inStruct
        ? `lv.${k} - assigned to AudioLevels in audio.rs but NEVER NAMED in the json! block, so it dies at the NAPI boundary and reads undefined`
        : `lv.${k} - no such key is emitted and no such field is assigned; this read is a typo or a removed field`);
    }
  }
}

// ── RULE 2 — the two proc-meters frame builders agree ───────────────────────
// The frame is built twice: engine.js in-process, ether-audiod.js in the daemon. A renderer cannot
// tell which one it is talking to, so a key in one and not the other breaks exactly one deployment.
console.log("\nRULE 2 - the in-process and daemon proc-meters frames carry the same keys");
{
  const frameKeys = (src, marker) => {
    const i = src.indexOf(marker);
    if (i < 0) throw new Error(`frame builder not found: ${marker}`);
    const body = blockFrom(src, src.indexOf("{", src.lastIndexOf("(", i)));
    const keys = new Set();
    for (const m of body.matchAll(/[,{]\s*([a-zA-Z][a-zA-Z0-9_]*)\s*:/g)) keys.add(m[1]);
    keys.delete("event");   // the daemon's broadcast envelope, not a frame field
    return keys;
  };
  const a = frameKeys(engineJs, 'this.emit("procmeters"');
  const b = frameKeys(daemonJs, 'event: "procmeters"');
  const onlyA = [...a].filter(k => !b.has(k) && k !== "stationId").sort();
  const onlyB = [...b].filter(k => !a.has(k) && k !== "stationId").sort();
  if (!onlyA.length && !onlyB.length) ok(`both proc-meters builders carry the same ${a.size} keys`);
  else {
    onlyA.forEach(k => bad(`"${k}" is emitted by engine.js but NOT by the daemon - missing for daemon stations`));
    onlyB.forEach(k => bad(`"${k}" is emitted by the daemon but NOT by engine.js - missing in-process`));
  }
}

// ── RULE 3 — the processor echo, named one control at a time ────────────────
// Named individually rather than left to rule 1, so a failure says WHICH control goes dead.
console.log("\nRULE 3 - the processor echo the rack depends on reaches JS");
{
  const REQUIRED = {
    proc_ride_bypass:    "the rack BYPASS chip and banner (ride)",
    proc_limiter_bypass: "the LIMITER BYPASSED warning - nothing is holding the ceiling",
    proc_ceiling_dbtp:   "the ceiling Settings reports as observed",
    proc_release_ms:     "the release readback",
    proc_ride_rate:      "the ride-rate readback",
    proc_ride_clamp:     "the ride-clamp readback",
    proc_ride_gain_db:   "the RIDE applied-gain meter",
    proc_gr_db:          "the gain-reduction meter and MAX 10s",
    proc_in_lufs:        "the IN meter, and the would-ride projection derived from it",
    proc_out_lufs:       "the OUT meter",
  };
  for (const [key, what] of Object.entries(REQUIRED)) {
    const assigned = new RegExp(`\\blvl\\.${key}\\s*=`).test(audioRs);
    if (!assigned)              bad(`${key} is never assigned in audio.rs - ${what} has no source`);
    else if (!emitted.has(key)) bad(`${key} is assigned but NOT EMITTED by audio_get_levels - ${what} will read undefined forever`);
    else                        ok(`${key} -> assigned, emitted, reaches ${what}`);
  }
}

// ── RULE 4 — the number re-assert cannot clear a bypass ─────────────────────
// Structural. Bypass used to ride the numbers command, and the daemon periodic re-assert had to pass
// something for it, so it passed false - silently un-bypassing whatever the operator engaged, every 15s.
console.log("\nRULE 4 - the periodic number re-assert cannot clear a bypass");
{
  // EVERY call, not the first: the re-assert now sends one per branch, and a literal bypass argument
  // slipping into either would resurrect the defect on that branch alone.
  const calls = [...engineJs.matchAll(/A\.audioSetProcessorParams\(([^)]*)\)/g)].map(x => x[1]);
  if (!calls.length) bad("engine.js no longer calls audioSetProcessorParams - has the re-assert moved?");
  else {
    let clean = true;
    for (const c of calls) {
      const args = c.split(",").map(x => x.trim());
      if (args.some(a => a === "false" || a === "true")) {
        bad(`a re-assert call passes a literal bypass argument (${args.join(", ")}) - it will clear an engaged bypass`);
        clean = false;
      } else if (args.length !== 7) {
        bad(`a re-assert call passes ${args.length} args; the numbers-only signature takes 7 (station, branch, target + 4 numbers)`);
        clean = false;
      }
    }
    if (clean) ok(`all ${calls.length} re-assert calls use the numbers-only signature - no bypass argument to get wrong`);
  }
  if (/audioSetProcessorBypass/.test(daemonJs)) ok("the daemon exposes a separate setProcessorBypass command");
  else bad("no separate bypass command in the daemon - bypass is riding the numbers path again");
}

// ── RULE 5 — commands report the engine's real result ───────────────────────
console.log("\nRULE 5 - processor commands report the engine real result");
{
  const line = /setProcessorParams:\s*\(m\)\s*=>([^\n]*)/.exec(daemonJs);
  if (!line) bad("setProcessorParams handler not found in the daemon");
  else if (/return true;/.test(line[1])) bad("setProcessorParams returns a literal true - a command that never landed reports success");
  else ok("setProcessorParams returns the engine own boolean");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
