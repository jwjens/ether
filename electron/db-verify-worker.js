// Database verification, OFF the main thread.
//
// Opening a several-hundred-MB SQLite file, parsing its schema and running integrity_check are all
// synchronous, CPU- and IO-bound work. Done on Electron's main thread they block the event loop for
// long enough that Windows paints the window "Not Responding" mid-restore — the operator sees the app
// hang at the exact moment it is being careful. This worker does that work in its own thread so the
// UI keeps painting and progress keeps flowing.
//
// It only ever READS. Nothing here modifies a database.
const { parentPort, workerData } = require("worker_threads");

function verify(dbFile, deep) {
  let Database;
  try { Database = require("better-sqlite3"); }
  catch (e) { return { ok: false, reason: `sqlite unavailable in worker: ${e.message}` }; }

  let conn = null;
  try {
    conn = new Database(dbFile, { readonly: true, fileMustExist: true });
    // Forces the schema parse — where a malformed file throws "malformed database schema (<object>)".
    const objects = conn.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()?.n ?? 0;
    if (objects < 20) throw new Error(`schema looks truncated (${objects} objects)`);
    conn.prepare("SELECT COUNT(*) AS n FROM system_state").get();
    const songs = conn.prepare("SELECT COUNT(*) AS n FROM songs").get()?.n ?? 0;

    let integrity = null;
    if (deep) {
      parentPort?.postMessage({ progress: "checking the database for damage" });
      integrity = conn.prepare("PRAGMA integrity_check").get()?.integrity_check ?? null;
    }
    return { ok: true, objects, songs, integrity };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    try { if (conn) conn.close(); } catch {}
  }
}

const { dbFile, deep } = workerData || {};
parentPort?.postMessage({ result: verify(dbFile, !!deep) });
