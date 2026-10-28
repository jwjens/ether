// THE ENGINE SOURCE FINGERPRINT — the release check (Jeff, 2026-10-28): "the installer's engine file must be built from the
// same commit as the app, and the build fails if native/ether-audio.node is older than the engine source."
//
// native/build.rs hashes the engine source (FNV-1a 64 over every file under native/src plus Cargo.toml, Cargo.lock and
// build.rs, sorted by path, "<path>\0<content without \r>\0" each) and compiles the number into the binary as
// "ETHER_ENGINE_SOURCE_FP:<16 hex>:END". This file computes the same number from the tree and reads the one in a binary
// without loading it (any platform, any CPU). They must be equal: an engine file built from older (or different) source
// than the app being packaged fails the build. A commit cannot contain its own id, so the SOURCE is compared, not the
// commit id — a binary built from the source in this commit is exactly "built from the same commit".
"use strict";
const fs = require("fs");
const path = require("path");

const MARK = "ETHER_ENGINE_SOURCE_FP:";

function walk(dir, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/** The fingerprint of the engine source under `nativeDir` (16 hex digits), as native/build.rs computes it. */
function sourceFingerprint(nativeDir) {
  const list = walk(path.join(nativeDir, "src"), []).map(p => [path.relative(nativeDir, p).split(path.sep).join("/"), p]);
  for (const [name, cands] of [["Cargo.toml", ["Cargo.toml", "cargo.toml"]], ["Cargo.lock", ["Cargo.lock"]], ["build.rs", ["build.rs"]]]) {
    const hit = cands.map(c => path.join(nativeDir, c)).find(p => fs.existsSync(p));
    if (hit) list.push([name, hit]);
  }
  list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let h = 0xcbf29ce484222325n;
  const feed = (buf) => { for (const x of buf) { h ^= BigInt(x); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; } };
  for (const [rel, p] of list) {
    feed(Buffer.from(rel, "utf8")); feed([0]);
    feed(fs.readFileSync(p).filter(b => b !== 0x0d)); feed([0]);
  }
  return h.toString(16).padStart(16, "0");
}

/** The fingerprint compiled into an engine binary, or null if it has none (built before this check existed). */
function binaryFingerprint(file) {
  const buf = fs.readFileSync(file);
  const at = buf.indexOf(MARK);
  if (at < 0) return null;
  const hex = buf.slice(at + MARK.length, at + MARK.length + 16).toString("latin1");
  return /^[0-9a-f]{16}$/.test(hex) && buf.slice(at + MARK.length + 16, at + MARK.length + 20).toString("latin1") === ":END" ? hex : null;
}

/** Throws unless `file` was built from the engine source in `nativeDir`. Returns the fingerprint. */
function assertEngineMatchesSource(file, nativeDir, what = path.basename(file)) {
  const want = sourceFingerprint(nativeDir);
  const got = binaryFingerprint(file);
  if (got !== want) {
    throw new Error(`[engine-source] ${what} was NOT built from the engine source being packaged.\n` +
      `  engine file: ${got ? `built from source ${got}` : "carries no source fingerprint (built before this check, so older than the source)"}\n` +
      `  engine source in this tree: ${want}\n` +
      `  rebuild it: node scripts/cargo-native.js build --release, then copy native/target/release/ether_audio.dll to native/ether-audio.node (Windows)`);
  }
  return got;
}

module.exports = { MARK, sourceFingerprint, binaryFingerprint, assertEngineMatchesSource };
