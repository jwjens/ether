'use strict';
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE AUDIO LIBRARY INDEX — ONE definition of "is this file in the library"
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS. There were two matchers, and they disagreed:
//
//   • library-folders.js  — norm()-based: lower-case, strip "_spotdown.org", drop all punctuation,
//     and match a SONG TITLE against a filename stem. Tolerant, and battle-tested by Re-sync.
//   • library-health.js   — exact, lower-cased BASENAME membership. Cheap, and strict.
//
// So the health signal could report a row `dead` that Re-sync would have relinked without
// complaint — two answers to "is the same file here", from one machine, about one folder. That is
// the same disease as everything else this week: a second implementation of a decision that should
// have had one.
//
// Jeff's ruling (2026-09-04): "Not two definitions of the same file. One module, both indexes built
// in the same walk."
//
// So: ONE walk of the audio library produces BOTH indexes. Callers choose which question they are
// asking — exact or tolerant — and every caller gets the same answer to the same question.

const fs = require('fs');
const path = require('path');

const AUDIO = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.aif', '.aiff', '.wma']);

/**
 * Tolerant name key. Moved here verbatim from library-folders.js so Re-sync's matching does not
 * change behaviour — it was conservative on purpose (we match within ONE folder, so exact-ish is
 * right) and it has been relinking real libraries for months.
 */
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/_spotdown\.org|spotdown\.org/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Walk the audio library ONCE and build both indexes.
 *
 * @param   {string} root
 * @param   {{maxDepth?: number}} opts
 * @returns {{ byBasename: Map<string,string>, byNorm: Map<string,string>, files: number, root: string|null }}
 *          byBasename — lower-cased "song.mp3" -> absolute path   (exact question)
 *          byNorm     — norm("song")           -> absolute path   (tolerant question)
 *
 * First hit wins in both, matching the previous behaviour: a duplicate under a genre subfolder must
 * not displace the copy already found.
 */
function buildIndex(root, opts = {}) {
  const byBasename = new Map();
  const byNorm = new Map();
  const maxDepth = opts.maxDepth == null ? 6 : opts.maxDepth;
  let files = 0;
  if (root) {
    (function walk(dir, depth) {
      if (depth > maxDepth) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (!AUDIO.has(path.extname(e.name).toLowerCase())) continue;
        files++;
        const base = e.name.toLowerCase();
        if (!byBasename.has(base)) byBasename.set(base, full);
        const k = norm(path.parse(e.name).name);
        if (k && !byNorm.has(k)) byNorm.set(k, full);
      }
    })(root, 0);
  }
  return { byBasename, byNorm, files, root: root || null };
}

/**
 * Is this stored path's file present in the library under ANY name we would accept?
 * Exact basename first (cheap, unambiguous), then the tolerant key — so the health signal can never
 * call a row unresolvable that Re-sync would happily relink.
 *
 * @returns {string|null} the absolute path in the library, or null.
 */
function findInIndex(index, storedPath) {
  if (!index || !storedPath) return null;
  const name = path.basename(String(storedPath));
  const exact = index.byBasename.get(name.toLowerCase());
  if (exact) return exact;
  const k = norm(path.parse(name).name);
  return (k && index.byNorm.get(k)) || null;
}

// ── WHAT COUNTS AS AN AUDIO-BEARING TABLE ──────────────────────────────────────────────────────
//
// One list, because the OV incident spanned seven tables and every subsystem that only knew about
// `songs` reported green while announcements, sweepers and carts were silent. Both the health
// classifier and Re-sync read this, so neither can quietly know about a different set.
//
// `scheduled_log` is deliberately absent: the sync registry declares a `file_path` for it but the
// live table has no such column (registry/schema mismatch, flagged in
// docs/design-machine-local-paths-2026-09-04.md §9). tableColumns() would skip it anyway; leaving it
// out states the intent.
// Objects, not bare names, because one of them carries behaviour. `library-health.js` used to keep
// its OWN copy of this list purely to hold that flag — two lists that could drift, which is the
// defect this module exists to prevent. One list, and the flag travels with it.
//
// `neverForeign` — cart audio was allowed to live outside the catalogue, so a cart with a path
// elsewhere must not be reported as `foreign`. Under the one-library rule that carve-out goes; that
// rule's work is HELD, so the flag stays until it ships rather than shipping half a decision.
const AUDIO_TABLES = [
  { table: 'songs' },
  { table: 'announcements' },
  { table: 'spots' },
  { table: 'cart_slots', neverForeign: true },
  { table: 'library_asset' },
  { table: 'published_episodes' },
  { table: 'voice_tracks' },
];

/** Just the names, for callers that only need membership. Derived, so it cannot drift either. */
const AUDIO_TABLE_NAMES = AUDIO_TABLES.map((t) => t.table);

/** Column names of a table, memoised per db handle. Schemas vary by build and migration state. */
const _cols = new WeakMap();
function tableColumns(db, table) {
  let m = _cols.get(db);
  if (!m) { m = new Map(); _cols.set(db, m); }
  if (m.has(table)) return m.get(table);
  let set = new Set();
  try { for (const c of db.prepare(`PRAGMA table_info(${table})`).all()) set.add(c.name); } catch { /* absent */ }
  m.set(table, set);
  return set;
}

module.exports = { buildIndex, findInIndex, norm, AUDIO, AUDIO_TABLES, AUDIO_TABLE_NAMES, tableColumns };
