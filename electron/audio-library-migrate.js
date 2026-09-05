'use strict';
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// BRINGING EXISTING ROWS INTO THE AUDIO LIBRARY
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// THE RULE (Jeff, 2026-09-04): every audio file lives in the audio library. That is the first and
// only place audio files live; nothing points outside it.
//
// A row that RESOLVES is not automatically a row that COMPLIES. The ten carts on the dev machine all
// played perfectly from C:\Users\jensj\Downloads — and were exactly the defect the rule exists to
// remove, because a path outside the library is a path no other machine can ever resolve, and a
// basename-plus-local-library is the only thing that survives a trip between machines.
//
// This module answers one question per row — "where should this file be, and what does it take to
// get it there" — and does the smallest thing that satisfies it:
//
//   ALREADY_INSIDE   nothing to do.
//   REPOINT          the file is ALREADY in the library under this basename. Repoint only —
//                    NO COPY, so re-running never manufactures duplicates. This is the common case
//                    after an operator has moved their files in by hand, and it was 8 of the 10
//                    carts measured on 2026-09-04.
//   COPY             the source exists outside the library. Copy in, verify, then repoint.
//   GONE             the source is not on this machine. Leave the row ALONE and report it. Never
//                    blank it — a row with a stale path is a re-import; a blanked row is lost work.
//
// EVERY WRITE IS LOCAL-ONLY. `file_path` is a `blob-ref` column and in sync-protocol v0 a blob-ref
// ships the literal absolute path, so routing these through the sync-logged writer would broadcast
// this machine's paths to every peer — the OV incident, from a repair tool. See
// docs/design-machine-local-paths-2026-09-04.md.

const fs = require('fs');
const path = require('path');
const { buildIndex, findInIndex, AUDIO_TABLES, AUDIO_TABLE_NAMES, tableColumns } = require('./audio-library-index');

/** Is this path inside the library root? Case-insensitive: Windows, and the operator typed it. */
function isInside(root, p) {
  if (!root || !p) return false;
  const a = path.resolve(String(p)).toLowerCase();
  const b = path.resolve(String(root)).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function sizeOf(p) { try { return fs.statSync(p).size; } catch { return -1; } }

/**
 * Where should this file go, and is something already there?
 *
 * COLLISION POLICY, and it matters more than it looks:
 *   • same name, same size  → REUSE it. This is the good case and it is what makes the tool
 *     idempotent: running the migration twice must not produce "track (2).mp3".
 *   • same name, different size → disambiguate with " (2)". NEVER overwrite: another row may
 *     already point at the file that is there, and overwriting would silently change what it airs.
 */
function destinationFor(root, srcPath) {
  const base = path.basename(String(srcPath));
  const direct = path.join(root, base);
  const srcSize = sizeOf(srcPath);
  const dstSize = sizeOf(direct);
  if (dstSize < 0) return { dest: direct, reuse: false };
  if (srcSize >= 0 && dstSize === srcSize) return { dest: direct, reuse: true };
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const cand = path.join(root, `${stem} (${n})${ext}`);
    const cs = sizeOf(cand);
    if (cs < 0) return { dest: cand, reuse: false };
    if (srcSize >= 0 && cs === srcSize) return { dest: cand, reuse: true };
  }
  return { dest: null, reuse: false, error: 'too many name collisions' };
}

/**
 * Plan, without touching anything. Pure read — safe to run against a live install.
 * @returns {{ root, indexed, rows: Array, counts: {…} }}
 */
