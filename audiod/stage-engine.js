// audiod/stage-engine.js — stage the audio engine to an external, separately-named runtime so
// it survives an app UPDATE (Item 10). The NSIS installer kills every Ether.exe and replaces
// the install folder; a daemon running as Ether.exe from inside that folder dies mid-update
// (that's the "music stopped during install" gap). Staged here as `ether-engine.exe` — a
// renamed copy of the Electron runtime — under %LOCALAPPDATA%\Ether\engine, the installer's
// name-kill AND folder-replace both miss it, so audio plays straight through the update.
//
// Windows-only for now (the renamed-Electron trick + NSIS kill-by-name are Windows
// specifics; macOS/Linux update-survival is a separate follow-up — the daemon still RUNS there
// since v4.3.1, it just isn't update-proof yet).
//
// ── CONTENT-KEYED, NOT VERSION-KEYED (2026-10-10, docs/monitor-failed-test-diagnosis-2026-10-10.md) ──────────────
// This used to re-stage only when version.txt differed from the app version. The MONITOR fix build was labelled
// 4.6.59 like the build before it, so on OVEVENTS the install changed and the stage did not: the daemon kept loading
// the PRE-FIX ether-audio.node and Jeff's test heard every fader with MONITOR down. Now every staged file is compared
// with the installed one by sha256 on every stage, and any file that differs is replaced. version.txt is still written,
// for people, and decides nothing.
//
// Hashing cost: the native engine and the daemon code (~7 MB) are hashed on both sides every time — that is where a
// fix lives. The big runtime files (the ~240 MB exe, ICU, snapshots, ffmpeg) are hashed when their size or mtime
// differs from what stage-manifest.json recorded for them, and the recorded hash is reused otherwise.
//
// ── A FILE IN USE (was stage-engine.js:113) ─────────────────────────────────────────────────────────────────────────
// A daemon that survived the app holds ether-engine.exe and ether-audio.node open, so overwriting them fails. That used
// to be swallowed: the old engine was kept with nothing said, even across a version bump. Now:
//   1. the in-use file is RENAMED aside (<name>.old-<time>) — Windows allows renaming a running exe / loaded DLL — and
//      the installed file is copied in. The running daemon keeps its renamed copy and is not touched; the NEXT start
//      loads the new one. Old copies are deleted on a later stage once nothing holds them.
//   2. if even that fails, the old file stays, is reported by name with both hashes, and the next stage retries.
// Either way the running daemon is never stopped from here. Replacing it is main's job, at a moment no station is live
// (main.js armDaemonReload / fireDaemonReload — never mid-broadcast), and main reports the running engine's hash
// against the installed one in the Health Monitor until it is replaced.

const fs = require("fs");
const path = require("path");
const os = require("os");
const FP = require("./engine-fingerprint");

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
// and nothing enforces that. It is now DERIVED (audiod/engine-fingerprint.js). Every runtime .js in audiod/ is staged;
// only the test scripts are excluded, and they are excluded by a naming rule, not by omission. A vitest spec
// (`.test.js`, 2026-08-10) is excluded by suffix — the third time this list was wrong about a file.
// The daemon's runtime files also require a few of the app's own modules straight from ../electron/ — derived from the
// daemon's own `require("../electron/<module>")` calls (4.6.52 and earlier staged only the two sync files, so
// electron/audio-library-index.js was never staged and a moved song could not be found by name).
const daemonFiles = FP.daemonFiles;
const daemonElectronFiles = FP.daemonElectronFiles;
const RUNTIME_DATA = ["icudtl.dat", "v8_context_snapshot.bin", "snapshot_blob.bin"];
const MANIFEST = "stage-manifest.json";

function engineBaseDir() {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Ether", "engine");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Ether", "engine");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "Ether", "engine");
}
function targetPaths(dir) { return { exe: path.join(dir, "ether-engine.exe"), script: path.join(dir, "audiod", "ether-audiod.js") }; }

