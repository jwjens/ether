'use strict';
// The machine's AUDIO LIBRARY + re-sync. One folder per machine, shared by every station on it
// (Jeff's ruling, 2026-09-04 — see getFolder below for what this replaced). Re-sync relinks a
// station's songs from that folder and reports what's missing. One matcher powers: Test sync
// (dry-run), Re-sync (writes), and the Library Relocate button.
//
// NOTHING HERE EVER WRITES A SYNCED COLUMN. Both the relink (songs.file_path) and the library
// location are per-machine facts; routing either through the mutation log is what put another
// machine's paths on OV. See applyRelink's header.

const fs = require('fs');
const path = require('path');

// THE MATCHER LIVES IN ONE PLACE NOW (2026-09-04). `norm` and the folder walk moved to
// electron/audio-library-index.js, because this module and library-health.js had grown two different
// definitions of "is this file in the library" — tolerant here, exact there — and the health signal
// could call a row dead that Re-sync would relink. Behaviour here is unchanged: this still matches on
// the tolerant key, against the same conservative `norm`.
const { buildIndex, findInIndex, norm, AUDIO_TABLES, tableColumns } = require('./audio-library-index');

// Normalized-name -> absolute path, for title-based matching. One walk, shared with the health
// classifier, which asks the exact-basename question of the same index.
function indexFolder(folder) {
  return buildIndex(folder).byNorm;
}

// ── ONE AUDIO LIBRARY PER MACHINE (2026-09-04) ────────────────────────────────────────────────
//
// There used to be TWO different `music_dir` notions and nothing reconciled them:
//   • per-STATION  — station_config_kv key 'music_dir', read and written only by this module;
//   • per-MACHINE  — the profile's music-dir.txt, used by the R2 uploader, the prefetch and
//     library-health.
// They could hold different paths, so "the audio library" did not name one thing. Jeff's ruling:
// the audio library is a property of the MACHINE, and all stations on it share one folder.
//
// READ-THROUGH, not a hard cut. The per-machine value wins; the stale per-station row is used only
// when the per-machine one is unset, so an install that had only ever set a per-station folder does
// not lose its library on upgrade. Nothing writes the per-station key any more (see the handlers
// below); it is retired by migration later, once peers have stopped carrying rows for it.
function getFolder(db, stationId, deps) {
  try {
    const machine = deps && typeof deps.getMachineMusicDir === 'function' ? deps.getMachineMusicDir() : null;
    if (machine) return machine;
  } catch { /* fall through to the legacy row */ }
  try {
    const r = db.prepare("SELECT value FROM station_config_kv WHERE station_id = ? AND key = 'music_dir' AND deleted_at IS NULL").get(stationId);
    return (r && r.value) || null;
  } catch { return null; }
}

// The station's OWN format categories (its clock's music-slot categories). This is what makes a
// station's library "just its own" — e.g. halloVeen = [HalloVeen]. Empty = no format configured.
function formatCategoryIds(db, stationId) {
  try {
    return db.prepare(
      `SELECT DISTINCT category_id FROM clock_slots
         WHERE slot_type = 'music' AND category_id IS NOT NULL AND deleted_at IS NULL AND station_id = ?`
    ).all(stationId).map(r => r.category_id).filter(c => c != null);
  } catch { return []; }
}

// Match this station's OWN songs (its format categories) against its folder. Scoped so Halloween only
// ever considers Halloween songs — NOT the whole shared library (uncategorized songs leak into every
// station otherwise). Pure read — no writes. Falls back to the station's schedule if no format is set.
// Returns { folder, total, matches:[{songId,title,file}], missing:[{songId,title}], folderFiles }.
// ── EVERY AUDIO-BEARING TABLE, not just music (2026-09-04) ────────────────────────────────────
//
// Re-sync only ever considered `songs`, filtered to content_class MUSIC and to the station's format
// categories. That is the same disease as everything else this week: announcements, spots, carts,
// voice tracks and episodes were audio too, and the one tool an operator has for "my files moved"
// could not see them. On OV all four of those categories were silent while Re-sync would have
// reported the music fine.
//
// Matched on the stored path's BASENAME through the shared index (exact first, then the tolerant
// key), rather than on title: these rows' titles are operator labels ("Legal ID", "Cart 3") and
// carry no relationship to a filename. Rows whose file already resolves are left alone.
function matchAssets(db, stationId, index) {
  const found = [], missing = [];
  for (const spec of AUDIO_TABLES) {
    const table = spec.table;
    if (table === 'songs') continue;                 // handled by the title matcher above
    const cols = tableColumns(db, table);
    if (!cols.has('file_path') || !cols.has('id')) continue;
    const hasStation = cols.has('station_id');
    const hasDeleted = cols.has('deleted_at');
    const titleCol = cols.has('title') ? 'title' : (cols.has('name') ? 'name' : null);
    const where = [
      "file_path IS NOT NULL", "file_path != ''",
      hasDeleted ? 'deleted_at IS NULL' : null,
      hasStation ? 'station_id = ?' : null,
    ].filter(Boolean).join(' AND ');
    let rows = [];
    try {
      const st = db.prepare(`SELECT id, file_path, ${titleCol ? titleCol : 'NULL'} AS _title FROM ${table} WHERE ${where}`);
      rows = hasStation ? st.all(stationId) : st.all();
    } catch { continue; }
    for (const r of rows) {
      let ok = false;
      try { ok = fs.existsSync(r.file_path); } catch { ok = false; }
      if (ok) continue;                              // already resolves — nothing to do
      const hit = findInIndex(index, r.file_path);
      if (hit) found.push({ table, id: r.id, title: r._title, file: hit, was: r.file_path });
      else missing.push({ table, id: r.id, title: r._title, was: r.file_path });
    }
  }
  return { found, missing };
}

