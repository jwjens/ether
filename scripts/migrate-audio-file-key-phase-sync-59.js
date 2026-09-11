'use strict';
// Migration v59 — file_key for the other five audio tables.
//
// Jeff, 2026-09-11: "a cart created on one machine should play on the other without me carrying
// files."
//
// WHAT THIS IS FOR, AND WHAT IT IS NOT FOR. It is NOT for backup coverage. The cloud backup has been
// folder-driven since e36d675 — uploadCatalogue() walks the catalogue and sends every audio file,
// row or no row, key or no key (audio-library-r2.js:1-39). Carts have been going up for days.
//
// It is for the two things that are still row-shaped:
//
//   (1) HONEST REPORTING. library-health.js classifyRow() returns `r2Only` when a row carries a
//       file_key and `dead` otherwise (:174-175). A cart whose audio is safely in R2 but not yet on
//       THIS machine has no key to show, so it cannot be classified as "in the cloud, not here yet"
//       — it is classified dead, and the Health Monitor calls it MISSING. That is precisely what
//       happened on OV on 2026-09-11: four "missing", three of them files sitting in the cloud. The
//       count that sent us hunting a sync defect was the artefact of this absent column.
//       The classifier needs NO change: colsOf() reads the column generically, so these rows start
//       classifying correctly the moment the column exists and is filled.
//
//   (2) PER-ROW MATERIALIZATION. fetchR2Track(fileKey) (main.js:8380) is already table-agnostic —
//       it takes a bare key. Only its callers are songs-shaped. With a key on the row, a cart can
//       fetch its own audio on demand instead of waiting for a whole-catalogue pass.
//
// WHY IT IS HALF OF WHAT WAS DEFERRED. The original plan (one-sync-arc-2026-09-09.md §3.2) needed
// file_key AND r2_uploaded_at on five tables, to widen a row-driven upload query. Folder-driven R2
// removed both from the backup path: the manifest is the resume marker, so there is no per-row
// upload state to track on any table. `r2_uploaded_at` is deliberately NOT added here. Adding a
// local-only marker that nothing would read is how a schema grows columns nobody can explain.
//
// NOT IN SCOPE, AND GUARDED ELSEWHERE: the deletion sweep. deletion-sweep.js keys entirely on
// file_key, so giving these tables one would silently admit them to a process that RELEASES R2
// OBJECTS. Its shared-key guard (deletion-sweep.js:127-140) checks `songs` and `generated_schedule`
// only — a cart and a song can legitimately name the same file, and deleting the cart must not
// release an object the song still needs. The five tables are excluded explicitly in
// deletion-sweep.js and the exclusion is asserted by scripts/smoke-one-switch.js §11. Jeff:
// "Sweep excluded, and I want that exclusion explicit and guarded, not implied."
//
// BACKFILL. file_key = basename(file_path), the same rule songs has used since v17, whose pure-JS
// basename handles both separators so a path written on either host platform backfills correctly.
// Case is NOT normalised and must not be: file_key has to match the object key in R2, which is the
// file's actual name on disk. songs already holds two rows whose keys differ only in case
// (audio-library-r2.js:155-160) and the upload keys on the real filename precisely to survive that.
//
// SYNC. Registered as 'scalar' in synced-tables.js, exactly like songs.file_key: a content identity,
// not a machine path, so it is safe and correct to carry across machines. `file_path` stays
// 'blob-ref' and keeps its [N-23a] basename reconstruction. Nothing about the wire shape changes for
// a reader without the column, so the payload transformer is a pass-through.

const TABLES = ['announcements', 'spots', 'cart_slots', 'voice_tracks', 'published_episodes'];

/** Pure-JS basename — handles '/' and '\' so paths from any host platform resolve. From v17. */
function basename(p) {
  if (p === null || p === undefined) return null;
  const s = String(p);
  if (s === '') return null;
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx === -1 ? s : s.slice(idx + 1);
}

function tableExists(db, t) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  } catch { return false; }
}

function columns(db, t) {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name); }
  catch { return []; }
}

function isAlreadyMigrated(db) {
  // Every table that EXISTS and carries file_path must carry file_key. A table absent on this
  // install is not a reason to call the migration unfinished.
  for (const t of TABLES) {
    if (!tableExists(db, t)) continue;
    const cols = columns(db, t);
    if (!cols.includes('file_path')) continue;
    if (!cols.includes('file_key')) return false;
  }
  return true;
}

function applyMigration(db) {
  const migrate = db.transaction(() => {
    for (const t of TABLES) {
      if (!tableExists(db, t)) {
        console.log(`[migrate-v59] ${t} absent on this install — skipped.`);
        continue;
      }
      const cols = columns(db, t);
      if (!cols.includes('file_path')) {
        console.log(`[migrate-v59] ${t} has no file_path — not an audio-bearing table here, skipped.`);
        continue;
      }
      if (!cols.includes('file_key')) {
        db.prepare(`ALTER TABLE ${t} ADD COLUMN file_key TEXT`).run();
        console.log(`[migrate-v59] ${t}.file_key added.`);
      } else {
        console.log(`[migrate-v59] ${t}.file_key already present — no-op.`);
      }

      // BACKFILL, IN JS RATHER THAN SQL. SQLite has no basename(), and doing it with instr/substr
      // against both separators is the kind of clever SQL that is wrong on one platform and nobody
      // notices for a year.
      //
      // A DIRECT UPDATE, NOT THE MUTATION-LOGGING WRITER, AND THAT IS DELIBERATE. Backfilling five
      // tables through the synced path would journal one mutation per row — thousands at once, onto
      // a queue that on this machine already cannot drain. The value is derived from file_path,
      // which every peer already has, so every peer computes the identical key from its own copy of
      // the row. There is nothing to tell anyone. Sending it would be noise that says what the
      // receiver already knows.
      const rows = db.prepare(
        `SELECT rowid AS _rid, file_path FROM ${t}
          WHERE file_path IS NOT NULL AND file_path != ''
            AND (file_key IS NULL OR file_key = '')`
      ).all();
      const upd = db.prepare(`UPDATE ${t} SET file_key = ? WHERE rowid = ?`);
      let filled = 0;
      for (const r of rows) {
        const key = basename(r.file_path);
        if (key) { upd.run(key, r._rid); filled++; }
      }
      if (filled) console.log(`[migrate-v59] ${t}: backfilled ${filled} file_key value(s) from file_path.`);
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (59)').run(); } catch { /* recorded */ }
  });
  migrate();
  console.log('[migrate-v59] Transaction committed.');
}

module.exports = {
  // Pass-through: file_key is a new scalar on tables that already sync. A payload written before v59
  // simply lacks it, and a reader without the column ignores it. Nothing on the wire needs rewriting.
  payloadTransformer: function payloadTransformer(payload) { return payload; },
  applyMigration,
  isAlreadyMigrated,
  TABLES,
};
