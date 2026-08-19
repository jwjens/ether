// scripts/test-health-frame.js — the fleet health frame, built and checked with NO Electron, no
// daemon and no database. Run: node scripts/test-health-frame.js
//
// The frame is a projection of state the app already observes (docs/web-health-monitor-design-
// 2026-08-18.md §2), so the thing worth testing is that the projection is FAITHFUL: real field names
// from the real sources, nulls preserved as "not observed" rather than flattened to zero, and identity
// carried as UUID. It also prints the exact JSON that would go on the wire and its size, so the design
// doc's payload-cost numbers are measured rather than guessed.

const assert = require("node:assert/strict");
const { buildHealthFrame, buildHealthFrames } = require("../electron/health-frame");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// A snapshot shaped exactly like electron/audio-health.js:281-294 produces.
const SNAPSHOT = {
  ts: "2026-08-18T23:30:00.000Z",
  mode: "daemon",
  engine: { pid: 27720, uptimeSec: 1480, restartCount: 0, pingMs: 3 },
  stations: [
    {
      uuid: "11111111-1111-1111-1111-111111111111", stationId: 1, name: "Open Format",
      level: "GREEN", reason: "", framesPerSec: 90, peak: 0.412, activeDecks: 1,
      queueDepth: 12, nextDeckReady: true, track: "Love On Top", trackLeftSec: 96,
      streaming: true, drainBps: 16000, enginestate: "live",
      levelSince: "2026-08-18T22:10:00.000Z", jingle: null,
    },
    {
      uuid: "22222222-2222-2222-2222-222222222222", stationId: 2, name: "halloVeen",
      level: "RED", reason: "queue empty", framesPerSec: 90, peak: 0, activeDecks: 0,
      queueDepth: 0, nextDeckReady: false, track: null, trackLeftSec: null,
      streaming: false, drainBps: 0, enginestate: "off",
      levelSince: "2026-08-18T23:00:00.000Z", jingle: null,
    },
    // No uuid — an un-migrated row has no cloud identity and must be skipped, not pushed as null.
    { uuid: null, stationId: 9, name: "Legacy", level: "GREEN" },
  ],
  recentEvents: [],
};

// designation:status rows — real field names from electron/generation-designation.js:111-122
// plus what main.js adds at the _desigStatus.set call.
const DESIGNATIONS = [
  { stationId: 1, station: "Open Format", level: "green", state: "mine",
    holder: "machine-abc", holderName: "OVEVENTS", lastChecked: 1755555555,
    lastGenerated: 1755550000, checkedAgeSec: 42, autoOn: true, writeError: null,
    text: "This machine — checked in 42s ago" },
];

// runway.computeRunway shape — electron/runway.js:58,96.
const RUNWAY = {
  1: { metric: "first-gap", days: 6.5, hours: 156, level: "green", gapAt: null, through: "Aug 25 2026", capped: false },
  // days:null is "no active show" — NOT zero days. This is the distinction runway_history preserved.
  2: { metric: "first-gap", days: null, hours: null, level: "grey", gapAt: null, through: null, capped: false, reason: "no active show" },
};

// A decimated procmeters sample — audiod/engine.js:325-335 plus main's retention fields.
const PROC = {
  1: { local: true, stream: false, target: -14, inLufs: -18.3, outLufs: -14.1,
       rideGainDb: 4.2, grDb: -0.3, inPeakDb: -6.1, outPeakDb: -1.2,
       sampledAt: "2026-08-18T23:30:00.000Z", windowPeakDb: -0.9 },
};

const frames = buildHealthFrames({
  snapshot: SNAPSHOT,
  designations: DESIGNATIONS,
  runwayFor: (sid) => RUNWAY[sid] || null,
  procFor: (sid) => PROC[sid] || null,
  machineId: "machine-abc",
  cadenceSec: 60,
  now: Date.parse("2026-08-18T23:30:00.000Z"),
});

