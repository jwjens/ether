'use strict';
// scripts/smoke-asset-types-parity.js — the two loaders must agree, always.
//
// src/lib/assetTypes.ts (renderer) and electron/asset-types.js (main + daemon) read the SAME
// shared/asset-types.json. That is the design. This asserts the main-side loader actually behaves the
// way the renderer's tests say the renderer's does — because the failure mode of two loaders is
// silent and awful: a type the log renders but rotation has never heard of, and nobody can see why.
//
// The renderer half is covered by src/lib/assetTypes.test.ts (29 assertions, including the openness
// test). This covers the main half and the shape of the shared file they both depend on.
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/smoke-asset-types-parity.js

const path = require('path');
const A = require(path.join(__dirname, '..', 'electron', 'asset-types.js'));
const RAW = require(path.join(__dirname, '..', 'shared', 'asset-types.json'));

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('=== smoke-asset-types-parity ===');

const CODES = ['SONG', 'SPOT', 'PROMO', 'SWEEPER', 'ANNOUNCEMENT', 'VOICE_TRACK', 'BED', 'SFX'];

console.log('\n── the shared file is the single definition ──');
check('shared/asset-types.json holds all eight', RAW.types.map(t => t.code).sort(), [...CODES].sort());
check('main loader sees the same eight', A.allTypes().map(t => t.code).sort(), [...CODES].sort());
check('codes are unique', new Set(RAW.types.map(t => t.code)).size, 8);
check('sort orders are unique', new Set(RAW.types.map(t => t.defaults.sortOrder)).size, 8);

console.log('\n── every type is completely specified ──');
const REQUIRED_TOP = ['code', 'badge', 'color', 'bg', 'border', 'commercial', 'metaTable', 'defaults'];
const REQUIRED_DEF = ['label', 'labelOne', 'rotationEligible', 'scheduler', 'bus',
                      'honorsSeparation', 'countsAsMusic', 'showAsTab', 'sortOrder'];
let missing = [];
for (const t of RAW.types) {
  for (const k of REQUIRED_TOP) if (!(k in t)) missing.push(`${t.code}.${k}`);
  for (const k of REQUIRED_DEF) if (!(k in t.defaults)) missing.push(`${t.code}.defaults.${k}`);
}
check('no type is missing a field', missing, []);

console.log('\n── DUCK IS A CHANNEL FUNCTION, not a type behaviour ──');
// Jeff, 2026-08-26. A duck flag here would be a control that does nothing at playout beside a ducker
// that works. If one is ever added, this fails and says why.
const duckLeak = [];
for (const t of RAW.types) {
  for (const k of ['ducks', 'duckable', 'duckImmune']) {
    if (k in t) duckLeak.push(`${t.code}.${k}`);
    if (k in t.defaults) duckLeak.push(`${t.code}.defaults.${k}`);
  }
}
check('no duck flag anywhere in the registry', duckLeak, []);

console.log('\n── capabilities, main side ──');
check('only SONG is rotation-eligible', A.rotationEligibleTypes(), ['SONG']);
check('only SONG counts as music', A.musicCountingTypes(), ['SONG']);
check('only SONG honours separation', A.separationTypes(), ['SONG']);
check('only SPOT is commercial', A.commercialTypes(), ['SPOT']);
check('source-channel types', A.typesWhere(b => b.bus === 'source-channel').sort(), ['ANNOUNCEMENT', 'BED', 'SFX']);
check('traffic-break types', A.typesWhere(b => b.scheduler === 'traffic-break').sort(), ['PROMO', 'SPOT']);

console.log('\n── normalizeType degrades, never vanishes ──');
check('null → SONG', A.normalizeType(null), 'SONG');
check("'' → SONG", A.normalizeType(''), 'SONG');
check('unknown → SONG', A.normalizeType('PODCAST'), 'SONG');
check('unknown is not "known"', A.isKnownType('PODCAST'), false);
check('case-insensitive', A.normalizeType('sweeper'), 'SWEEPER');

console.log('\n── sweepers are SWEEPERS, never jingles ──');
check('SWEEPER badge', A.typeDef('SWEEPER').badge, 'SWP');
check('SWEEPER label', A.typeDef('SWEEPER').defaults.label, 'Sweepers');
check('the word "jingle" appears nowhere in the registry',
  JSON.stringify(RAW.types).toLowerCase().includes('jingle'), false);

console.log('\n── placeholders build a safe IN-clause ──');
check('one type → one placeholder', A.placeholders(A.rotationEligibleTypes()), '?');
check('three → three', A.placeholders(['A', 'B', 'C']), '?, ?, ?');
check('empty → empty', A.placeholders([]), '');

console.log('\n── THE OPENNESS TEST, main side ──');
A.registerAssetType({
  code: 'NEWS', badge: 'NEWS', color: '#38bdf8', bg: '', border: '',
  commercial: false, metaTable: null,
  defaults: { label: 'News', labelOne: 'Newscast', rotationEligible: false,
              scheduler: 'log-element', bus: 'rotation-deck', honorsSeparation: false,
              countsAsMusic: false, showAsTab: true, sortOrder: 80 },
});
check('a ninth type registers', A.isKnownType('NEWS'), true);
check('rotation still excludes it — no edit to rotation', A.rotationEligibleTypes(), ['SONG']);
check('music metrics still exclude it', A.musicCountingTypes(), ['SONG']);
check('the affidavit still excludes it', A.commercialTypes(), ['SPOT']);
check('its log class IS its code', A.normalizeType('NEWS'), 'NEWS');
check('it sorts last', A.allTypes()[A.allTypes().length - 1].code, 'NEWS');
A.unregisterAssetType('NEWS');
check('and unregisters cleanly', A.allTypes().length, 8);

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');
process.exit(fail === 0 ? 0 : 1);
