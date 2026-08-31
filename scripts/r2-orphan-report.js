// scripts/r2-orphan-report.js — REPORT ONLY. Reads. Deletes nothing. Ever.
//
// First pass of the R2 deletion work (2026-08-14). Before anything can be removed from R2 we need
// two facts, and only one of them needs R2 to answer:
//
//   SCALE   — how many deleted songs still believe they have audio in the bucket.
//   SHARING — whether a file_key is referenced by more than one song/station. This is the safety
//             rule: delete the object only when the song is the ONLY reference to that key.
//
// SHARING is a database question, so it is answered here exactly. SIZES are not — `songs` has no
// size column, and listing the bucket needs either an S3 client (no AWS SDK in this tree) or a
// backend endpoint. Sizes are therefore reported as UNKNOWN rather than guessed.
//
// Run: ELECTRON_RUN_AS_NODE=1 node_modules\.bin\electron scripts\r2-orphan-report.js

const path = require("path");
const os   = require("os");
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const dbPath = process.env.ETHER_DB || path.join(localAppData, "Ether", "com.ether.radio", "openair.db");

console.log("[r2-orphan-report] DB:", dbPath);
console.log("[r2-orphan-report] READ-ONLY — this script never deletes anything.\n");

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { return [{ ERROR: e.message }]; } };
const one = (sql, ...a) => all(sql, ...a)[0];
const hr  = (t) => console.log("\n" + "=".repeat(78) + "\n" + t + "\n" + "=".repeat(78));

hr("1 — SCALE: deleted songs that still believe they have audio in R2");
console.log("deleted songs (soft)              :", one("SELECT COUNT(*) n FROM songs WHERE deleted_at IS NOT NULL"));
console.log("  ...with a file_key              :", one("SELECT COUNT(*) n FROM songs WHERE deleted_at IS NOT NULL AND file_key IS NOT NULL AND TRIM(file_key) <> ''"));
console.log("  ...and confirmed uploaded to R2 :", one("SELECT COUNT(*) n FROM songs WHERE deleted_at IS NOT NULL AND file_key IS NOT NULL AND r2_uploaded_at IS NOT NULL"));
console.log("\nNOTE: these are SOFT deletes. Per the 2026-08-14 decision only a HARD delete may");
console.log("release audio, and only after a 30-day grace period. Nothing below is a delete list.");

hr("2 — SHARING: is a file_key referenced by more than one song?");
const shared = all(`
  SELECT file_key, COUNT(*) refs,
         SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) live_refs,
         SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) deleted_refs
    FROM songs
   WHERE file_key IS NOT NULL AND TRIM(file_key) <> ''
   GROUP BY file_key
  HAVING COUNT(*) > 1
   ORDER BY refs DESC`);
console.log("file_keys with more than one reference:", shared.length);
console.log(shared.slice(0, 20));

hr("3 — THE SAFETY RULE, evaluated: deleted songs whose key is STILL referenced by a live song");
// These are the ones that must NEVER be released, whatever their delete state.
const protectedKeys = all(`
  SELECT d.uuid, d.title, d.file_key, d.deleted_at,
         (SELECT COUNT(*) FROM songs s2 WHERE s2.file_key = d.file_key AND s2.deleted_at IS NULL) live_refs
    FROM songs d
   WHERE d.deleted_at IS NOT NULL AND d.file_key IS NOT NULL AND TRIM(d.file_key) <> ''
     AND EXISTS (SELECT 1 FROM songs s2 WHERE s2.file_key = d.file_key AND s2.deleted_at IS NULL)
   ORDER BY d.deleted_at DESC`);
console.log("PROTECTED (shared with a live song — keep the file):", protectedKeys.length);
console.log(protectedKeys.slice(0, 15));

hr("4 — SOLE-REFERENCE candidates (deleted, and nothing live points at the key)");
const sole = all(`
  SELECT d.uuid, d.title, d.file_key, d.deleted_at,
         (SELECT COUNT(*) FROM songs s2 WHERE s2.file_key = d.file_key) total_refs
    FROM songs d
   WHERE d.deleted_at IS NOT NULL AND d.file_key IS NOT NULL AND TRIM(d.file_key) <> ''
     AND NOT EXISTS (SELECT 1 FROM songs s2 WHERE s2.file_key = d.file_key AND s2.deleted_at IS NULL)
   ORDER BY d.deleted_at DESC`);
console.log("count:", sole.length, " (size: UNKNOWN — needs a bucket listing)");
console.log(sole.slice(0, 25));
console.log("\nThese are CANDIDATES ONLY. They are soft-deleted, which under the agreed rules keeps");
console.log("its audio. None of them is eligible until it is HARD-deleted and 30 days have passed.");

hr("5 — Key shape (does the namespace look account-wide or station-scoped?)");
console.log(all("SELECT file_key FROM songs WHERE file_key IS NOT NULL AND TRIM(file_key) <> '' ORDER BY id LIMIT 8"));
console.log("\nA bare filename means the namespace is shared, so two stations CAN collide on a key and");
console.log("the sole-reference rule is load-bearing rather than theoretical.");

db.close();
console.log("\n[r2-orphan-report] done — nothing was written or deleted.");