function planMigration(db, root, opts = {}) {
  // Accepts either the shared specs or a plain list of names from a caller.
  const only = (opts.tables || AUDIO_TABLES).map((t) => (typeof t === 'string' ? { table: t } : t));
  const index = buildIndex(root);
  const rows = [];
  for (const spec of only) {
    const table = spec.table;
    const cols = tableColumns(db, table);
    if (!cols.has('file_path') || !cols.has('id')) continue;
    const hasDeleted = cols.has('deleted_at');
    const titleCol = cols.has('title') ? 'title' : (cols.has('name') ? 'name' : null);
    let all = [];
    try {
      all = db.prepare(
        `SELECT id, file_path, ${titleCol || 'NULL'} AS _title FROM ${table}` +
        ` WHERE file_path IS NOT NULL AND file_path != ''${hasDeleted ? ' AND deleted_at IS NULL' : ''}`).all();
    } catch { continue; }
    for (const r of all) {
      const fp = r.file_path;
      if (isInside(root, fp) && fs.existsSync(fp)) {
        rows.push({ table, id: r.id, title: r._title, from: fp, action: 'ALREADY_INSIDE' });
        continue;
      }
      // Already in the library under this name? Repoint, never copy.
      //
      // BUT A NAME IS NOT AN IDENTITY. An early version repointed on the basename alone, and the
      // test caught what that means: a Downloads file and a library file can share a name and hold
      // completely different audio — different cuts, different versions, a re-record. Repointing
      // there would silently change what the row AIRS, which is worse than leaving it broken.
      //
      // So when the source is still readable, the sizes must agree before we call them the same
      // file. When the source is NOT on this machine (the foreign-path case — the row came from
      // another install and its file was never here), there is nothing to compare against and the
      // basename is the best evidence available; that is precisely the judgement the resolver tier
      // makes to keep such a station on air, so it is made the same way here.
      const hit = findInIndex(index, fp);
      if (hit && isInside(root, hit)) {
        const srcSize = sizeOf(fp);
        const sameFile = srcSize < 0 || sizeOf(hit) === srcSize;
        if (sameFile) {
          rows.push({ table, id: r.id, title: r._title, from: fp, to: hit, action: 'REPOINT',
                      matchedBy: srcSize < 0 ? 'name (source absent)' : 'name+size' });
          continue;
        }
        // Same name, different audio — fall through to the copy path, which disambiguates rather
        // than overwriting.
      }
      if (!fs.existsSync(fp)) {
        rows.push({ table, id: r.id, title: r._title, from: fp, action: 'GONE' });
        continue;
      }
      const d = destinationFor(root, fp);
      if (!d.dest) {
        rows.push({ table, id: r.id, title: r._title, from: fp, action: 'GONE', error: d.error });
        continue;
      }
      rows.push({ table, id: r.id, title: r._title, from: fp, to: d.dest,
                  action: d.reuse ? 'REPOINT' : 'COPY', reuse: d.reuse });
    }
  }
  const counts = rows.reduce((m, r) => { m[r.action] = (m[r.action] || 0) + 1; return m; }, {});
  // DISTINCT DESTINATIONS, not row count. Rows share files — the same track in two stations'
  // categories, a cart that is also a song — and `destinationFor` reuses the first copy for the
  // rest. On the dev machine 600 rows resolve to 486 files, so a UI that counted rows would promise
  // 600 files and 3.42 GB where the truth is 486 and 3.15 GB. Report what will actually land.
  const dests = new Set();
  let bytes = 0;
  for (const r of rows) {
    if (!r.to || dests.has(r.to.toLowerCase())) continue;
    dests.add(r.to.toLowerCase());
    if (r.action === 'COPY') { try { bytes += fs.statSync(r.from).size; } catch { /* vanished */ } }
  }
  return { root, indexed: index.files, rows, counts, distinctFiles: dests.size, bytesToCopy: bytes };
}

/**
 * Apply a plan. Copies FIRST, verifies, and only then writes the row — never the other way round.
 * A row whose copy failed keeps its old path and is reported; it is not left pointing at a file that
 * is not there yet, which is the failure mode this whole rule exists to end.
 */
function applyMigration(db, plan) {
  const done = { repointed: 0, copied: 0, skipped: 0, failed: [] };
  const stmts = new Map();
  const stmtFor = (table) => {
    let st = stmts.get(table);
    if (!st) { st = db.prepare(`UPDATE ${table} SET file_path = ? WHERE id = ?`); stmts.set(table, st); }
    return st;
  };

  for (const r of plan.rows) {
    if (r.action === 'ALREADY_INSIDE') { done.skipped++; continue; }
    if (r.action === 'GONE') {
      // Reported, never blanked. The operator re-imports; the row keeps its title and its identity.
      done.failed.push({ ...r, reason: r.error || 'source file is not on this machine' });
      continue;
    }
    if (r.action === 'COPY') {
      try {
        fs.mkdirSync(path.dirname(r.to), { recursive: true });
        fs.copyFileSync(r.from, r.to);
      } catch (e) {
        // ENOSPC / EPERM / EACCES all land here, named. The precedent for why this must be loud:
        // 2,443 silent EPERM failures on OV over two days, every one a track that never aired.
        done.failed.push({ ...r, reason: `copy failed (${e.code || 'error'}): ${e.message}` });
        continue;
      }
      // VERIFY before the row is touched. A short copy that is never checked is a file that plays
      // for four seconds and stops, mid-show.
      const a = sizeOf(r.from), b = sizeOf(r.to);
      if (a < 0 || b !== a) {
        try { fs.unlinkSync(r.to); } catch { /* leave nothing partial behind */ }
        done.failed.push({ ...r, reason: `copy incomplete (${b} of ${a} bytes) — removed` });
        continue;
      }
      done.copied++;
    }
    try { stmtFor(r.table).run(r.to, r.id); done.repointed++; }
    catch (e) { done.failed.push({ ...r, reason: `row update failed: ${e.message}` }); }
  }
  return done;
}

