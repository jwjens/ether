// electron/catalogue-moves.js — SONGS ARE ONLY EVER IN THE CATALOGUE, and Ether moves nothing without a Yes
// (Jeff, 2026-10-27: "Rule for where songs live: songs are only ever in the catalogue. The only way to change that is
// changing the catalogue folder location in Preferences." … "Ether never moves, downloads or repoints anything on its own
// without that Yes.").
//
//   findNotInCatalogue  — READ ONLY. Every audio row whose file is not in the catalogue folder: stored somewhere else on
//                         this computer, or not on this computer at all. Grouped by FILE (rows share files), so the pop-up
//                         lists files, not rows.
//   moveIntoCatalogue   — ONLY after the user answered Yes. Each file is moved into the catalogue (or downloaded from the
//                         cloud when it is not on this computer), and only then are its rows pointed there.
//
// Nothing here guesses: a file is matched by its exact name only (electron/catalogue.js), never by title or a look-alike
// name. Every row write is LOCAL-ONLY (no mutation is journalled): a file location is this computer's fact, never a peer's.
"use strict";
const fs = require("fs");
const path = require("path");
const { AUDIO_TABLES, tableColumns, storedBasename, libraryPathFor } = require("./audio-library-index");
const { downloadTarget } = require("./catalogue");

/** Is `p` inside the catalogue folder `root`? Resolved and case-folded (Windows), separator-aware. */
function isInside(root, p) {
  if (!root || !p) return false;
  const a = path.resolve(String(p)).toLowerCase();
  const b = path.resolve(String(root)).toLowerCase();
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** fs.existsSync with exact-case names, one directory listing per directory per scan (not one per row). */
function exactExists(listings) {
  return (fp) => {
    if (!fp) return false;
    const dir = path.dirname(String(fp));
    let names = listings.get(dir);
    if (names === undefined) {
      try { names = new Set(fs.readdirSync(dir)); } catch { names = null; }
      listings.set(dir, names);
    }
    return !!names && names.has(path.basename(String(fp)));
  };
}

/**
 * Every file an audio row names that is not in the catalogue. Pure read.
 * @returns {{ catalogue, files: Array<{ key, file, name, state: 'elsewhere'|'missing', fileKey, rows: Array<{table,id,title}> }> }}
 *   state 'elsewhere' — the file is on this computer, outside the catalogue (it can be moved in)
 *   state 'missing'   — it is not on this computer (fileKey set: it can be downloaded; null: it cannot)
 */
function findNotInCatalogue(db, root) {
  const exists = exactExists(new Map());
  const byKey = new Map();
  for (const { table } of AUDIO_TABLES) {
    const cols = tableColumns(db, table);
    if (!cols.has("file_path") || !cols.has("id")) continue;
    const titleCol = cols.has("title") ? "title" : (cols.has("name") ? "name" : null);
    const fk = cols.has("file_key") ? "file_key" : "NULL";
    // A row with no stored location but a cloud copy is a song that is not on this computer either.
    const where = [cols.has("file_key") ? "((file_path IS NOT NULL AND file_path != '') OR (file_key IS NOT NULL AND file_key != ''))"
                                        : "file_path IS NOT NULL AND file_path != ''",
                   cols.has("deleted_at") ? "deleted_at IS NULL" : null].filter(Boolean).join(" AND ");
    let rows = [];
    try { rows = db.prepare(`SELECT id, file_path, ${fk} AS file_key, ${titleCol || "NULL"} AS _title FROM ${table} WHERE ${where}`).all(); }
    catch { continue; }
    for (const r of rows) {
      const fp = r.file_path || null;
      const here = exists(fp);
      if (here && isInside(root, fp)) continue;                       // in the catalogue: nothing to do
      const key = fp ? `path:${fp}` : `key:${r.file_key}`;
      let f = byKey.get(key);
      if (!f) {
        f = { key, file: fp, name: storedBasename(fp || r.file_key || "") || null, state: here ? "elsewhere" : "missing", fileKey: null, rows: [] };
        byKey.set(key, f);
      }
      if (!f.fileKey && r.file_key) f.fileKey = r.file_key;
      f.rows.push({ table, id: r.id, title: r._title == null ? null : String(r._title) });
    }
  }
  const files = [...byKey.values()].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return { catalogue: root || null, files };
}

function sizeOf(p) { try { return fs.statSync(p).size; } catch { return -1; } }

/** Move one file into the catalogue under its own name. Never overwrites. */
async function moveFile(src, root) {
  const name = storedBasename(src);
  const t = libraryPathFor(root, name);
  if (t.present) {
    // The catalogue already holds a file with this exact name. The same file (same size) is simply used; the copy outside
    // is left where it is. A different file is never replaced — that would change what other rows play.
    if (sizeOf(t.path) === sizeOf(src)) return { ok: true, action: "already-in-catalogue", to: t.path, note: `the copy at ${src} was left where it is` };
    return { ok: false, reason: `a different file named "${path.basename(t.path)}" is already in the catalogue — nothing was replaced` };
  }
  try {
    await fs.promises.rename(src, t.path);
    return { ok: true, action: "moved", to: t.path };
  } catch (e) {
    if (e.code !== "EXDEV") return { ok: false, reason: `could not move it (${e.code || "error"}): ${e.message}` };
  }
  // Another drive: copy, check every byte arrived, then remove the original.
  const tmp = t.path + ".moving";
  try {
    await fs.promises.copyFile(src, tmp);
    if (sizeOf(tmp) !== sizeOf(src)) throw new Error(`copy incomplete (${sizeOf(tmp)} of ${sizeOf(src)} bytes)`);
    await fs.promises.rename(tmp, t.path);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, reason: `could not copy it into the catalogue: ${e.message}` };
  }
  try { await fs.promises.unlink(src); }
  catch (e) { return { ok: true, action: "moved", to: t.path, note: `copied in; the original at ${src} could not be removed (${e.code || e.message})` }; }
  return { ok: true, action: "moved", to: t.path };
}

