'use strict';

// scripts/migrate-station-schema-phase-sync-8.js — Phase Sync-8
//
// Sync-protocol payload transformer for schema_version 8.
//
// The database migration for v8 is in scripts/migrate-phase-a-v8.js.
// Run that script to apply the schema changes. This file exists to satisfy
// the pre-commit hook requirement for a payloadTransformer covering each
// schema version.
//
// payloadTransformer: identity. v8 adds new columns to stations
// (icecast_port, audio_device_output, mic_device, mount_pending_provision)
// and new tables (install_config_kv, install_secrets_kv, monitor_routing).
// No existing sync payload fields are renamed, removed, or restructured.
// Receivers on v8 apply column defaults for new stations fields absent in
// v7 payloads. New tables have no v7 payload history to transform.
// monitor_routing is local-only and never appears in any sync payload.

// applyMigration: version stamp only. The 12-step v8 schema work (4 station columns,
// monitor_routing, install_config_kv, install_secrets_kv, station_config_kv rebuild)
// lives in migrate-phase-a-v8.js, which the chain runner never calls. On a fresh
// install this stamps version 8 without applying those changes — see "Known issues
// to resolve at Step 6" in docs/fresh-install-option-b-plan.md.
function applyMigration(db) {
  db.prepare('INSERT INTO schema_version (version) VALUES (8)').run();
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload, fromVersion) {
    if (!payload || typeof payload !== 'object') return payload;
    return payload;
  },
  applyMigration,
};

// ── Migration body ────────────────────────────────────────────────────────────
// _isMain guard: required because Electron's bootstrapper owns require.main.

const _scriptArg = process.argv.slice(1).find(a => !a.startsWith('-'));
const _isMain = require.main === module ||
  (_scriptArg && require('path').resolve(_scriptArg) === __filename);
if (_isMain) {
  console.log('[migrate-v8] The v8 database migration runs via scripts/migrate-phase-a-v8.js');
  console.log('[migrate-v8] This file provides only the sync-protocol payloadTransformer.');
  console.log('[migrate-v8] Run: node_modules/.bin/electron --no-sandbox scripts/migrate-phase-a-v8.js --dry-run');
  process.exit(0);
}