// An already-staged engine to spawn (no copying) — used by the watchdog, which respawns but
// shouldn't re-stage. Returns { exe, script } if a usable staged engine exists, else null.
function stagedTarget(baseDir) {
  if (process.platform !== "win32") return null;
  const t = targetPaths(baseDir || engineBaseDir());
  return (fs.existsSync(t.exe) && fs.existsSync(t.script)) ? t : null;
}

const isLockError = (e) => !!(e && (e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES"));

// Every file the stage is made of: { rel (inside the stage dir), src, big }. `big` files use the manifest's hash cache.
function stagePlan(srcRoot, unpacked) {
  const plan = [{ rel: "ether-engine.exe", src: path.join(srcRoot, "Ether.exe"), big: true }];
  for (const f of RUNTIME_DATA) { const s = path.join(srcRoot, f); if (fs.existsSync(s)) plan.push({ rel: f, src: s, big: true }); }
  const audiod = path.join(unpacked, "audiod");
  for (const f of daemonFiles(audiod)) plan.push({ rel: path.join("audiod", f), src: path.join(audiod, f), big: false });
  for (const rel of daemonElectronFiles(audiod)) plan.push({ rel: path.join("electron", rel), src: path.join(unpacked, "electron", rel), big: false, optional: true });
  plan.push({ rel: FP.NATIVE_REL, src: path.join(unpacked, FP.NATIVE_REL), big: false });
  const ffSrc = path.join(unpacked, "node_modules", "ffmpeg-static");     // whole pkg (index.js resolves the binary)
  const walk = (d, relBase) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const s = path.join(d, e.name), r = path.join(relBase, e.name);
      if (e.isDirectory()) walk(s, r); else if (e.isFile()) plan.push({ rel: r, src: s, big: true, optional: true });
    }
  };
  if (fs.existsSync(ffSrc)) { try { walk(ffSrc, path.join("node_modules", "ffmpeg-static")); } catch { /* unreadable ffmpeg — reuse */ } }
  return plan;
}

// sha256 of `p`, reusing `cached` ({size, mtimeMs, sha}) when allowed and the file's size + mtime still match it.
function hashOf(p, cached, allowCache) {
  let st; try { st = fs.statSync(p); } catch { return null; }
  if (allowCache && cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.sha) return { size: st.size, mtimeMs: st.mtimeMs, sha: cached.sha };
  const sha = FP.fileSha256(p);
  return sha ? { size: st.size, mtimeMs: st.mtimeMs, sha } : null;
}

// Remove <name>.old-<time> copies left by an in-use swap. One still held by a running engine fails and stays for later.
function sweepOldCopies(dir) {
  for (const d of [dir, path.join(dir, "native")]) {
    let names = []; try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) if (/\.old-\d+$/.test(n)) { try { fs.unlinkSync(path.join(d, n)); } catch { /* still in use */ } }
  }
}

/**
 * Stage (copy) the engine runtime + code to the external dir, file by file, by content. Returns
 * { exe, script, replaced, swapped, pending } to spawn, or null if unsupported/failed (caller falls back to the in-dir
 * engine — works, but dies on update).
 *   srcRoot  = dir holding Ether.exe + the runtime data files (dirname of process.execPath)
 *   unpacked = app.asar.unpacked root (holds audiod/, native/, electron/, node_modules/)
 *   version  = app version (written to version.txt for people; it decides nothing)
 *   log      = optional line logger (main passes the startup log)
 *   baseDir  = override the stage dir (tests; never the real one)
 *   copyFile = override fs.copyFileSync (tests)
 * replaced: files copied because the installed one differs; swapped: in-use files renamed aside and replaced (the running
 * daemon keeps the old one until it restarts); pending: in-use files that could not be replaced at all
 * [{rel, staged, installed}] — retried on the next stage.
 */
