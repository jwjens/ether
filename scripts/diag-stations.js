const path = require("path"), os = require("os");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(path.join(os.homedir(), "AppData", "Roaming", "com.ether.radio", "openair.db"), { readOnly: true });

console.log("=== stations ===");
let stations;
try { stations = db.prepare(`SELECT id, name, is_active FROM stations ORDER BY id`).all(); }
catch { stations = db.prepare(`SELECT id, name FROM stations ORDER BY id`).all(); }
for (const s of stations) console.log(`  station ${s.id}: "${s.name}"${s.is_active != null ? ` active=${s.is_active}` : ""}`);

const clockName = {};
try { for (const c of db.prepare(`SELECT id, name, station_id FROM clocks`).all()) clockName[c.id] = c.name; } catch {}

for (const s of stations) {
  console.log(`\n=== station ${s.id} "${s.name}" shows ===`);
  let shows = [];
  try { shows = db.prepare(`SELECT id, name, is_active, clock_id, start_hour, end_hour, days FROM shows WHERE station_id = ? ORDER BY start_hour`).all(s.id); } catch {}
  for (const sh of shows) console.log(`  [${sh.id}] "${sh.name}" act=${sh.is_active} ${sh.start_hour}->${sh.end_hour} days=${sh.days} clock=${sh.clock_id}(${clockName[sh.clock_id]||"?"})`);
}
db.close();
