'use strict';
// Per-station music folders + re-sync (DESIGN-TRUTH §2: stations are independent). Each station
// stores its own audio folder (station_config_kv key 'music_dir'); re-sync relinks that station's
// songs ONLY from its own folder (no cross-station bleed) and reports what's missing. One matcher
// powers: Test sync (dry-run), Re-sync (writes), and the Library Relocate button.

const fs = require('fs');
const path = require('path');

const AUDIO = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg']);

// Normalize a title/filename for tolerant matching (spaces vs underscores, "_spotdown.org" suffix,
// punctuation). Kept deliberately conservative — we match within ONE folder, so exact-ish is right.
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/_spotdown\.org|spotdown\.org/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

// Build normalized-name -> absolute path index of a folder tree (first hit wins).
function indexFolder(folder) {
  const map = new Map();
  (function walk(dir, depth) {
    if (depth > 6) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (AUDIO.has(path.extname(e.name).toLowerCase())) {
        const k = norm(path.parse(e.name).name);
        if (k && !map.has(k)) map.set(k, full);
      }
    }
  })(folder, 0);
  return map;
}

function getFolder(db, stationId) {
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
function matchStation(db, stationId, folder) {
  const idx = (folder && fs.existsSync(folder)) ? indexFolder(folder) : new Map();
  const cats = formatCategoryIds(db, stationId);
  let rows;
  if (cats.length) {
    rows = db.prepare(
      `SELECT s.id AS songId, s.title AS title FROM songs s
        WHERE s.deleted_at IS NULL AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
          AND (s.content_class IS NULL OR s.content_class = 'MUSIC')
          AND s.category_id IN (${cats.map(() => '?').join(',')})`
    ).all(...cats);
  } else {
    rows = db.prepare(
      `SELECT DISTINCT gs.song_id AS songId, COALESCE(s.title, gs.title) AS title
         FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
        WHERE gs.station_id = ? AND gs.deleted_at IS NULL`
    ).all(stationId);
  }
  const matches = [], missing = [];
  for (const r of rows) {
    const f = idx.get(norm(r.title));
    if (f && fs.existsSync(f)) matches.push({ songId: r.songId, title: r.title, file: f });
    else missing.push({ songId: r.songId, title: r.title });
  }
  return { folder: folder || null, total: rows.length, matches, missing, folderFiles: idx.size };
}

// Write the matches (link) and NULL the misses (so the scheduler SKIPS them instead of stalling).
// songs.file_path goes through the sync-logged writer; generated_schedule.file_path is local play state.
function applyRelink(db, stationId, result, deps) {
  const setGs   = db.prepare("UPDATE generated_schedule SET file_path = ? WHERE station_id = ? AND song_id IS ?");
  const setGsT  = db.prepare("UPDATE generated_schedule SET file_path = ? WHERE station_id = ? AND title = ? AND song_id IS NULL");
  const nullGs  = db.prepare("UPDATE generated_schedule SET file_path = NULL WHERE station_id = ? AND song_id IS ?");
  const tx = db.transaction(() => {
    for (const m of result.matches) {
      if (m.songId != null) {
        setGs.run(m.file, stationId, m.songId);
        try { deps.songsUpdateById(db, m.songId, { file_path: m.file }); } catch { /* keep gs link even if song row is odd */ }
      } else {
        setGsT.run(m.file, stationId, m.title);
      }
    }
    for (const m of result.missing) if (m.songId != null) nullGs.run(stationId, m.songId);
  });
  tx();
  return { linked: result.matches.length, missingCount: result.missing.length };
}

function register(deps) {
  const { ipcMain, dialog, getDb, getActiveStationId, getMainWindow } = deps;

  ipcMain.handle('station-folder:get', (_e, stationId) => {
    const sid = stationId ?? getActiveStationId();
    return { ok: true, stationId: sid, folder: getFolder(getDb(), sid) };
  });

  ipcMain.handle('station-folder:choose', async (_e, stationId) => {
    const sid = stationId ?? getActiveStationId();
    const win = getMainWindow && getMainWindow();
    const res = await dialog.showOpenDialog(win, { title: `Select audio folder for this station`, properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const folder = res.filePaths[0];
    deps.stationConfigKvUpsertByKey(getDb(), sid, 'music_dir', folder);
    return { ok: true, stationId: sid, folder };
  });

  // TEST SYNC — dry run, no writes. Reports whether the files are there.
  ipcMain.handle('station-folder:analyze', (_e, stationId) => {
    const sid = stationId ?? getActiveStationId();
    const folder = getFolder(getDb(), sid);
    if (!folder) return { ok: false, error: 'No folder set for this station' };
    if (!fs.existsSync(folder)) return { ok: false, error: `Folder not found: ${folder}` };
    const r = matchStation(getDb(), sid, folder);
    return { ok: true, stationId: sid, folder, total: r.total, matched: r.matches.length,
             folderFiles: r.folderFiles, missing: r.missing.map(m => m.title) };
  });

  // RE-SYNC — link matches, skip misses. Returns the missing list.
  ipcMain.handle('station-folder:resync', (_e, stationId) => {
    const sid = stationId ?? getActiveStationId();
    const folder = getFolder(getDb(), sid);
    if (!folder) return { ok: false, error: 'No folder set for this station' };
    if (!fs.existsSync(folder)) return { ok: false, error: `Folder not found: ${folder}` };
    const r = matchStation(getDb(), sid, folder);
    const applied = applyRelink(getDb(), sid, r, deps);
    return { ok: true, stationId: sid, folder, total: r.total, linked: applied.linked,
             missing: r.missing.map(m => m.title) };
  });

  // Library Relocate button: pick a folder for the ACTIVE station, save it, and re-sync in one step.
  ipcMain.handle('library:relocate', async (_e, stationId) => {
    const sid = stationId ?? getActiveStationId();
    const win = getMainWindow && getMainWindow();
    const res = await dialog.showOpenDialog(win, { title: 'Select this station’s music folder (Relocate)', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const folder = res.filePaths[0];
    deps.stationConfigKvUpsertByKey(getDb(), sid, 'music_dir', folder);
    const r = matchStation(getDb(), sid, folder);
    const applied = applyRelink(getDb(), sid, r, deps);
    return { ok: true, stationId: sid, folder, total: r.total, linked: applied.linked,
             missing: r.missing.map(m => m.title) };
  });
}

module.exports = { register, matchStation, indexFolder, norm, getFolder };