function stageEngine({ srcRoot, unpacked, version, log, baseDir, copyFile, platform } = {}) {
  if ((platform || process.platform) !== "win32") return null;
  const say = (m) => { try { console.log(m); } catch {} try { if (typeof log === "function") log(m); } catch {} };
  const cp1 = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); (copyFile || fs.copyFileSync)(src, dst); };
  const dir = baseDir || engineBaseDir();
  try {
    const t = targetPaths(dir);
    fs.mkdirSync(dir, { recursive: true });
    sweepOldCopies(dir);
    let manifest = {}; try { manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")) || {}; } catch { manifest = {}; }
    const mSrc = manifest.src || {}, mDst = manifest.dst || {};
    const next = { src: {}, dst: {} };
    const replaced = [], swapped = [], pending = [];

    for (const f of stagePlan(srcRoot, unpacked)) {
      const dst = path.join(dir, f.rel);
      const s = hashOf(f.src, mSrc[f.rel], f.big);
      if (!s) {
        if (f.optional) { if (f.rel.startsWith("electron")) console.error("[stage-engine] " + f.rel + " not in the install — the daemon's require of it will fail"); continue; }
        throw Object.assign(new Error("installed file missing: " + f.src), { code: "ENOENT" });
      }
      next.src[f.rel] = s;
      const d = hashOf(dst, mDst[f.rel], f.big);
      if (d && d.sha === s.sha) { next.dst[f.rel] = d; continue; }   // staged copy already IS the installed file

      try { cp1(f.src, dst); }
      catch (e) {
        if (!isLockError(e) || !d) throw e;
        // In use by a running engine. Rename it aside (the running process keeps it) and copy the installed one in.
        try { fs.renameSync(dst, dst + ".old-" + Date.now()); cp1(f.src, dst); swapped.push(f.rel); }
        catch {
          pending.push({ rel: f.rel, staged: d.sha, installed: s.sha });
          next.dst[f.rel] = d;
          say(`[stage-engine] ${f.rel} is IN USE by a running engine and could not be replaced — still the OLD file (staged ${d.sha.slice(0, 12)}, installed ${s.sha.slice(0, 12)}); retried on the next engine start`);
          continue;
        }
      }
      const nd = hashOf(dst, null, false);
      if (!nd || nd.sha !== s.sha) throw new Error(f.rel + ": copy did not produce the installed file");
      next.dst[f.rel] = nd;
      if (!swapped.includes(f.rel)) replaced.push(f.rel);
    }

    // A daemon .js that is no longer installed must not linger: the running daemon fingerprints its own audiod/ dir.
    const keep = new Set(daemonFiles(path.join(unpacked, "audiod")));
    try { for (const n of daemonFiles(path.join(dir, "audiod"))) if (!keep.has(n)) { try { fs.unlinkSync(path.join(dir, "audiod", n)); replaced.push(path.join("audiod", n) + " (removed)"); } catch {} } } catch {}

    if (!fs.existsSync(t.exe)) throw new Error("ether-engine.exe: source locked and no prior staged copy");
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(next));
    try { fs.writeFileSync(path.join(dir, "version.txt"), String(version || "")); } catch {}

    const fp = (rel) => (next.dst[rel] && next.dst[rel].sha ? next.dst[rel].sha.slice(0, 12) : "?");
    if (replaced.length || swapped.length) say(`[stage-engine] staged engine updated from the install (native ${fp(FP.NATIVE_REL)}): ${[...replaced, ...swapped.map(r => r + " (in use — renamed aside; the running engine keeps the old copy until it restarts)")].join(", ")}`);
    else if (!pending.length) say(`[stage-engine] staged engine matches the install (native ${fp(FP.NATIVE_REL)})`);
    return { ...t, replaced, swapped, pending };
  } catch (e) {
    say("[stage-engine] staging failed (" + e.code + "): " + e.message + " — falling back to the existing staged engine");
    // If staging failed because the exe is locked by a running engine, reuse what's staged.
    return stagedTarget(dir);
  }
}

// daemonFilesForVerify: the SAME derivation the stage uses, exposed so the release gate
// (audiod/verify-packaged.js) can assert every daemon require resolves to something that gets staged.
// Exported deliberately — the gate must check what staging actually does, not a copy of the rule.
module.exports = { stageEngine, stagedTarget, engineBaseDir, daemonFilesForVerify: daemonFiles, daemonElectronFilesForVerify: daemonElectronFiles };
