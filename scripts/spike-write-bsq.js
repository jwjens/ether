// Item 10 Phase 2 Step 4 spike — writer A (the "app" role): better-sqlite3 under
// ELECTRON_RUN_AS_NODE (better-sqlite3 is V8-ABI, built for Electron's ABI, so it can't
// run in bare node). Hammers the scratch table to contend with the node:sqlite writer.
// Driven by scripts/spike-write-contention.js — not run directly.
//   ELECTRON_RUN_AS_NODE=1 <electron|Ether>.exe scripts/spike-write-bsq.js <dbPath> <label> <count>
const Database = require("better-sqlite3");
const [dbPath, label, countStr] = process.argv.slice(2);
const count = Number(countStr || 2000);
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");          // matches better-sqlite3's default; explicit for clarity
const ins = db.prepare("INSERT INTO _spike_log(src, n, ts) VALUES (?, ?, ?)");
let inserted = 0, busy = 0, other = 0, lastErr = "";
const t0 = Date.now();
for (let i = 0; i < count; i++) {
  try { ins.run(label, i, Date.now()); inserted++; }
  catch (e) { if (/busy|locked/i.test(e.message)) busy++; else { other++; lastErr = e.message; } }
}
console.log(JSON.stringify({ writer: label, inserted, busy, other, ms: Date.now() - t0, lastErr }));
db.close();
