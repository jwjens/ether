'use strict';
// Tests VU levels station-scoping (electron/levels-scope.js) — the shared source of truth for the main
// relay (scopeLevelsFrame) and the renderer meters (matchesStation, mirrored in src/lib/levelsScope.ts).
// Pure logic; runs under plain node. Covers the GO'd acceptance tests 1 (scoping) and 2 (fallback renders).
const assert = require('assert');
const { scopeLevelsFrame, matchesStation } = require('../electron/levels-scope');

const UUIDS = { 2: 'uuid-OV', 3: 'uuid-HALLOWEEN' };   // fake id->uuid map (station 2 = OV, 3 = Halloween)
const resolve = (id) => UUIDS[id] || null;
let n = 0; const ok = (m) => console.log(`  [${++n}] ${m} ✓`);

// ── relay transform: forward whole frame, swap integer id -> uuid, drop envelope + integer id ──
const ovFrame = scopeLevelsFrame({ event: 'levels', stationId: 2, a: 0.8, b: 0.1, c: 0, master: 0.8 }, resolve);
assert.strictEqual(ovFrame.stationUuid, 'uuid-OV', 'relay tags OV uuid');
assert.strictEqual(ovFrame.stationId, undefined, 'relay drops integer stationId (leak-guard)');
assert.strictEqual(ovFrame.event, undefined, 'relay drops pipe envelope');
assert.strictEqual(ovFrame.a, 0.8, 'relay forwards a (whole-frame invariant)');
ok('relay: whole frame forwarded, integer id -> uuid, envelope + integer id dropped');

const hwFrame = scopeLevelsFrame({ event: 'levels', stationId: 3, a: 0.2, b: 0, c: 0 }, resolve);
assert.strictEqual(hwFrame.stationUuid, 'uuid-HALLOWEEN');
assert.strictEqual(hwFrame.master, 0.2, 'relay derives master when absent (max of decks)');
ok('relay: Halloween frame tagged, master derived');

// ── TEST 1: two stations' frames each render ONLY on their own meters ──
assert.strictEqual(matchesStation(ovFrame, 'uuid-OV'), true,  'OV meter renders OV frame');
assert.strictEqual(matchesStation(hwFrame, 'uuid-OV'), false, 'OV meter DROPS Halloween frame');
assert.strictEqual(matchesStation(hwFrame, 'uuid-HALLOWEEN'), true,  'Halloween meter renders Halloween frame');
assert.strictEqual(matchesStation(ovFrame, 'uuid-HALLOWEEN'), false, 'Halloween meter DROPS OV frame (the reported bug)');
ok('TEST 1: each station renders only its own frames — OV no longer bleeds onto Halloween');

// ── TEST 2: fallback (in-process) frames still render, not filtered dark ──
const active = 2;
const fbFrame = scopeLevelsFrame({ a: 0.5, b: 0.5, c: 0, stationId: active }, resolve);
assert.strictEqual(fbFrame.stationUuid, 'uuid-OV', 'fallback tagged with active uuid');
assert.strictEqual(matchesStation(fbFrame, 'uuid-OV'), true, 'fallback frame RENDERS on the active meter');
ok('TEST 2: fallback frame is tagged + renders on the active meter (never filtered dark)');

// ── boot/edge nets: never go dark when uuid unknown ──
assert.strictEqual(matchesStation(ovFrame, ''), true, 'my uuid not resolved yet -> render');
assert.strictEqual(matchesStation({ a: 0.3 }, 'uuid-OV'), true, 'untagged frame -> render (edge)');
ok('boot/edge: unresolved-uuid and untagged frames render (never dark)');

console.log('\n✅ LEVELS STATION-SCOPING — ALL CHECKS PASS');
