'use strict';
// electron/sync/transformer-chain.js — run payload through migration script transformers [N-62].
//
// Discovers scripts via the same regex used by scripts/verify-transformer-chain.js:
//   migrate-.+-phase-sync-N.js  (N = target schema version)
//
// applyTransformerChain(payload, fromVersion, toVersion, envelope)
//   Runs transformers for versions fromVersion+1 .. toVersion in order.
//   Returns the transformed payload.
//
//   Throws TransformerMissingError if any required script file is absent —
//   callers must treat this as a permanent failure (no retry). A missing script
//   will not appear until a new deployment; retrying is deterministically pointless.
//
//   Any other transformer throw propagates; caller decides retry vs conflicted.

const path = require('path');
const fs   = require('fs');

const SCRIPTS_DIR  = path.join(__dirname, '..', '..', 'scripts');
const MIGRATION_RE = /^migrate-.+-phase-sync-(\d+)\.js$/;

// version → { filename, transformer } | null (null = confirmed missing)
const _cache = new Map();

class TransformerMissingError extends Error {
  constructor(version) {
    super(`No migration script for target v${version} — transformer chain cannot proceed`);
    this.name          = 'TransformerMissingError';
    this.code          = 'TRANSFORMER_MISSING';
    this.targetVersion = version;
  }
}

function _loadTransformer(targetVersion) {
  if (_cache.has(targetVersion)) {
    const cached = _cache.get(targetVersion);
    if (cached === null) throw new TransformerMissingError(targetVersion);
    return cached;
  }

  let found = null;
  try {
    for (const f of fs.readdirSync(SCRIPTS_DIR)) {
      const m = MIGRATION_RE.exec(f);
      if (m && parseInt(m[1], 10) === targetVersion) { found = f; break; }
    }
  } catch (_) {
    // SCRIPTS_DIR unreadable — treat as missing
  }

  if (!found) {
    _cache.set(targetVersion, null);
    throw new TransformerMissingError(targetVersion);
  }

  let mod;
  try {
    mod = require(path.join(SCRIPTS_DIR, found));
  } catch (e) {
    // MODULE_NOT_FOUND or any load error → permanent missing
    _cache.set(targetVersion, null);
    throw new TransformerMissingError(targetVersion);
  }

  if (typeof mod.payloadTransformer !== 'function') {
    _cache.set(targetVersion, null);
    throw new TransformerMissingError(targetVersion);
  }

  const entry = { filename: found, transformer: mod.payloadTransformer };
  _cache.set(targetVersion, entry);
  return entry;
}

/**
 * Upgrade payload from fromVersion to toVersion by running each intermediate
 * migration script's payloadTransformer in order.
 *
 * @param {object} payload       payload_after from the wire mutation
 * @param {number} fromVersion   schema_version on the mutation
 * @param {number} toVersion     local schema_version
 * @param {object} [envelope]    full mutation object (passed to each transformer)
 * @returns {object}             transformed payload
 * @throws {TransformerMissingError}  if any required script is absent (permanent — no retry)
 * @throws {Error}                    if a transformer throws (caller decides retry policy)
 */
function applyTransformerChain(payload, fromVersion, toVersion, envelope) {
  let current = payload;
  for (let v = fromVersion + 1; v <= toVersion; v++) {
    const { transformer } = _loadTransformer(v);
    current = transformer(current, fromVersion, envelope);
    if (current === null || current === undefined) {
      throw new Error(`Transformer for v${v} returned ${current} — expected an object`);
    }
  }
  return current;
}

module.exports = { applyTransformerChain, TransformerMissingError };