function matchStation(db, stationId, folder) {
  // ONE walk for both questions: the title matcher below uses byNorm, the asset pass uses the same
  // index through findInIndex. Two matchers over one folder was the defect being removed.
  const index = (folder && fs.existsSync(folder)) ? buildIndex(folder) : buildIndex(null);
  const idx = index.byNorm;
  const cats = formatCategoryIds(db, stationId);
  let rows;
  if (cats.length) {
    rows = db.prepare(
      // TYPE IS NOT A REASON TO SKIP A FILE (2026-09-05). This used to require
      // `content_class IS NULL OR = 'MUSIC'`, which excluded 64 sweepers and 2 spots from Re-sync —
      // the one tool an operator has for "my files moved" could not see them.
      //
      // Removing that line alone would have fixed NOTHING, and the measurement is why: every SWP and
      // SPOT row has `category_id` NULL (they are filed by jingle_category_id / spot_category_id), so
      // the category filter below was doing the excluding. Counts with and without the type filter
      // were identical on all four stations.
      //
      // So the category requirement gains an escape for non-music. MUSIC stays station-scoped — the
      // reason that scoping exists is unchanged: without it, uncategorised songs leak into every
      // station. Imaging and spots are not station-scoped by category at all, so requiring one of
      // them is asking for something that does not exist.
      //
      // READ-ONLY on category_id. Nothing here assigns, infers or backfills a category: unlabeled
      // rows stay unlabeled and are the operator's to file.
      `SELECT s.id AS songId, s.title AS title, s.file_path AS filePath FROM songs s
        WHERE s.deleted_at IS NULL AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
          AND (s.category_id IN (${cats.map(() => '?').join(',')})
               OR s.content_class IN ('SWP','JIN','SPOT'))`
    ).all(...cats);
  } else {
    rows = db.prepare(
      `SELECT DISTINCT gs.song_id AS songId, COALESCE(s.title, gs.title) AS title,
              COALESCE(s.file_path, gs.file_path) AS filePath
         FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
        WHERE gs.station_id = ? AND gs.deleted_at IS NULL`
    ).all(stationId);
  }
  const matches = [], missing = [];
  for (const r of rows) {
    // ── THE STORED PATH IS CHECKED FIRST (2026-09-05) ────────────────────────────────────────
    //
    // This used to decide purely by TITLE: `idx.get(norm(r.title))`, matching a normalised title
    // against normalised filename stems. So a row whose file is present and playable was called
    // MISSING whenever the filename carried something the title did not — overwhelmingly an
    // " - Artist" suffix. Measured on halloVeen 2026-09-05: 18 rows reported missing, and all 18
    // had their file on disk. `norm("Arabian Nights")` is not `norm("Arabian Nights - Bruce Adler")`.
    //
    // That was not merely a wrong number. `applyRelink` NULLs generated_schedule.file_path for every
    // miss, so a Re-sync would have UN-AIRED 18 working entries on the strength of a naming
    // mismatch.
    //
    // Resolution order is now the same one the health classifier and the daemon already use:
    // the stored path, then the catalogue index, and only then the title. Title matching keeps its
    // job — recovering a row whose stored path no longer resolves, which is the whole point of
    // Re-sync after a library reorg — it just no longer gets asked first.
    let f = null;
    if (r.filePath && fs.existsSync(r.filePath)) f = r.filePath;          // 1. stored path resolves
    if (!f) f = findInIndex(index, r.filePath);                           // 2. same file, in the catalogue
    if (!f) { const t = idx.get(norm(r.title)); if (t && fs.existsSync(t)) f = t; }   // 3. by title
    if (f) matches.push({ songId: r.songId, title: r.title, file: f });
    else missing.push({ songId: r.songId, title: r.title });
  }
  const assets = matchAssets(db, stationId, index);
  return { folder: folder || null, total: rows.length, matches, missing,
           folderFiles: idx.size, assets: assets.found, assetsMissing: assets.missing };
}