console.log("\nbuildHealthFrames");
test("one frame per station WITH a uuid — the un-migrated station is skipped", () => {
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map(f => f.stationUuid), [
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
  ]);
});
test("row_uuid is station:machine so two machines never overwrite each other", () => {
  assert.equal(frames[0].row.uuid, "11111111-1111-1111-1111-111111111111:machine-abc");
  assert.equal(frames[1].row.uuid, "22222222-2222-2222-2222-222222222222:machine-abc");
});
test("identity is UUID — no local integer station id is carried as identity", () => {
  const json = JSON.stringify(frames[0].row);
  assert.ok(!("stationId" in frames[0].row), "stationId must not be a frame field");
  assert.ok(!("station_id" in frames[0].row), "station_id must not be a frame field");
  assert.ok(json.includes("11111111-1111-1111-1111-111111111111"));
});
test("cadence and observedAt ride along for the staleness rule", () => {
  assert.equal(frames[0].row.cadence, 60);
  assert.equal(frames[0].row.observedAt, "2026-08-18T23:30:00.000Z");
});

console.log("\nfaithfulness to the sources");
test("level and reason come through verbatim", () => {
  assert.equal(frames[0].row.level, "GREEN");
  assert.equal(frames[1].row.level, "RED");
  assert.equal(frames[1].row.reason, "queue empty");
});
test("designation uses the module's real field names", () => {
  const d = frames[0].row.designation;
  assert.equal(d.state, "mine");
  assert.equal(d.holder, "machine-abc");
  assert.equal(d.holderName, "OVEVENTS");
  assert.equal(d.checkedAgeSec, 42);
  assert.equal(d.text, "This machine — checked in 42s ago");
});
test("a station with no designation row reports null, not a fabricated one", () => {
  assert.equal(frames[1].row.designation, null);
});
test("runway days:null survives as null — 'no active show' is NOT zero days", () => {
  assert.equal(frames[1].row.runway.days, null);
  assert.equal(frames[1].row.runway.level, "grey");
  assert.equal(frames[1].row.runway.reason, "no active show");
  assert.equal(frames[0].row.runway.days, 6.5);
  assert.equal(frames[0].row.runway.through, "Aug 25 2026");
});
test("the processing trio carries ride and limiter as separate facts", () => {
  const p = frames[0].row.proc;
  assert.equal(p.rideGainDb, 4.2);   // the RIDE's applied gain — what the bars show
  assert.equal(p.grDb, -0.3);        // the LIMITER's reduction — 0 at steady state by design
  assert.equal(p.windowPeakDb, -0.9);
});
test("a station with processing off reports null rather than a zeroed trio", () => {
  assert.equal(frames[1].row.proc, null);
});
test("in-process mode is carried — it is itself a degraded state", () => {
  const f = buildHealthFrame({
    station: SNAPSHOT.stations[0], engine: SNAPSHOT.engine, mode: "in-process",
    designation: null, runway: null, proc: null, machineId: "m", cadenceSec: 60,
    nowIso: "2026-08-18T23:30:00.000Z",
  });
  assert.equal(f.mode, "in-process");
});
test("an empty snapshot yields no frames rather than throwing", () => {
  assert.deepEqual(buildHealthFrames({ snapshot: null, machineId: "m", cadenceSec: 60 }), []);
  assert.deepEqual(buildHealthFrames({ snapshot: { stations: [] }, machineId: "m", cadenceSec: 60 }), []);
});

console.log("\nmeasured payload cost (the design doc's §3.2 numbers, not estimated)");
for (const f of frames) {
  const bytes = Buffer.byteLength(JSON.stringify(f.row), "utf8");
  console.log(`  ${String(bytes).padStart(5)} bytes  ${f.row.station_name}`);
}
const avg = Math.round(
  frames.reduce((a, f) => a + Buffer.byteLength(JSON.stringify(f.row), "utf8"), 0) / frames.length
);
console.log(`  ${String(avg).padStart(5)} bytes  average → heartbeat 60s ≈ ${(avg * 1440 / 1e6).toFixed(2)} MB/station/day`);

console.log("\n--- the exact JSON that goes on the wire (station 1) ---");
console.log(JSON.stringify(frames[0].row, null, 2));

console.log(`\n${passed} passed${process.exitCode ? " — WITH FAILURES" : ""}\n`);
