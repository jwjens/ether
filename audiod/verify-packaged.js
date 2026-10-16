// Verifies the PACKAGED daemon loads in the built artifact: spawns
// dist-electron/win-unpacked/resources/app.asar.unpacked/audiod/ether-audiod.js under the
// freshly-built Ether.exe (ELECTRON_RUN_AS_NODE) and pings it. A successful ping means every
// require chain resolved in the package — engine→loggen/playlog→electron/sync/mutation-writer
// →synced-tables, stream→ffmpeg-static, and the native addon — i.e. the asarUnpack config is
// correct and the daemon will actually run for users (not silently fall back). No audio.
//   node audiod/verify-packaged.js
//
// macOS (2026-09-30): the same check against dist-electron/mac-arm64 (or mac/ for x64) — the packaged
// Contents/MacOS/Ether runs the packaged daemon over a Unix socket. 4.6.52 shipped a Mac whose daemon died on
// MODULE_NOT_FOUND (no engine in app.asar.unpacked/native); this is the runtime receipt that it can't again.
const net = require("net"), path = require("path"), fs = require("fs"), cp = require("child_process"), os = require("os");
const MAC = process.platform === "darwin";
const ROOT = MAC
  ? path.join(__dirname, "..", "dist-electron", process.arch === "arm64" ? "mac-arm64" : "mac", "Ether.app", "Contents")
  : path.join(__dirname, "..", "dist-electron", "win-unpacked");
const EXE = MAC ? path.join(ROOT, "MacOS", "Ether") : path.join(ROOT, "Ether.exe");
const DAEMON = path.join(ROOT, MAC ? "Resources" : "resources", "app.asar.unpacked", "audiod", "ether-audiod.js");
const PIPE = MAC
  ? path.join(os.tmpdir(), "ether-audiod-pkgverify-" + process.pid + ".sock")
  : "\\\\.\\pipe\\ether-audiod-pkgverify-" + process.pid;

for (const p of [EXE, DAEMON]) if (!fs.existsSync(p)) { console.error("missing:", p); process.exit(1); }
// Windows: the HA auto-logon helper ships beside app.asar — every CI installer through 4.6.57 lacked it
// (docs/ha-setup-installer-check-2026-10-05.md). The afterPack hook throws first in a real build; this repeats it here.
const HA_HELPER = path.join(ROOT, "resources", "ha-setup.exe");
if (!MAC && !fs.existsSync(HA_HELPER)) { console.error("missing:", HA_HELPER, "— build native/ha-setup (cargo build --release)"); process.exit(1); }
// A private DB path and log: a release gate must never open or append to the installed station's files.
const GATE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ether-pkgverify-"));
const daemon = cp.spawn(EXE, [DAEMON], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ETHER_AUDIOD_PIPE: PIPE,
  ETHER_DB_PATH: path.join(GATE_TMP, "openair.db"), ETHER_AUDIOD_LOG: path.join(GATE_TMP, "ether-audiod.log") }, stdio: "ignore" });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ping() { return new Promise((res) => { const s = net.connect(PIPE); let done = false; const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} res(v); }; s.once("connect", () => { s.write(JSON.stringify({ id: 1, cmd: "ping" }) + "\n"); }); s.on("data", (d) => { fin(d.toString().includes("pong")); }); s.once("error", () => fin(false)); setTimeout(() => fin(false), 1200); }); }

