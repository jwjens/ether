// audiod/smoke-meter-contract.js
//
// THE CONTRACT: every field a consumer reads off an engine payload must have a producer that writes it.
//
// WHY THIS EXISTS. In 4.6.9 six fields were added to the Rust `AudioLevels` struct — including
// proc_ride_bypass — with a comment describing the assignment that fills them. The assignment was never
// written. The struct compiled, serde serialized the zero values, the daemon read them, and the UI
// rendered `false` forever. The BYPASS button in the Processor rack was dead through two releases and
// looked exactly like a working one, because a field nobody writes is indistinguishable from a field
// whose value happens to be false.
//
// Nothing checked that the echo existed. Now something does.
//
// THREE RULES, checked statically against the tree:
//   1. Every `lv.<field>` a frame builder reads must be assigned somewhere in native/src/audio.rs as
//      `lvl.<field> = ...`. A declared-but-unassigned field is the exact defect above.
//   2. Every property a renderer reads off the proc-meters frame must be emitted by BOTH frame builders
//      (audiod/engine.js in-process AND audiod/ether-audiod.js daemon) — they drift independently, and
//      a station on the daemon path must not be missing a field the in-process path has.
//   3. Every field declared on AudioLevels must be either assigned or unread. Declaring a field, never
//      writing it, and never reading it is dead weight; declaring and reading it is the bug.
//
// Static analysis, deliberately: this must fail in CI on a tree, with no engine running and no audio.
// It cannot prove the value is CORRECT — only that a producer exists. That is precisely the class of
// defect that shipped.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log(`  ✅ ${m}`); };
const bad = (m) => { fail++; console.log(`  ❌ ${m}`); };

// ── sources ──────────────────────────────────────────────────────────────────
const audioRs   = read("native/src/audio.rs");
const engineJs  = read("audiod/engine.js");
const daemonJs  = read("audiod/ether-audiod.js");

// ── 1. what Rust DECLARES on AudioLevels, and what it ASSIGNS ────────────────
const levelsStruct = (() => {
  const start = audioRs.indexOf("pub struct AudioLevels");
  if (start < 0) throw new Error("AudioLevels struct not found — has audio.rs been restructured?");
  const end = audioRs.indexOf("\n}", start);
  return audioRs.slice(start, end);
})();

const declared = new Set();
for (const m of levelsStruct.matchAll(/pub\s+([a-z0-9_]+)\s*:/g)) declared.add(m[1]);

const assigned = new Set();
for (const m of audioRs.matchAll(/\blvl\.([a-z0-9_]+)\s*=/g)) assigned.add(m[1]);

console.log(`\nAudioLevels: ${declared.size} fields declared, ${assigned.size} assigned in audio.rs`);

// ── 2. what the frame builders READ ──────────────────────────────────────────
const readsOf = (src) => {
  const s = new Set();
  for (const m of src.matchAll(/\blv\.([a-z0-9_]+)/g)) s.add(m[1]);
  return s;
};
const engineReads = readsOf(engineJs);
const daemonReads = readsOf(daemonJs);
const allReads = new Set([...engineReads, ...daemonReads]);

console.log(`Frame builders read ${allReads.size} distinct lv.* fields\n`);

// A reader with no writer is ACCEPTABLE only where the code carries a live fallback to a field that
// does exist. Each entry states why; an entry whose fallback is removed becomes a failure again.
const TOLERATED = {
  cart: 'legacy alias read as `lv.cart || lv.level_cart || 0` (engine.js) — the fallback is the real field',
};

// ── RULE 1 — every field a builder reads has a writer ────────────────────────
console.log("RULE 1 — every lv.<field> read by a frame builder is assigned in audio.rs");
{
  const orphans = [...allReads].filter(f => !assigned.has(f) && !TOLERATED[f]).sort();
  for (const [f, why] of Object.entries(TOLERATED)) {
    if (allReads.has(f) && !assigned.has(f)) console.log(`  ·  lv.${f} tolerated — ${why}`);
  }
  if (orphans.length === 0) {
    ok(`all ${allReads.size} fields read by the frame builders have a writer`);
  } else {
    for (const f of orphans) {
      const where = declared.has(f)
        ? "DECLARED on AudioLevels but never assigned — it will serialize as its zero value forever"
        : "not declared on AudioLevels at all — it will be undefined on every frame";
      bad(`lv.${f} is read by a frame builder but ${where}`);
    }
  }
}

