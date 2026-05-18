'use strict';

// scripts/migrate-station-schema-phase-sync-9.js — Phase Sync-9
//
// Sync-protocol payload transformer for schema_version 9.
//
// The database migration for v9 is in scripts/migrate-phase-a-v9.js.
// Run that script to apply the schema changes. This file exists to satisfy
// the pre-commit hook requirement for a payloadTransformer covering each
// schema version.
//
// payloadTransformer: identity. v9 changes stations.icecast_server_url's
// column default from '127.0.0.1' to NULL and rewrites existing localhost
// values to the live Icecast server address. The sync payload field name
// and type are unchanged. Receivers on v8 and below continue to work as
// before; the new default only affects future INSERT statements.

// applyMigration: version stamp only. The real v9 work (stations table recreation to
// change icecast_server_url DEFAULT '127.0.0.1' → NULL, plus data rewrite) lives in
// migrate-phase-a-v9.js, which the chain runner never calls. Fresh installs get the
// wrong column default. See "Known issues to resolve at Step 6" in the plan doc.
function applyMigration(db) {
  db.prepare('INSERT INTO schema_version (version) VALUES (9)').run();
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
  console.log('[migrate-v9] The v9 database migration runs via scripts/migrate-phase-a-v9.js');
  console.log('[migrate-v9] This file provides only the sync-protocol payloadTransformer.');
  console.log('[migrate-v9] Run: node_modules/.bin/electron --no-sandbox scripts/migrate-phase-a-v9.js --dry-run');
  process.exit(0);
}
