'use strict';

// scripts/migrate-station-schema-phase-sync-11.js — Phase Sync-11
//
// Sync-protocol payload transformer for schema_version 11.
//
// The database migration for v11 is handled by main.js at startup:
//   - CREATE INDEX idx_macros_station_trigger ON macros(station_id, trigger_type, is_active)
//   - CREATE INDEX idx_macros_station_hotkey ON macros(station_id, hotkey, is_active) WHERE hotkey IS NOT NULL
//   - CREATE TABLE scheduling_rules (...)
//
// payloadTransformer: identity. v11 is a DDL-only change (indexes + new table).
// No payload field names, types, or structure changed.

module.exports = {
  payloadTransformer: function payloadTransformer(payload, fromVersion) {
    if (!payload || typeof payload !== 'object') return payload;
    return payload;
  },
};

// ── Migration body ────────────────────────────────────────────────────────────
const _scriptArg = process.argv.slice(1).find(a => !a.startsWith('-'));
const _isMain = require.main === module ||
  (_scriptArg && require('path').resolve(_scriptArg) === __filename);
if (_isMain) {
  console.log('[migrate-v11] v11 DDL (indexes + scheduling_rules) runs via main.js at startup.');
  console.log('[migrate-v11] This file provides only the sync-protocol payloadTransformer.');
  process.exit(0);
}
