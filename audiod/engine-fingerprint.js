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
// The app modules the daemon requires from ../electron/, derived from its own require() calls. The two sync files are
// required by path.join (audiod/playlog.js), so they are named.
const DAEMON_SYNC_FILES = ["sync/mutation-writer.js", "sync/synced-tables.js"];
function daemonElectronFiles(audiodDir) {
  const out = new Set(DAEMON_SYNC_FILES);
  for (const f of daemonFiles(audiodDir)) {
    let src; try { src = fs.readFileSync(path.join(audiodDir, f), "utf8"); } catch { continue; }
    for (const m of src.matchAll(/require\(\s*["']\.\.\/electron\/([A-Za-z0-9_./-]+?)(?:\.js)?["']\s*\)/g)) out.add(m[1] + ".js");
  }
  return [...out].sort();
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
    for (const rel of daemonElectronFiles(audiod)) lines.push("electron/" + rel + " " + (fileSha256(path.join(root, "electron", rel)) || "missing"));
    code = crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
  } catch { code = null; }
  return { native, code };
}

module.exports = { fileSha256, engineFingerprint, daemonFiles, daemonElectronFiles, isTestScript, isDaemonRuntimeFile, NATIVE_REL };