// Write the matches (link) and NULL the misses (so the scheduler SKIPS them instead of stalling).
//
// ── WHY THIS NO LONGER USES THE SYNC-LOGGED WRITER (2026-09-04) ────────────────────────────────
//
// It used to call deps.songsUpdateById(), and the comment here used to read "songs.file_path goes
// through the sync-logged writer" as though that were the careful choice. It was the defect.
//
// `songs.file_path` is a `blob-ref` column, and in sync-protocol v0 a blob-ref ships THE LITERAL
// ABSOLUTE PATH (mutation-writer serializePayload → `__blob_ref`/`__blob_origin`, [N-22]/[N-23]).
// So every Re-sync and every Relocate pushed THIS machine's `C:\Users\<me>\...` to every peer —
// from a button an operator is told to press immediately after moving their library. On OV
// (2026-09-04) 382 rows arrived naming a directory that machine cannot open, and every announcement,
// sweeper and cart on it went silent. See docs/design-machine-local-paths-2026-09-04.md.
//
// A FILE LOCATION IS LOCAL STATE. It belongs with `is_active`, `icecast_password`, `stream_key` and
// the playhead columns — each already local-only, each with a comment saying that syncing
// per-machine state clobbers the other machine. Relinking is this machine answering "where is that
// file HERE", and the answer is true nowhere else.
//
// So the relink writes `songs.file_path` DIRECTLY, generating no mutation — the same shape as the
// hand repair performed on OV. Deliberately narrow: one column, by song id, nothing else. Every
// other field on `songs` still goes through the sync-logged writer, as it should.
//
// This does NOT close the leak on its own: `file_path` is still in the songs handler's PATCHABLE
// list, so the next ORDINARY edit to one of these rows will serialise the path and push it. That
// closes with the protocol amendment ([N-23a]: the receiver takes only the basename and discards
// the directory), not here. What this stops is the button that manufactured the bad data.
function applyRelink(db, stationId, result, deps) {
  // The local-only path writer. `updated_at` is deliberately NOT touched: bumping it would make the
  // row look edited to every peer's merge, which is the opposite of "this changed nothing but where
  // the bytes are on MY disk".
  const setSongPathLocal = db.prepare("UPDATE songs SET file_path = ? WHERE id = ?");
  const setGs   = db.prepare("UPDATE generated_schedule SET file_path = ? WHERE station_id = ? AND song_id IS ?");
  const setGsT  = db.prepare("UPDATE generated_schedule SET file_path = ? WHERE station_id = ? AND title = ? AND song_id IS NULL");
  const nullGs  = db.prepare("UPDATE generated_schedule SET file_path = NULL WHERE station_id = ? AND song_id IS ?");
  let nulled = 0, relinkedAssets = 0;
  const tx = db.transaction(() => {
    for (const m of result.matches) {
      if (m.songId != null) {
        setGs.run(m.file, stationId, m.songId);
        // LOCAL-ONLY. Not deps.songsUpdateById() — see the header above. No mutation is logged, so
        // this machine's absolute path never reaches a peer.
        try { setSongPathLocal.run(m.file, m.songId); } catch { /* keep gs link even if song row is odd */ }
      } else {
        setGsT.run(m.file, stationId, m.title);
      }
    }
    // Misses are NULLed so the scheduler skips them rather than stalling on a dead path. That is
    // right — but it was SILENT, which is the same class of defect as the prefetch's silent defer.
    // Count them so the caller can report what it just unlinked.
    for (const m of result.missing) if (m.songId != null) { nullGs.run(stationId, m.songId); nulled++; }
    // The other audio tables. LOCAL-ONLY like the song relink above — an announcement's location on
    // this disk is no more a fact about a peer than a song's is. Statements are prepared per table
    // and cached, not per row.
    const stmts = new Map();
    for (const a of (result.assets || [])) {
      let st = stmts.get(a.table);
      if (!st) {
        try { st = db.prepare(`UPDATE ${a.table} SET file_path = ? WHERE id = ?`); }
        catch { continue; }
        stmts.set(a.table, st);
      }
      try { st.run(a.file, a.id); relinkedAssets++; } catch { /* row vanished mid-transaction */ }
    }
  });
  tx();
  return { linked: result.matches.length, missingCount: result.missing.length, unlinked: nulled,
           relinkedAssets, assetsMissing: (result.assetsMissing || []).length };
}

