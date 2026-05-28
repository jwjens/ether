// Phase 1 spike (Item 10): can the bare-Node daemon read openair.db with Node's built-in
// node:sqlite (since better-sqlite3 is V8-ABI and won't load in bare node)? loggen runs in
// the daemon, so it needs this. Read-only, WAL, while the app may also hold the DB open.
const path = require("path"), os = require("os");
const dbPath = path.join(os.homedir(), "AppData", "Roaming", "com.ether.radio", "openair.db");

let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); }
catch (e) { console.error("node:sqlite unavailable:", e.message, "\n→ retry with: node --experimental-sqlite"); process.exit(1); }

let db;
try { db = new DatabaseSync(dbPath, { readOnly: true }); }
catch (e) { console.error("open failed:", e.message); process.exit(1); }

const songs = db.prepare("SELECT COUNT(*) AS c FROM songs WHERE file_path IS NOT NULL").get();
const cats  = db.prepare("SELECT DISTINCT category_id FROM clock_slots WHERE category_id IS NOT NULL AND deleted_at IS NULL").all();
const shows = db.prepare("SELECT COUNT(*) AS c FROM shows WHERE is_active = 1").get();
console.log("Runtime:", process.version);
console.log("songs with local files :", songs.c);
console.log("clock-slot categories  :", cats.map(r => r.category_id).join(", "));
console.log("active shows           :", shows.c);
db.close();
console.log("\n→ VERDICT: node:sqlite reads openair.db from bare Node ✅ — loggen can run inside the daemon.");
