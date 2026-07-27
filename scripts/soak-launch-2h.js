// Detached launcher for the 2-hour station-isolation soak. Spawns soak-isolation.js fully detached
// (survives independent of any parent), logging to Documents/reports so results persist. Non-disruptive:
// the soak mutes the monitor, runs its own daemon against a DB copy, and injects the kill at t=10min.
const cp = require("child_process"), path = require("path"), fs = require("fs"), os = require("os");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logDir = path.join(os.homedir(), "Documents", "reports");
try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
const log = path.join(logDir, `soak-2h-run-${stamp}.log`);
const out = fs.openSync(log, "a");
const child = cp.spawn(process.execPath, [
  path.join(__dirname, "soak-isolation.js"),
  "--seconds", "7200", "--kill-at", "600", "--kill-station", "2",
], { detached: true, stdio: ["ignore", out, out] });
child.unref();
console.log("2h soak launched: pid", child.pid);
console.log("log:", log);