function register(deps) {
  const { ipcMain, dialog, getDb, getActiveStationId, getMainWindow } = deps;
  // deps also carries getMachineMusicDir / setMachineMusicDir. stationConfigKvUpsertByKey is
  // deliberately NOT among them any more — this module cannot write a synced key because it has
  // no way to, which is a stronger guarantee than a rule someone has to remember.

  ipcMain.handle('station-folder:get', (_e, stationId) => {
    const sid = stationId ?? getActiveStationId();
    return { ok: true, stationId: sid, folder: getFolder(getDb(), sid, deps) };
  });

  ipcMain.handle('station-folder:choose', async (_e, stationId) => {
    const sid = stationId ?? getActiveStationId();
    const win = getMainWindow && getMainWindow();
    const res = await dialog.showOpenDialog(win, { title: `Select audio folder for this station`, properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const folder = res.filePaths[0];
    // Writes the PER-MACHINE library, never the synced per-station key. That key is now in
    // LOCAL_ONLY_KEYS, so the old upsert would silently no-op here and return ok — a success-shaped
    // failure that would have left the operator's chosen folder unsaved.
    deps.setMachineMusicDir(folder);
    return { ok: true, stationId: sid, folder };
  });

  // TEST SYNC — dry run, no writes. Reports whether the files are there.
  ipcMain.handle('station-folder:analyze', (_e, stationId) => {
    const sid = stationId ?? getActiveStationId();
    const folder = getFolder(getDb(), sid, deps);
    if (!folder) return { ok: false, error: 'No folder set for this station' };
    if (!fs.existsSync(folder)) return { ok: false, error: `Folder not found: ${folder}` };
    const r = matchStation(getDb(), sid, folder);
    return { ok: true, stationId: sid, folder, total: r.total, matched: r.matches.length,
             folderFiles: r.folderFiles, missing: r.missing.map(m => m.title),
             // Non-music audio is reported separately: an operator needs to know that six
             // announcements can be relinked, not just that the music is fine.
             assets: r.assets.length, assetsMissing: r.assetsMissing.length,
             assetsMissingDetail: r.assetsMissing.slice(0, 20) };
  });

  // RE-SYNC — link matches, skip misses. Returns the missing list.
  ipcMain.handle('station-folder:resync', (_e, stationId) => {
    const sid = stationId ?? getActiveStationId();
    const folder = getFolder(getDb(), sid, deps);
    if (!folder) return { ok: false, error: 'No folder set for this station' };
    if (!fs.existsSync(folder)) return { ok: false, error: `Folder not found: ${folder}` };
    const r = matchStation(getDb(), sid, folder);
    const applied = applyRelink(getDb(), sid, r, deps);
    return { ok: true, stationId: sid, folder, total: r.total, linked: applied.linked,
             unlinked: applied.unlinked, missing: r.missing.map(m => m.title),
             relinkedAssets: applied.relinkedAssets, assetsMissing: applied.assetsMissing,
             assetsMissingDetail: r.assetsMissing.slice(0, 20) };
  });

  // Library Relocate button: pick a folder for the ACTIVE station, save it, and re-sync in one step.
  ipcMain.handle('library:relocate', async (_e, stationId) => {
    const sid = stationId ?? getActiveStationId();
    const win = getMainWindow && getMainWindow();
    const res = await dialog.showOpenDialog(win, { title: 'Select this station’s music folder (Relocate)', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const folder = res.filePaths[0];
    deps.setMachineMusicDir(folder);     // per-machine — see station-folder:choose above
    const r = matchStation(getDb(), sid, folder);
    const applied = applyRelink(getDb(), sid, r, deps);
    return { ok: true, stationId: sid, folder, total: r.total, linked: applied.linked,
             unlinked: applied.unlinked, missing: r.missing.map(m => m.title),
             relinkedAssets: applied.relinkedAssets, assetsMissing: applied.assetsMissing,
             assetsMissingDetail: r.assetsMissing.slice(0, 20) };
  });
}

// applyRelink is exported for the bench (scripts/test-relink-no-mutation.js), which asserts the
// local-only property — that a relink writes the path and logs NO mutation.
module.exports = { register, matchStation, indexFolder, norm, getFolder, applyRelink };
