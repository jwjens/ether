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

// The daemon runtime files (NOT the smoke/accept test scripts) + the runtime data files a
// renamed Electron needs to boot as node (proven empirically: exe + icu + the two snapshots).
// ⚠ THIS WAS A HAND-MAINTAINED LIST, AND IT FAILED TWICE.
//   2026-07-09 — daemon-log.js was left out; the staged daemon hit MODULE_NOT_FOUND and went blind
//                (docs/overnight-rotation-stop-forensics-2026-07-09.md).
//   2026-07-30 — autofit.js was left out when engine.js began require()ing it. The PACKAGE was correct
//                (asarUnpack "audiod/**" ships everything) and verify-packaged.js passed, because the
//                daemon does not run from the package — it runs from THIS staged copy. Stations went
//                silent-while-playing with the app in in-process fallback.
// The list itself was the defect: it has to be updated by hand every time the daemon gains a require,
// and nothing enforces that. It is now DERIVED. Every runtime .js in audiod/ is staged; only the test
// scripts are excluded, and they are excluded by a naming rule, not by omission.
const isTestScript = (n) => /^(smoke|accept|verify)-/.test(n);
const isDaemonRuntimeFile = (n) => n.endsWith(".js") && !isTestScript(n);
function daemonFiles(audiodDir) {
  return fs.readdirSync(audiodDir, { withFileTypes: true })
    .filter(e => e.isFile() && isDaemonRuntimeFile(e.name))
    .map(e => e.name);
}
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

    // Locked-file tolerant (4.4.44): a SURVIVING detached daemon holds ether-engine.exe (and the
    // runtime data + native .node it mapped) open → copying throws EBUSY. Before, that aborted the
    // WHOLE stage and returned the stale copy, so the daemon CODE never updated — jensj ran a 4.4.41
    // daemon under a 4.4.43 app (2026-07-10), which is why the lastCallbackMs cmd was missing. The
    // Electron runtime is unchanged across a code-only bump, so reuse the existing staged .exe/.node
    // when locked but ALWAYS refresh the daemon .js code (node reads .js into memory, never locks it).
    const cpSoft = (src, dst) => { try { cp1(src, dst); return true; } catch (e) { if (e && (e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES")) return false; throw e; } };
    const exeOk = cpSoft(path.join(srcRoot, "Ether.exe"), t.exe);              // renamed runtime (may be locked)
    if (!exeOk && !fs.existsSync(t.exe)) throw new Error("ether-engine.exe: source locked and no prior staged copy");
    for (const f of RUNTIME_DATA) { const s = path.join(srcRoot, f); if (fs.existsSync(s)) cpSoft(s, path.join(dir, f)); }
    // CODE — must refresh (not locked). Enumerated from the source dir, never from a hand-kept list.
    for (const f of daemonFiles(path.join(unpacked, "audiod"))) cp1(path.join(unpacked, "audiod", f), path.join(dir, "audiod", f));
    cpSoft(path.join(unpacked, "native", "ether-audio.node"), path.join(dir, "native", "ether-audio.node")); // may be loaded/locked
    for (const f of ["mutation-writer.js", "synced-tables.js"]) cp1(path.join(unpacked, "electron", "sync", f), path.join(dir, "electron", "sync", f));
    const ffSrc = path.join(unpacked, "node_modules", "ffmpeg-static");        // whole pkg (index.js resolves the binary)
    if (fs.existsSync(ffSrc)) { try { cpDir(ffSrc, path.join(dir, "node_modules", "ffmpeg-static")); } catch { /* locked ffmpeg — reuse */ } }

    fs.writeFileSync(marker, version);   // code refreshed → mark this version even if the .exe was reused
    return t;
  } catch (e) {
    console.error("[stage-engine] staging failed (" + e.code + "): " + e.message + " — falling back to in-dir engine");
    // If staging failed because the exe is locked by a running engine, reuse what's staged.
    return stagedTarget();
  }
}

// daemonFilesForVerify: the SAME derivation the stage uses, exposed so the release gate
// (audiod/verify-packaged.js) can assert every daemon require resolves to something that gets staged.
// Exported deliberately — the gate must check what staging actually does, not a copy of the rule.
module.exports = { stageEngine, stagedTarget, engineBaseDir, daemonFilesForVerify: daemonFiles };