// A GATE FAILURE NAMES ITSELF (Jeff, 2026-10-15). ecf38bbf's gate failed once with engine identity "(none)" and could
// not say why: a timeout, a socket error, a refusal and an unreadable line all came back as the same null. Now the answer
// is the line carrying OUR id (an event broadcast to every client is skipped, never mistaken for it), and a miss says
// which of the four it was. docs/announcement-airing-visible-2026-10-15.md §Release gate.
const ASK_TIMEOUT_MS = 3000;
function ask(cmd) {
  return new Promise((res) => {
    const s = net.connect(PIPE); let buf = "", done = false, skipped = 0;
    const fin = (result, why) => { if (done) return; done = true; try { s.destroy(); } catch {} res({ result, why }); };
    s.once("connect", () => { s.write(JSON.stringify({ id: 7, cmd }) + "\n"); });
    s.on("data", (d) => {
      buf += d.toString(); let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let m; try { m = JSON.parse(line); } catch { return fin(null, `an unreadable line came back: ${line.slice(0, 120)}`); }
        if (!m || m.id !== 7) { skipped++; continue; }   // an event, not our answer
        return m.ok ? fin(m.result, null) : fin(null, `the daemon refused "${cmd}": ${m.error || "no reason given"}`);
      }
    });
    s.once("error", (e) => fin(null, `socket error: ${e && e.message || e}`));
    setTimeout(() => fin(null, `no answer within ${ASK_TIMEOUT_MS / 1000} s${skipped ? ` (${skipped} event line(s) arrived instead)` : ""}`), ASK_TIMEOUT_MS);
  });
}
// Up to 3 tries, 1 s apart. A retry can only cover a slow moment: the identity must still match the package by sha256.
const ENGINE_ASK_TRIES = 3;
async function askEngine() {
  const tries = [];
  for (let i = 1; i <= ENGINE_ASK_TRIES; i++) {
    const t0 = Date.now();
    const r = await ask("engine");
    tries.push(r.why ? `try ${i}: FAILED after ${Date.now() - t0} ms: ${r.why}` : `try ${i}: answered in ${Date.now() - t0} ms`);
    if (!r.why) return { eng: r.result, tries };
    if (i < ENGINE_ASK_TRIES) await sleep(1000);
  }
  return { eng: null, tries };
}

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
  // ENGINE IDENTITY (2026-10-10): the packaged daemon must report, by sha256, the engine it loaded — and it must be the
  // packaged one. That report is what main compares with the install to raise daemon-engine-mismatch-error.
  const asked = ok ? await askEngine() : { eng: null, tries: ["not asked: the daemon never answered ping"] };
  const eng = asked.eng;
  try { daemon.kill(); } catch {}
  console.log("packaged daemon spawned under: " + path.basename(EXE));
  console.log("packaged daemon answered ping: " + ok);
  try {
    const lines = fs.readFileSync(path.join(GATE_TMP, "ether-audiod.log"), "utf8").trim().split("\n");
    console.log("packaged daemon log (last 6 lines):\n   " + lines.slice(-6).join("\n   "));
  } catch { console.log("packaged daemon log: (none written)"); }
  console.log("\n→ PACKAGING: " + (ok
    ? "✅ the shipped daemon loads + runs — all require chains resolved in app.asar.unpacked (feature works for users, not a silent fallback)"
    : "❌ packaged daemon did not respond — a require/path is wrong in the package (would silently fall back to in-process)"));

  const st = checkStaging();
  // The app modules the daemon requires from ../electron/ — each must be IN the package's app.asar.unpacked, or
  // stage-engine cannot copy it and the staged daemon's require of it fails (audio-library-index.js, 4.6.52).
  const stage = require(path.join(__dirname, "stage-engine.js"));
  const elec = typeof stage.daemonElectronFilesForVerify === "function" ? stage.daemonElectronFilesForVerify(__dirname) : [];
  const unpackedElectron = path.join(ROOT, MAC ? "Resources" : "resources", "app.asar.unpacked", "electron");
  const elecMissing = elec.filter(rel => !fs.existsSync(path.join(unpackedElectron, rel)));
  console.log(`\nstaged app modules (electron/): ${elec.join(", ") || "(none derived)"}`);
  for (const m of elecMissing) console.log(`   ✗ electron/${m} is required by the daemon but NOT in app.asar.unpacked — add it to asarUnpack`);
  const elecOk = elec.length > 0 && elecMissing.length === 0;
  console.log("→ APP MODULES: " + (elecOk
    ? "✅ every ../electron/ module the daemon requires is in app.asar.unpacked and staged beside it"
    : "❌ a module the daemon requires would not be staged — its require fails in the staged daemon"));
  console.log(`\nstaging: walked ${st.count || 0} daemon file(s) against ${st.staged || 0} staged file(s)`);
  if (st.missing && st.missing.length) for (const m of st.missing) console.log("   ✗ " + m);
  console.log("→ STAGING: " + (st.ok
    ? "✅ every relative require in the daemon resolves to a file stage-engine copies to %LOCALAPPDATA%\\Ether\\engine"
    : `❌ ${st.why || "a daemon require points at a file that is NOT staged"} — the staged daemon would die on MODULE_NOT_FOUND and every station would fall back to in-process`));

  const pkgFp = require(path.join(__dirname, "engine-fingerprint.js")).engineFingerprint(path.join(ROOT, MAC ? "Resources" : "resources", "app.asar.unpacked"));
  const engOk = !!(eng && pkgFp.native && eng.native === pkgFp.native && pkgFp.code && eng.code === pkgFp.code);
  console.log(`\nengine identity: daemon reports native ${eng && eng.native || "(none)"} code ${eng && eng.code || "(none)"}`);
  console.log(`                 package holds  native ${pkgFp.native || "(none)"} code ${pkgFp.code || "(none)"}`);
  for (const t of asked.tries) console.log("                 " + t);
  console.log("→ ENGINE IDENTITY: " + (engOk
    ? "✅ the packaged daemon reports the packaged engine by sha256 (what the Health Monitor engine-match check reads)"
    : (eng ? "❌ the packaged daemon reports a DIFFERENT engine than the package holds"
           : "❌ the packaged daemon did not report its engine (see the tries above) — the engine-match check would be blind")));

  const pass = ok && st.ok && elecOk && engOk;
  // THE DAEMON'S LOG IS KEPT beside the build, every run, so a failure can be read afterwards (the gate's temp folder
  // is otherwise lost). dist-electron/gate-logs/<time> <PASS|FAIL>.log, plus this run's tries.
  try {
    const dir = path.join(__dirname, "..", "dist-electron", "gate-logs");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = path.join(dir, `${stamp} ${pass ? "PASS" : "FAIL"}.log`);
    let dlog = ""; try { dlog = fs.readFileSync(path.join(GATE_TMP, "ether-audiod.log"), "utf8"); } catch { dlog = "(the daemon wrote no log)\n"; }
    fs.writeFileSync(out, `release gate ${pass ? "PASS" : "FAIL"} ${new Date().toISOString()}\nping: ${ok}\n${asked.tries.join("\n")}\n` +
      `daemon reports native ${eng && eng.native || "(none)"} code ${eng && eng.code || "(none)"}\npackage holds  native ${pkgFp.native || "(none)"} code ${pkgFp.code || "(none)"}\n\n--- daemon log ---\n${dlog}`);
    console.log("\ndaemon log saved: " + out);
  } catch (e) { console.log("\ndaemon log NOT saved: " + (e && e.message)); }
  console.log(`\n${pass ? "✅ RELEASE GATE PASS" : "❌ RELEASE GATE FAIL"}`);
  setTimeout(() => process.exit(pass ? 0 : 1), 200);
})();