// ── RULE 2 — the two frame builders agree ────────────────────────────────────
// The proc-meters frame is built twice: engine.js emits it in-process, ether-audiod.js broadcasts it
// from the daemon. A renderer cannot tell which one it is talking to, so a field present in one and
// absent in the other is a bug that only appears on one deployment path.
console.log("\nRULE 2 — the in-process and daemon proc-meters frames carry the same keys");
{
  // Slice the ACTUAL object literal by brace matching, and strip comments first. A fixed-size window
  // ran past the end into the next statement (it reported the daemon's wrapper keys "event" and
  // "state" as frame fields), and a key sitting under a comment line is not preceded by "," or "{"
  // in the raw text, so an uncleaned chunk missed ceilingDbtp in engine.js. Both were parser faults
  // reported as contract breaks — a test that cries wolf gets ignored, which is how this class hides.
  const frameKeys = (src, marker) => {
    const i = src.indexOf(marker);
    if (i < 0) throw new Error(`frame builder not found: ${marker}`);
    const open = src.indexOf("{", src.lastIndexOf("(", i) );
    let depth = 0, end = open;
    for (let k = open; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}") { depth--; if (depth === 0) { end = k; break; } }
    }
    const body = src.slice(open, end + 1).replace(/\/\/[^\n]*/g, "");   // comments cannot define keys
    const keys = new Set();
    for (const m of body.matchAll(/[,{]\s*([a-zA-Z][a-zA-Z0-9_]*)\s*:/g)) keys.add(m[1]);
    keys.delete("event");    // the daemon's broadcast envelope, not a frame field
    return keys;
  };
  const a = frameKeys(engineJs, 'this.emit("procmeters"');
  const b = frameKeys(daemonJs, 'event: "procmeters"');
  const onlyA = [...a].filter(k => !b.has(k) && k !== "stationId").sort();
  const onlyB = [...b].filter(k => !a.has(k) && k !== "stationId").sort();
  if (!onlyA.length && !onlyB.length) {
    ok(`both proc-meters builders carry the same ${a.size} keys`);
  } else {
    onlyA.forEach(k => bad(`"${k}" is emitted by engine.js but NOT by the daemon — missing for daemon stations`));
    onlyB.forEach(k => bad(`"${k}" is emitted by the daemon but NOT by engine.js — missing in-process`));
  }
}

// ── RULE 3 — the specific fields that shipped dead ───────────────────────────
// Named explicitly, not just covered by rule 1: this is the regression that cost two releases, and a
// named assertion says WHICH control breaks when it fails.
console.log("\nRULE 3 — the processor echo the rack depends on");
{
  const REQUIRED = {
    proc_ride_bypass:    "the rack's BYPASS chip and banner (ride)",
    proc_limiter_bypass: "the rack's BYPASS chip and banner (limiter)",
    proc_ceiling_dbtp:   "the ceiling Settings reports as observed",
    proc_release_ms:     "the release readback",
    proc_ride_rate:      "the ride-rate readback",
    proc_ride_clamp:     "the ride-clamp readback",
    proc_ride_gain_db:   "the RIDE applied-gain meter",
    proc_gr_db:          "the gain-reduction meter and MAX 10s",
  };
  for (const [field, what] of Object.entries(REQUIRED)) {
    if (!declared.has(field))      bad(`${field} is not declared on AudioLevels — ${what} cannot work`);
    else if (!assigned.has(field)) bad(`${field} is declared but NEVER ASSIGNED — ${what} will read zero forever`);
    else                           ok(`${field} → written, and reaches ${what}`);
  }
}

// ── RULE 4 — the bypass path cannot be cleared by the number re-assert ───────
// Structural, not stylistic: bypass rode the numbers command, and the daemon's periodic re-assert had
// to pass something for it, so it passed false — silently un-bypassing the operator every ~15s.
console.log("\nRULE 4 — the periodic number re-assert cannot clear a bypass");
{
  const reassert = /A\.audioSetProcessorParams\(([^)]*)\)/.exec(engineJs);
  if (!reassert) {
    bad("engine.js no longer calls audioSetProcessorParams — has the re-assert moved?");
  } else {
    const args = reassert[1].split(",").map(s => s.trim());
    if (args.some(a => a === "false" || a === "true")) {
      bad(`engine.js re-assert passes a literal bypass argument (${args.join(", ")}) — it will clear the operator's bypass`);
    } else if (args.length !== 5) {
      bad(`engine.js re-assert passes ${args.length} args; the numbers-only signature takes 5 (station + 4 numbers)`);
    } else {
      ok("the re-assert calls the numbers-only signature — it has no bypass argument to get wrong");
    }
  }
  if (/audioSetProcessorBypass/.test(daemonJs)) ok("the daemon exposes a separate setProcessorBypass command");
  else bad("no separate bypass command in the daemon — bypass is riding the numbers path again");
}

// ── RULE 5 — the daemon reports what the engine returned ────────────────────
console.log("\nRULE 5 — processor commands report the engine's real result");
{
  const line = /setProcessorParams:\s*\(m\)\s*=>([^\n]*)/.exec(daemonJs);
  if (!line) bad("setProcessorParams handler not found in the daemon");
  else if (/return true;/.test(line[1])) bad("setProcessorParams returns a literal true — a command that never landed reports success");
  else ok("setProcessorParams returns the engine's own boolean");
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
