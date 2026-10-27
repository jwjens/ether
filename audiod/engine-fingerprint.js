// audiod/engine-fingerprint.js — what an audio engine IS, by content (2026-10-10).
//
// docs/monitor-failed-test-diagnosis-2026-10-10.md: the MONITOR fix was installed-and-tested as "4.6.59", the stage
// marker already said "4.6.59", so stage-engine.js reused the staged copy and the daemon ran the PRE-FIX
// ether-audio.node. A version string names a release, not a build. This names the bytes.
//
// One derivation, used by every side that has to agree:
//   · stage-engine.js — what to copy (installed vs staged, file by file);
//   · ether-audiod.js — what the running daemon actually loaded (the `engine` command);
//   · main            — what is installed, to compare with the running daemon (Health Monitor).
// Pure fs + crypto, no Electron: it is staged beside the daemon and runs there.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** sha256 hex of a file, streamed in chunks (the runtime exe is ~240 MB). null if unreadable. */
function fileSha256(p) {
  let fd;
  try {
    fd = fs.openSync(p, "r");
    const h = crypto.createHash("sha256");
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    return h.digest("hex");
  } catch { return null; }
  finally { if (fd != null) { try { fs.closeSync(fd); } catch {} } }
}

// The daemon's runtime .js — every .js in audiod/ except the test scripts, by naming rule (stage-engine.js header has
// the history of why this is derived and never a hand-kept list).
const isTestScript = (n) => /^(smoke|accept|verify)-/.test(n) || /\.(test|spec)\.js$/.test(n);
const isDaemonRuntimeFile = (n) => n.endsWith(".js") && !isTestScript(n);
function daemonFiles(audiodDir) {
  return fs.readdirSync(audiodDir, { withFileTypes: true })
    .filter(e => e.isFile() && isDaemonRuntimeFile(e.name))
    .map(e => e.name)
    .sort();
}
// The app files the daemon loads from outside audiod/ — TRANSITIVELY (2026-10-27, 4.6.66). This used to read only the
// daemon's own direct requires of ../electron/ modules, and staging copied only what the install had unpacked: 4.6.66's
// engine.js required ../electron/catalogue, which was never unpacked, the stage skipped it, and every song read as
// unplayable on OV (docs/engine-missing-catalogue-4.6.66-2026-10-27.md). Now every relative require is followed into
// the files it reaches (electron/catalogue.js → ./audio-library-index; mutation-writer → handlers/asset-mirror →
// library_asset → ../../asset-types → ../shared/asset-types.json), string literals and path.join(__dirname, …) alike.
// Paths are relative to the engine root (the dir holding audiod/); native/*.node and node_modules are staged on their own.
// A file that is required but not there is still LISTED, so staging and packaging fail on it by name.
// The two sync files are required by path.join with a variable (audiod/playlog.js), so they are seeded.
const DAEMON_SYNC_FILES = ["electron/sync/mutation-writer.js", "electron/sync/synced-tables.js"];
const REL_REQUIRE = /require\(\s*(?:["'](\.{1,2}\/[A-Za-z0-9_./-]+)["']|path\.join\(\s*__dirname\s*((?:\s*,\s*["'][A-Za-z0-9_.-]+["'])+)\s*\))\s*\)/g;
function relRequires(src) {
  const out = [];
  for (const m of src.matchAll(REL_REQUIRE)) {
    if (m[1]) out.push(m[1]);
    else out.push("./" + [...m[2].matchAll(/["']([^"']+)["']/g)].map(x => x[1]).join("/"));
  }
  return out;
}
function resolveRel(root, fromAbs, rel) {
  let t = path.resolve(path.dirname(fromAbs), rel);
  if (!/\.(js|json|node)$/.test(t)) t += ".js";
  return path.relative(root, t).split(path.sep).join("/");
}
function daemonAppFiles(audiodDir) {
  const root = path.dirname(audiodDir);
  const found = new Set(DAEMON_SYNC_FILES);
  const queue = [...DAEMON_SYNC_FILES];
  const scan = (abs) => {
    let src; try { src = fs.readFileSync(abs, "utf8"); } catch { return; }
    for (const rel of relRequires(src)) {
      const r = resolveRel(root, abs, rel);
      if (r.startsWith("..") || r.startsWith("audiod/") || r.startsWith("native/") || r.includes("node_modules/") || found.has(r)) continue;
      found.add(r); if (r.endsWith(".js")) queue.push(r);
    }
  };
  for (const f of daemonFiles(audiodDir)) scan(path.join(audiodDir, f));
  while (queue.length) scan(path.join(root, queue.shift()));
  return [...found].sort();
}
// Back-compat view for callers that name files relative to electron/ (audiod/verify-packaged.js).
function daemonElectronFiles(audiodDir) {
  return daemonAppFiles(audiodDir).filter(r => r.startsWith("electron/")).map(r => r.slice("electron/".length));
}

const NATIVE_REL = path.join("native", "ether-audio.node");

/**
 * The engine at `root` (a dir holding audiod/, native/, electron/ — the install's app.asar.unpacked, or the staged
 * engine dir). `native` is the sha256 of ether-audio.node; `code` is one sha256 over every daemon runtime file and
 * every electron/ module it requires, in a fixed order. null for a part that cannot be read.
 */
function engineFingerprint(root) {
  const native = fileSha256(path.join(root, NATIVE_REL));
  let code = null;
  try {
    const audiod = path.join(root, "audiod");
    const lines = [];
    for (const f of daemonFiles(audiod)) lines.push("audiod/" + f + " " + (fileSha256(path.join(audiod, f)) || "missing"));
    for (const rel of daemonAppFiles(audiod)) lines.push(rel + " " + (fileSha256(path.join(root, rel)) || "missing"));
    code = crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
  } catch { code = null; }
  return { native, code };
}

module.exports = { fileSha256, engineFingerprint, daemonFiles, daemonAppFiles, daemonElectronFiles, isTestScript, isDaemonRuntimeFile, NATIVE_REL };
