'use strict';
// electron/asset-types.js — the asset type registry, main + daemon side.
//
// SAME DATA AS THE RENDERER. Both this and src/lib/assetTypes.ts read shared/asset-types.json. There
// is one definition and two loaders, deliberately: a type present in one and not the other is how a
// row becomes invisible to half the product — the log shows it, rotation does not, and nobody can see
// why.
//
// Keep the two loaders' behaviour identical. If one gains a capability helper, so does the other, and
// the meanings must not drift. The JSON is the contract between them.
//
// docs/library-asset-build-plan-2026-08-26.md · docs/asset-type-fixed-vs-configurable-2026-08-26.md

const path = require('path');

let REGISTRY;
try {
  REGISTRY = require(path.join(__dirname, '..', 'shared', 'asset-types.json'));
} catch (e) {
  // A missing registry must never stop playout. Degrade to the one type that keeps rotation working
  // and say so loudly — a silent empty registry would make EVERY asset ineligible for everything.
  console.error('[asset-types] shared/asset-types.json unreadable (' + e.message + ') — degrading to SONG only');
  REGISTRY = { types: [{
    code: 'SONG', badge: '', color: '', bg: '', border: '', commercial: false, metaTable: null,
    defaults: { label: 'Songs', labelOne: 'Song', rotationEligible: true, scheduler: 'rotation',
                bus: 'rotation-deck', honorsSeparation: true, countsAsMusic: true,
                showAsTab: true, sortOrder: 10 },
  }] };
}

const FALLBACK_TYPE = 'SONG';
const EXTRA = [];

function registerAssetType(def) {
  const i = EXTRA.findIndex(d => d.code === def.code);
  i >= 0 ? EXTRA.splice(i, 1, def) : EXTRA.push(def);
}
function unregisterAssetType(code) {
  const i = EXTRA.findIndex(d => d.code === code);
  if (i >= 0) EXTRA.splice(i, 1);
}

function allTypes() {
  return [...(REGISTRY.types || []), ...EXTRA]
    .sort((a, b) => (a.defaults.sortOrder - b.defaults.sortOrder));
}

function typeDef(code) {
  const k = String(code == null ? '' : code).trim().toUpperCase();
  return allTypes().find(t => t.code === k)
      || allTypes().find(t => t.code === FALLBACK_TYPE)
      || allTypes()[0];
}

/** NULL, '' and an unknown code all degrade to SONG — an asset must never vanish from a log. */
function normalizeType(code) {
  const d = typeDef(code);
  return d ? d.code : FALLBACK_TYPE;
}

function isKnownType(code) {
  const k = String(code == null ? '' : code).trim().toUpperCase();
  return allTypes().some(t => t.code === k);
}

/** The codes matching a capability — the ONLY way a query learns which types it wants. */
function typesWhere(pred) {
  return allTypes().filter(t => pred(t.defaults, t)).map(t => t.code);
}

/** `?, ?, ?` for an IN-clause, so no query ever spells a type literal. */
function placeholders(codes) {
  return codes.map(() => '?').join(', ');
}

const rotationEligibleTypes = () => typesWhere(b => b.rotationEligible);
const musicCountingTypes    = () => typesWhere(b => b.countsAsMusic);
const separationTypes       = () => typesWhere(b => b.honorsSeparation);
const commercialTypes       = () => allTypes().filter(t => t.commercial).map(t => t.code);

module.exports = {
  FALLBACK_TYPE,
  allTypes, typeDef, normalizeType, isKnownType,
  typesWhere, placeholders,
  rotationEligibleTypes, musicCountingTypes, separationTypes, commercialTypes,
  registerAssetType, unregisterAssetType,
};
