// Item 10 Phase 2 — Step 0 GATE spike. The packaged app has no guaranteed system Node, so
// ether-audiod must run under Electron's bundled node via ELECTRON_RUN_AS_NODE. This proves
// the daemon's two hard dependencies work there:
//   (1) node:sqlite  — the scheduler's DB binding (needs the bundled Node to ship it)
//   (2) the N-API audio addon — loads under Electron's node ABI
// Read-only against openair.db + a TEMP-table write (proves RW mode without mutating data;
// the real cross-process write-contention test is Phase-2 Step 4).
//
// Run under each Electron binary:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/spike-electron-node-sqlite.js
//   ELECTRON_RUN_AS_NODE=1 dist-electron/win-unpacked/Ether.exe   scripts/spike-electron-node-sqlite.js
const path = require("path"), os = require("os");

const v = process.versions;
console.log("runtime:", JSON.stringify({ node: v.node, electron: v.electron, modules: v.modules, v8: v.v8 }));
console.log("ELECTRON_RUN_AS_NODE:", process.env.ELECTRON_RUN_AS_NODE || "(unset)");

let pass = true;
function check(label, fn) {
  try { const r = fn(); console.log("  ✅ " + label + (r !== undefined ? " — " + r : "")); }
  catch (e) { pass = false; console.log("  ❌ " + label + " — " + (e && e.message || e)); }
}

// (1) node:sqlite
let DatabaseSync = null;
check("require('node:sqlite')", () => { ({ DatabaseSync } = require("node:sqlite")); return "loaded"; });

const dbPath = process.env.ETHER_DB_PATH || path.join(os.homedir(), "AppData", "Roaming", "com.ether.radio", "openair.db");
if (DatabaseSync) {
  check("open openair.db read-only (WAL)", () => { const db = new DatabaseSync(dbPath, { readOnly: true }); const n = db.prepare("SELECT COUNT(*) c FROM songs WHERE file_path IS NOT NULL").get().c; db.close(); return n + " local songs"; });
  check("open read-WRITE + TEMP-table write (no data mutated)", () => {
    const db = new DatabaseSync(dbPath, { readOnly: false });
    db.exec("CREATE TEMP TABLE _spike(x INTEGER)");
    db.exec("INSERT INTO _spike VALUES (42)");
    const got = db.prepare("SELECT x FROM _spike").get().x;
    db.exec("DROP TABLE _spike");
    db.close();
    if (got !== 42) throw new Error("temp write readback mismatch");
    return "RW mode available";
  });
}

// (2) N-API audio addon under Electron's node
check("require ether-audio.node (N-API)", () => {
  const A = require(path.join(__dirname, "..", "native", "ether-audio.node"));
  const core = ["initAudioEngine", "audioLoad", "audioPlay", "audioGetState", "audioGetLevels", "audioGetProgramBusPort"];
  const missing = core.filter(fn => typeof A[fn] !== "function");
  if (missing.length) throw new Error("missing exports: " + missing.join(", "));
  return Object.keys(A).length + " exports, all core fns present";
});

console.log("\n→ STEP 0 VERDICT: " + (pass ? "✅ daemon runtime viable under ELECTRON_RUN_AS_NODE" : "❌ blocked — see failures above"));
process.exit(pass ? 0 : 1);
