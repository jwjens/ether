// Verifies the PACKAGED daemon loads in the built artifact: spawns
// dist-electron/win-unpacked/resources/app.asar.unpacked/audiod/ether-audiod.js under the
// freshly-built Ether.exe (ELECTRON_RUN_AS_NODE) and pings it. A successful ping means every
// require chain resolved in the package — engine→loggen/playlog→electron/sync/mutation-writer
// →synced-tables, stream→ffmpeg-static, and the native addon — i.e. the asarUnpack config is
// correct and the daemon will actually run for users (not silently fall back). No audio.
//   node audiod/verify-packaged.js
const net = require("net"), path = require("path"), fs = require("fs"), cp = require("child_process");
const ROOT = path.join(__dirname, "..", "dist-electron", "win-unpacked");
const EXE = path.join(ROOT, "Ether.exe");
const DAEMON = path.join(ROOT, "resources", "app.asar.unpacked", "audiod", "ether-audiod.js");
const PIPE = "\\\\.\\pipe\\ether-audiod-pkgverify-" + process.pid;

for (const p of [EXE, DAEMON]) if (!fs.existsSync(p)) { console.error("missing:", p); process.exit(1); }
const daemon = cp.spawn(EXE, [DAEMON], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ETHER_AUDIOD_PIPE: PIPE }, stdio: "ignore" });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ping() { return new Promise((res) => { const s = net.connect(PIPE); let done = false; const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} res(v); }; s.once("connect", () => { s.write(JSON.stringify({ id: 1, cmd: "ping" }) + "\n"); }); s.on("data", (d) => { fin(d.toString().includes("pong")); }); s.once("error", () => fin(false)); setTimeout(() => fin(false), 1200); }); }

// ── STAGING CHECK (added 2026-07-30) ──────────────────────────────────────────────────────────────
// The ping above proves the PACKAGE is right. It is not enough, and 4.4.114 proved it: the package was
// perfect and this script passed, but the daemon does not run from the package — stage-engine.js copies
// it to %LOCALAPPDATA%\Ether\engine\audiod and runs it from there. autofit.js was in the package and
// absent from the stage, so the daemon died on require('./autofit') and every station fell back to
// in-process, silent-while-playing.
//
// So: statically resolve every relative require() in the daemon's runtime files and assert each target
// is a file stage-engine WOULD copy. Pure and fast — no spawn, no staging — and it fails the release
// rather than the station.
function checkStaging() {
  const SRC = path.join(__dirname);
  const stage = require(path.join(__dirname, "stage-engine.js"));
  const staged = new Set(
    (typeof stage.daemonFilesForVerify === "function" ? stage.daemonFilesForVerify(SRC) : [])
  );
  if (!staged.size) return { ok: false, why: "stage-engine did not expose its file set — cannot verify" };

  // Walk the require graph from the daemon entrypoint over RELATIVE requires only.
  const seen = new Set(), missing = [];
  const walk = (file) => {
    const name = path.basename(file);
    if (seen.has(name)) return;
    seen.add(name);
    let src; try { src = fs.readFileSync(path.join(SRC, name), "utf8"); } catch { return; }
    for (const m of src.matchAll(/require\(\s*["']\.\/([A-Za-z0-9_.-]+?)(?:\.js)?["']\s*\)/g)) {
      const dep = m[1] + ".js";
      if (!staged.has(dep)) missing.push(`${name} → ./${m[1]}  (NOT staged)`);
      walk(dep);
    }
  };
  walk("ether-audiod.js");
  return { ok: missing.length === 0, missing, count: seen.size, staged: staged.size };
}

(async () => {
  let ok = false;
  for (let i = 0; i < 25 && !ok; i++) { ok = await ping(); if (!ok) await sleep(300); }
  try { daemon.kill(); } catch {}
  console.log("packaged daemon spawned under: " + path.basename(EXE));
  console.log("packaged daemon answered ping: " + ok);
  console.log("\n→ PACKAGING: " + (ok
    ? "✅ the shipped daemon loads + runs — all require chains resolved in app.asar.unpacked (feature works for users, not a silent fallback)"
    : "❌ packaged daemon did not respond — a require/path is wrong in the package (would silently fall back to in-process)"));

  const st = checkStaging();
  console.log(`\nstaging: walked ${st.count || 0} daemon file(s) against ${st.staged || 0} staged file(s)`);
  if (st.missing && st.missing.length) for (const m of st.missing) console.log("   ✗ " + m);
  console.log("→ STAGING: " + (st.ok
    ? "✅ every relative require in the daemon resolves to a file stage-engine copies to %LOCALAPPDATA%\\Ether\\engine"
    : `❌ ${st.why || "a daemon require points at a file that is NOT staged"} — the staged daemon would die on MODULE_NOT_FOUND and every station would fall back to in-process`));

  const pass = ok && st.ok;
  console.log(`\n${pass ? "✅ RELEASE GATE PASS" : "❌ RELEASE GATE FAIL"}`);
  setTimeout(() => process.exit(pass ? 0 : 1), 200);
})();