// ── COPY-ON-IMPORT — the door every audio file comes through ───────────────────────────────────
//
// THE RULE: every audio file that enters Ether is copied into the audio library. That is the first
// and only place audio files live.
//
// Until now NOTHING copied. Every picker in the app stored whatever path the operator browsed to,
// and the library folder was a place the UPLOADER consolidated into, never one the IMPORTER wrote
// to. That single gap produced all of it: 1,113 orphan files in the library with no row, ten carts
// living in Downloads, and 382 rows on OV naming a directory that machine cannot open.
//
// THE ORDER IS THE WHOLE POINT: copy → verify → and only then may the caller write a row. A row
// written first is a promise the disk has not kept yet, and the operator discovers it mid-show.
// Every failure below is returned with a reason a person can act on — the precedent for why is the
// 2,443 silent EPERM failures on OV, each one a track that never aired.
//
// @returns {{ok:true, path, action:'already-inside'|'reused'|'copied'} | {ok:false, error, code}}
function importIntoLibrary(root, srcPath) {
  if (!root) return { ok: false, code: 'no_library', error: 'No audio library folder is set.' };
  if (!srcPath) return { ok: false, code: 'no_source', error: 'No file was chosen.' };

  let src;
  try { src = path.resolve(String(srcPath)); }
  catch { return { ok: false, code: 'bad_path', error: 'That path could not be read.' }; }

  if (!fs.existsSync(src)) {
    return { ok: false, code: 'missing', error: `That file is no longer there: ${src}` };
  }
  // Importing FROM the library must not duplicate into it.
  if (isInside(root, src)) return { ok: true, path: src, action: 'already-inside' };

  const d = destinationFor(root, src);
  if (!d.dest) {
    return { ok: false, code: 'collision', error: d.error || 'Could not find a free name in the audio library.' };
  }
  // Windows refuses silently past MAX_PATH in some APIs; better to say so than to write a truncated
  // name and have the row point at something that does not exist.
  if (d.dest.length > 255) {
    return { ok: false, code: 'path_too_long',
             error: `The name is too long for the audio library folder (${d.dest.length} characters).` };
  }
  // Same name, same size, already there — reuse it. No copy, no duplicate. Re-importing the same
  // file twice is a thing operators do, and it must not grow the library each time.
  if (d.reuse) return { ok: true, path: d.dest, action: 'reused' };

  try { fs.mkdirSync(root, { recursive: true }); }
  catch (e) { return { ok: false, code: e.code || 'mkdir', error: `Could not open the audio library folder: ${e.message}` }; }

  try {
    fs.copyFileSync(src, d.dest);
  } catch (e) {
    const why = e.code === 'ENOSPC' ? 'there is not enough free disk space'
              : (e.code === 'EPERM' || e.code === 'EACCES') ? 'permission was denied'
              : e.message;
    return { ok: false, code: e.code || 'copy', error: `Could not copy into the audio library — ${why}.` };
  }

  // VERIFY BEFORE THE CALLER IS ALLOWED TO WRITE A ROW. A short copy plays for four seconds and
  // stops, and it does it on air.
  const a = sizeOf(src), b = sizeOf(d.dest);
  if (a < 0 || b !== a) {
    try { fs.unlinkSync(d.dest); } catch { /* never leave a partial file behind */ }
    return { ok: false, code: 'short_copy', error: `The copy was incomplete (${b} of ${a} bytes) and has been removed.` };
  }
  return { ok: true, path: d.dest, action: 'copied' };
}

/**
 * The single-row version, for CHANGE FILE LOCATION. Local-only, one column, by table+id.
 * Deliberately narrow so it cannot become a general mutation bypass.
 */
function repointOne(db, table, id, filePath) {
  if (!AUDIO_TABLE_NAMES.includes(table)) return { ok: false, error: `not an audio table: ${table}` };
  const cols = tableColumns(db, table);
  if (!cols.has('file_path') || !cols.has('id')) return { ok: false, error: `${table} has no file_path` };
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'that file is not on this machine' };
  try {
    const info = db.prepare(`UPDATE ${table} SET file_path = ? WHERE id = ?`).run(filePath, id);
    if (!info.changes) return { ok: false, error: 'no such row' };
    return { ok: true, table, id, filePath };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** The obvious candidate for a row whose file is missing: same basename, already in the library. */
function suggestFor(root, storedPath) {
  if (!storedPath) return null;
  const hit = findInIndex(buildIndex(root), storedPath);
  return hit && isInside(root, hit) ? hit : null;
}

module.exports = { planMigration, applyMigration, repointOne, suggestFor, isInside, destinationFor, importIntoLibrary };
