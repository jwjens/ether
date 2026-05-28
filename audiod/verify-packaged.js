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

(async () => {
  let ok = false;
  for (let i = 0; i < 25 && !ok; i++) { ok = await ping(); if (!ok) await sleep(300); }
  try { daemon.kill(); } catch {}
  console.log("packaged daemon spawned under: " + path.basename(EXE));
  console.log("packaged daemon answered ping: " + ok);
  console.log("\n→ PACKAGING: " + (ok
    ? "✅ the shipped daemon loads + runs — all require chains resolved in app.asar.unpacked (feature works for users, not a silent fallback)"
    : "❌ packaged daemon did not respond — a require/path is wrong in the package (would silently fall back to in-process)"));
  setTimeout(() => process.exit(ok ? 0 : 1), 200);
})();
