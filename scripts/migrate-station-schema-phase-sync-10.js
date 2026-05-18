'use strict';

// scripts/migrate-station-schema-phase-sync-10.js — Phase Sync-10
//
// Sync-protocol payload transformer for schema_version 10.
//
// The database migration for v10 is in scripts/migrate-phase-a-v10.js.
// Run that script to apply the data changes. This file exists to satisfy
// the pre-commit hook requirement for a payloadTransformer covering each
// schema version.
//
// payloadTransformer: identity. v10 is a data-only backfill — it copies
// built-in metadata_definitions and metadata_vocabulary rows from station 1
// to all stations that were created after the v6 migration ran. No payload
// field names, types, or structure changed.

// applyMigration: version stamp only. The real v10 work (data backfill — copy
// metadata_definitions and metadata_vocabulary from station 1 to stations that
// missed v6 seeding) lives in migrate-phase-a-v10.js, which the chain runner
// never calls. V10's gap is subsumed by the migration-6 seeding fix — if m-6
// seeds station 1 correctly, v10 is a no-op on a fresh install. Note: phase-a-v10
// also stamps system_state.schema_version = '10'; the chain runner does not.
// See "Known issues to resolve at Step 6" in docs/fresh-install-option-b-plan.md.
function applyMigration(db) {
  db.prepare('INSERT INTO schema_version (version) VALUES (10)').run();
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
  console.log('[migrate-v10] The v10 database migration runs via scripts/migrate-phase-a-v10.js');
  console.log('[migrate-v10] This file provides only the sync-protocol payloadTransformer.');
  console.log('[migrate-v10] Run: node_modules/.bin/electron --no-sandbox scripts/migrate-phase-a-v10.js --dry-run');
  process.exit(0);
}
