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
const crypto = require('crypto');

const AUDIO = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.aif', '.aiff', '.wma']);

// ── NAMES THAT DIFFER ONLY IN CASE ARE DIFFERENT FILES (Jeff, 2026-10-23) ──────────────────────────
//
// R2 keys are case-sensitive; NTFS and APFS are not. "Deck The Halls_spotdown.org.mp3" and "Deck the Halls_spotdown.org.mp3"
// are two cloud objects and two song rows, but one folder can hold only one of those names, so every catalogue pull wrote
// one over the other and the next pull flipped it back (docs/halloveen-join-61-file-errors-2026-10-23.md).
//
// So a name keeps its own spelling on disk unless a DIFFERENT-CASE spelling already holds it; then it lives at
// caseAltName(name): `<stem>~c<first 8 hex of sha1(name)><ext>`. The suffix is a function of the exact name, so it is the
// same on every machine and caseKeyOf() recovers the cloud name from it (the hash proves the suffix is ours, not part
// of a real title). Which spelling holds the plain name is whichever got there first on that machine; resolution never
// depends on it, because both resolvers try the exact name, then the alt name.

const CASE_ALT_RE = /^(.*)~c([0-9a-f]{8})(\.[^.]+)$/;
const _hash8 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 8);

/** Where `name` lives when a different-case spelling holds its plain name. */
function caseAltName(name) {
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)}~c${_hash8(name)}${ext}`;
}

/** The cloud name a local file stands for: its own name, or the name a caseAltName() file was made from. */
function caseKeyOf(localName) {
  const m = CASE_ALT_RE.exec(localName);
  if (!m) return localName;
  const candidate = m[1] + m[3];
  return _hash8(candidate) === m[2] ? candidate : localName;
}

/** A folder's file names, for libraryNameFor(). `add` records a name a caller is about to write. */
function nameSet(names) {
  const exact = new Set(), lower = new Set();
  const s = { exact, lower, add(n) { exact.add(n); lower.add(n.toLowerCase()); return s; } };
  for (const n of names || []) s.add(n);
  return s;
}

/**
 * The file name `name` has (or must get) in a folder holding `set`. Returns { name, present }.
 * Exact spelling present → it. Its alt present → the alt. A different-case spelling holds the plain name → the alt, to
 * be written. Otherwise the plain name, to be written.
 */
function libraryNameFor(set, name) {
  if (set.exact.has(name)) return { name, present: true };
  const alt = caseAltName(name);
  if (set.exact.has(alt)) return { name: alt, present: true };
  if (set.lower.has(name.toLowerCase())) return { name: alt, present: false };
  return { name, present: false };
}

/** libraryNameFor() against a folder on disk. Returns { path, present }. */
function libraryPathFor(dir, name) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* absent folder: nothing is present */ }
  const r = libraryNameFor(nameSet(names), name);
  return { path: path.join(dir, r.name), present: r.present };
}

/** fs.existsSync, but a different-case spelling of the file name does not count. */
function existsExactCase(fp) {
  try {
    if (!fp || !fs.existsSync(fp)) return false;
    return fs.readdirSync(path.dirname(fp)).includes(path.basename(fp));
  } catch { return false; }
}

/**
 * Does `storedPath` only "exist" because a different-case spelling sits in its library folder? Then fs.existsSync would
 * open that other file, so a resolver must not take its fast path. Answered from the index, so it costs no disk access.
 */
function caseShadowed(index, storedPath) {
  if (!index || !index.byExact || !storedPath) return false;
  const name = storedBasename(storedPath);
  if (index.byExact.has(name)) return false;
  const hit = index.byBasename.get(name.toLowerCase());
  if (!hit || path.basename(hit) === name) return false;
  return path.dirname(hit).toLowerCase() === path.dirname(String(storedPath)).toLowerCase();
}

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
  const byExact = new Map();      // the name exactly as on disk -> absolute path (case-exact question)
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
        if (!byExact.has(e.name)) byExact.set(e.name, full);
        const base = e.name.toLowerCase();
        if (!byBasename.has(base)) byBasename.set(base, full);
        const k = norm(path.parse(e.name).name);
        if (k && !byNorm.has(k)) byNorm.set(k, full);
      }
    })(root, 0);
  }
  return { byExact, byBasename, byNorm, files, root: root || null };
}

/**
 * The file name of a STORED path, whichever OS wrote it. Every basename taken from a stored path
 * (file_path / file_key — rows travel between machines) goes through this, never path.basename().
 *
 * On macOS/Linux path.basename() does not treat `\` as a separator, so a Windows path arriving on a
 * Mac comes back WHOLE: `C:\Users\jensj\AppData\Local\Ether\catalogue\ABC.mp3`. That is how 725 rows
 * read OUTSIDE on Jeff's Mac with the files sitting in the catalogue, and how the materializer wrote
 * 92 files literally named `C:\Users\…\x.mp3` (docs/mac-install-no-engine-windows-paths-2026-09-30.md).
 *
 * Windows-shaped (drive letter, UNC, or any backslash) → path.win32.basename, which splits on both
 * `\` and `/`. Otherwise path.posix. A POSIX catalogue never legitimately stores a `\` in a path.
 */
function storedBasename(p) {
  const s = String(p == null ? '' : p);
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.includes('\\')) return path.win32.basename(s);
  return path.posix.basename(s);
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
  const name = storedBasename(storedPath);
  // The exact spelling, then its case-alt (see caseAltName), BEFORE the case-blind match: a different-case spelling is a
  // different file. An index built before byExact existed skips straight to the old order.
  if (index.byExact) {
    const own = index.byExact.get(name) || index.byExact.get(caseAltName(name));
    if (own) return own;
  }
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
// (The old log table was deliberately absent here for a registry/schema mismatch, flagged in
// docs/design-machine-local-paths-2026-09-04.md §9; it was dropped in v61, Program Log slice 6.)
// Objects, not bare names, because one of them carries behaviour. `library-health.js` used to keep
// its OWN copy of this list purely to hold that flag — two lists that could drift, which is the
// defect this module exists to prevent. One list, and the flag travels with it.
//
// THE `neverForeign` CARVE-OUT IS GONE (2026-09-09).
//
// It existed because cart audio was allowed to live outside the catalogue — a premise taken from a
// measurement (10 of 10 carts in Downloads) that was read as a design intent rather than as the
// defect it was. Jeff, 2026-09-09: "That rule describes a design I've replaced. Everything lives in
// the catalogue now." Both machines measured `foreign: 0` for carts when this was removed, so the
// alarm went live already green — which is the right moment to remove a suppressor.
//
// What the carve-out was ALSO protecting is kept, and is a different rule: the sync layer must never
// rebase a path on its own. Rebasing on mutation apply would have the receiver invent a path the
// operator never chose. That lives in the amended T-new-4, not in a per-table flag here.
//
// Objects rather than bare names, still: the shape is the seam where behaviour would travel with a
// table if any ever needs to again, and one list cannot drift from another.
const AUDIO_TABLES = [
  { table: 'songs' },
  { table: 'announcements' },
  { table: 'spots' },
  { table: 'cart_slots' },
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

module.exports = {
  buildIndex, findInIndex, storedBasename, norm, AUDIO, AUDIO_TABLES, AUDIO_TABLE_NAMES, tableColumns,
  caseAltName, caseKeyOf, nameSet, libraryNameFor, libraryPathFor, existsExactCase, caseShadowed,
};
