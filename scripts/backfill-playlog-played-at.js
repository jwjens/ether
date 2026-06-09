// One-time: backfill play_log.played_at (NULL since the writer-bug window) from created_at,
// so historical plays sort correctly in Play History. Narrow + safe: only touches rows
// where played_at IS NULL, only fills the timestamp. Run:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill-playlog-played-at.js
const Database = require("better-sqlite3");
const path = require("path"), os = require("os");
const dbPath = process.env.ETHER_DB || path.join(os.homedir(), "AppData", "Roaming", "com.ether.radio", "openair.db");

const db = new Database(dbPath);          // write connection
db.pragma("busy_timeout = 8000");          // OV is live — wait out any in-flight writes

const before = db.prepare("SELECT COUNT(*) n FROM play_log WHERE played_at IS NULL").get().n;
const res = db.prepare(
  `UPDATE play_log
     SET played_at = CAST(strftime('%s', created_at) AS INTEGER)
   WHERE played_at IS NULL AND created_at IS NOT NULL AND created_at != ''`
).run();
const remaining = db.prepare("SELECT COUNT(*) n FROM play_log WHERE played_at IS NULL").get().n;

console.log(`NULL played_at before: ${before}`);
console.log(`backfilled (changes):  ${res.changes}`);
console.log(`remaining NULL:        ${remaining}`);
console.log("\nmost-recent 6 by played_at after backfill:");
for (const r of db.prepare("SELECT title, played_at FROM play_log WHERE played_at IS NOT NULL ORDER BY played_at DESC LIMIT 6").all()) {
  console.log(`  ${new Date(r.played_at * 1000).toLocaleString()}  ${r.title}`);
}
db.close();
