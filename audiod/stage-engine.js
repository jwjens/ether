// audiod/stage-engine.js — stage the audio engine to an external, separately-named runtime so
// it survives an app UPDATE (Item 10). The NSIS installer kills every Ether.exe and replaces
// the install folder; a daemon running as Ether.exe from inside that folder dies mid-update
// (that's the "music stopped during install" gap). Staged here as `ether-engine.exe` — a
// renamed copy of the Electron runtime — under %LOCALAPPDATA%\Ether\engine, the installer's
// name-kill AND folder-replace both miss it, so audio plays straight through the update.
//
// Re-stages only when the app version changes (a version marker); reboots reuse the staged
// copy. Windows-only for now (the renamed-Electron trick + NSIS kill-by-name are Windows
// specifics; macOS/Linux update-survival is a separate follow-up — the daemon still RUNS there
// since v4.3.1, it just isn't update-proof yet).

const fs = require("fs");
const path = require("path");
const os = require("os");

// The 5 daemon runtime files (NOT the smoke/accept test scripts) + the runtime data files a
// renamed Electron needs to boot as node (proven empirically: exe + icu + the two snapshots).
const DAEMON_FILES = ["ether-audiod.js", "engine.js", "loggen.js", "playlog.js", "stream.js"];
const RUNTIME_DATA = ["icudtl.dat", "v8_context_snapshot.bin", "snapshot_blob.bin"];

function engineBaseDir() {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Ether", "engine");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Ether", "engine");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "Ether", "engine");
}
function targetPaths(dir) { return { exe: path.join(dir, "ether-engine.exe"), script: path.join(dir, "audiod", "ether-audiod.js") }; }
function readText(p) { try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; } }
function cp1(src, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
function cpDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) cpDir(s, d); else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// An already-staged engine to spawn (no copying) — used by the watchdog, which respawns but
// shouldn't re-stage. Returns { exe, script } if a usable staged engine exists, else null.
function stagedTarget() {
  if (process.platform !== "win32") return null;
  const t = targetPaths(engineBaseDir());
  return (fs.existsSync(t.exe) && fs.existsSync(t.script)) ? t : null;
}

// Stage (copy) the engine runtime + code to the external dir, version-gated. Returns
// { exe, script } to spawn, or null if unsupported/failed (caller falls back to the in-dir
// engine — works, but dies on update).
//   srcRoot  = dir holding Ether.exe + the runtime data files (dirname of process.execPath)
//   unpacked = app.asar.unpacked root (holds audiod/, native/, electron/, node_modules/)
//   version  = app version (re-stage only when this changes)
function stageEngine({ srcRoot, unpacked, version }) {
  if (process.platform !== "win32") return null;
  try {
    const dir = engineBaseDir();
    const t = targetPaths(dir);
    const marker = path.join(dir, "version.txt");
    // Already staged at this version → reuse without copying (fast path; reboots hit this).
    if (fs.existsSync(t.exe) && fs.existsSync(t.script) && readText(marker) === version) return t;
    // If a daemon is already running it holds ether-engine.exe open → copying would EBUSY; the
    // caller should only stage when no daemon answers the pipe, but guard anyway: if the exe is
    // locked we keep the existing staged copy (return it) rather than disturb a live engine.
    fs.mkdirSync(dir, { recursive: true });

    cp1(path.join(srcRoot, "Ether.exe"), t.exe);                              // renamed runtime
    for (const f of RUNTIME_DATA) { const s = path.join(srcRoot, f); if (fs.existsSync(s)) cp1(s, path.join(dir, f)); }
    for (const f of DAEMON_FILES)  cp1(path.join(unpacked, "audiod", f), path.join(dir, "audiod", f));
    cp1(path.join(unpacked, "native", "ether-audio.node"), path.join(dir, "native", "ether-audio.node"));
    for (const f of ["mutation-writer.js", "synced-tables.js"]) cp1(path.join(unpacked, "electron", "sync", f), path.join(dir, "electron", "sync", f));
    const ffSrc = path.join(unpacked, "node_modules", "ffmpeg-static");        // whole pkg (index.js resolves the binary)
    if (fs.existsSync(ffSrc)) cpDir(ffSrc, path.join(dir, "node_modules", "ffmpeg-static"));

    fs.writeFileSync(marker, version);
    return t;
  } catch (e) {
    console.error("[stage-engine] staging failed (" + e.code + "): " + e.message + " — falling back to in-dir engine");
    // If staging failed because the exe is locked by a running engine, reuse what's staged.
    return stagedTarget();
  }
}

module.exports = { stageEngine, stagedTarget, engineBaseDir };
