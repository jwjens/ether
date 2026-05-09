const path = require("path");
const os = require("os");
const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath = path.join(appData, "com.ether.radio", "openair.db");
const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath, { readonly: true });

const row = db.prepare(`
  SELECT
    COUNT(*)                                        AS total,
    COUNT(duration_ms)                              AS with_duration,
    COUNT(CASE WHEN duration_ms > 0 THEN 1 END)    AS nonzero,
    CAST(AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) AS INTEGER) AS avg_ms
  FROM songs
`).get();

console.log("=== songs duration_ms audit ===");
console.log(`  total rows:       ${row.total}`);
console.log(`  with_duration:    ${row.with_duration}  (non-NULL)`);
console.log(`  nonzero:          ${row.nonzero}  (duration_ms > 0)`);
console.log(`  avg_ms (nonzero): ${row.avg_ms ?? "n/a"}  (~${row.avg_ms ? Math.round(row.avg_ms / 60000) : "?"}m)`);

if (row.total === 0) {
  console.log("\n  [WARN] Library is empty.");
} else if (row.nonzero === 0) {
  console.log("\n  [FAIL] No song has duration_ms > 0 — library scanner never wrote it.");
  console.log("         Fix path: populate duration_ms at import time, not at play time.");
} else if (row.nonzero < row.total * 0.5) {
  console.log(`\n  [WARN] Only ${row.nonzero}/${row.total} songs have duration — partial population.`);
} else {
  console.log(`\n  [OK] ${row.nonzero}/${row.total} songs have duration_ms.`);
}

db.close();
process.exit(0);