/**
 * The Yes. For each listed file: move it in (or download it), then point its rows at the catalogue file. A row is only
 * repointed if it still names the file the user was shown. LOCAL-ONLY writes.
 * @param deps.download async (fileKey, name) => { ok, filePath, error } — the row's own cloud copy into the catalogue
 * @returns {{ results: Array<{ key, name, ok, action, to, reason, note, rows }>, moved, downloaded, alreadyThere, failed }}
 */
async function moveIntoCatalogue(db, root, files, deps = {}) {
  const out = { results: [], moved: 0, downloaded: 0, alreadyThere: 0, failed: 0 };
  if (!root) throw new Error("no catalogue folder is set (Settings)");
  fs.mkdirSync(root, { recursive: true });
  const exists = exactExists(new Map());
  let hasState = false;
  try { hasState = db.prepare("PRAGMA table_info(generated_schedule)").all().some(c => c.name === "state"); } catch {}
  const planned = hasState ? ` AND ${require("./log-edit-core").NOT_AIRED_SQL}` : "";

  for (const f of files || []) {
    let r;
    if (f.file && exists(f.file)) {
      r = await moveFile(f.file, root);
    } else if (f.fileKey) {
      const t = downloadTarget(root, f.file, f.fileKey);
      if (!t) r = { ok: false, reason: "it has no file name" };
      else if (t.present) r = { ok: true, action: "already-in-catalogue", to: t.path };   // the exact name is already there
      else if (typeof deps.download !== "function") r = { ok: false, reason: "downloading is not available" };
      else {
        const d = await deps.download(f.fileKey, t.name).catch(e => ({ ok: false, error: e.message }));
        r = d && d.ok ? { ok: true, action: "downloaded", to: d.filePath } : { ok: false, reason: `the download failed: ${(d && d.error) || "unknown"}` };
      }
    } else {
      r = { ok: false, reason: "it is not on this computer and has no cloud copy" };
    }
    let rowsPointed = 0;
    if (r.ok) {
      db.transaction(() => {
        for (const row of f.rows) {
          const st = f.file
            ? db.prepare(`UPDATE ${row.table} SET file_path = ? WHERE id = ? AND file_path = ?`).run(r.to, row.id, f.file)
            : db.prepare(`UPDATE ${row.table} SET file_path = ? WHERE id = ? AND (file_path IS NULL OR file_path = '')`).run(r.to, row.id);
          rowsPointed += st.changes;
        }
        // The log's PLANNED rows that carry this file follow it; an aired row is the record of what aired, never rewritten.
        if (f.file) { try { db.prepare(`UPDATE generated_schedule SET file_path = ? WHERE file_path = ?${planned}`).run(r.to, f.file); } catch {} }
      })();
      if (r.action === "moved") out.moved++; else if (r.action === "downloaded") out.downloaded++; else out.alreadyThere++;
    } else out.failed++;
    out.results.push({ key: f.key, name: f.name, from: f.file, ok: r.ok, action: r.action || null, to: r.to || null,
                       reason: r.reason || null, note: r.note || null, rows: rowsPointed });
    if (typeof deps.log === "function") deps.log(r.ok ? `[catalogue] ${f.name}: ${r.action} → ${r.to} (${rowsPointed} row(s) pointed there)${r.note ? `; ${r.note}` : ""}`
                                                       : `[catalogue] ${f.name}: NOT moved — ${r.reason}`);
  }
  return out;
}

// ── "DOWNLOAD MISSING FILES INTO THE CATALOGUE AUTOMATICALLY" (Jeff, 2026-10-27) ──────────────────────────────────────
// A Preferences switch, on or off, for THIS computer (system_state — never synced). On: a file that is not on this computer
// and has a cloud copy downloads into the catalogue without the pop-up. Off (and never set): it goes to the pop-up.
// Files stored somewhere else on this computer, and files with no cloud copy, always go to the pop-up.
const AUTO_DOWNLOAD_KEY = "auto_download_missing";
function autoDownloadOn(db) {
  try { return db.prepare("SELECT value FROM system_state WHERE key = ?").get(AUTO_DOWNLOAD_KEY)?.value === "on"; }
  catch { return false; }
}
function setAutoDownload(db, on) {
  db.prepare("INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES (?, ?, ?)").run(AUTO_DOWNLOAD_KEY, on ? "on" : "off", new Date().toISOString());
  return autoDownloadOn(db);
}
/** Would this file download by itself with the switch on? (not on this computer, and the cloud has it) */
function downloadsByItself(f) { return !!f && f.state === "missing" && !!f.fileKey; }
/** Split a finding by the switch: what downloads by itself, and what the pop-up asks about. */
function splitByAutoDownload(files, on) {
  const auto = [], ask = [];
  for (const f of files || []) (on && downloadsByItself(f) ? auto : ask).push(f);
  return { auto, ask };
}

module.exports = { findNotInCatalogue, moveIntoCatalogue, isInside,
                   AUTO_DOWNLOAD_KEY, autoDownloadOn, setAutoDownload, downloadsByItself, splitByAutoDownload };
