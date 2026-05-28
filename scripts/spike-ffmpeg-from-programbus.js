// Item 10 Phase 2 Step 5 spike. Proves the daemon's runtime (bare node / ELECTRON_RUN_AS_NODE,
// same as ether-audiod) can spawn ffmpeg-static and pipe the addon's PROGRAM BUS through it —
// the encode path that must move into the daemon for the stream to survive a UI restart.
//
// Mirrors the app's encoder args (electron/main.js:4123) but writes a local .mp3 instead of an
// Icecast URL: the program-bus → ffmpeg → mp3 pipeline is the only unproven piece (the Rust
// StartStream is a stub; the Icecast network hop is just an output-URL swap already proven live).
//
// Plays audio → gated. Throwaway station 99.
//   ETHER_SPIKE_FILE="...mp3" node scripts/spike-ffmpeg-from-programbus.js --i-am-off-air
const path = require("path"), os = require("os"), fs = require("fs"), cp = require("child_process");

if (!process.argv.includes("--i-am-off-air")) { console.error("Plays audio — pass --i-am-off-air."); process.exit(2); }
const file = process.env.ETHER_SPIKE_FILE;
if (!file) { console.error("Set ETHER_SPIKE_FILE to a local audio file."); process.exit(2); }
const SID = 99;

const A = require(path.join(__dirname, "..", "native", "ether-audio.node"));
const ffmpeg = require("ffmpeg-static");
console.log("ffmpeg-static:", ffmpeg, "| exists:", fs.existsSync(ffmpeg));
if (!ffmpeg || !fs.existsSync(ffmpeg)) { console.error("ffmpeg-static binary missing"); process.exit(1); }

const out = path.join(os.tmpdir(), "ether-spike-stream-" + Date.now() + ".mp3");

A.initAudioEngine(SID);
A.audioSetVolume("A", 0.8, SID);
A.audioLoad("A", file, "Stream Spike", "", 0, SID);
A.audioPlay("A", SID);

// Wait for the program-bus TCP listener to come up (drain starts when ffmpeg connects).
let port = 0, tries = 0;
const waitPort = setInterval(() => {
  port = A.audioGetProgramBusPort(SID);
  if (port > 0 || ++tries > 30) {
    clearInterval(waitPort);
    if (!port) { console.error("no program-bus port after 3s"); A.audioStop("A", SID); process.exit(1); }
    startEncode();
  }
}, 100);

function startEncode() {
  console.log("program-bus port:", port, "→ encoding to", out);
  // `-t 6` limits OUTPUT to 6s so ffmpeg exits ON ITS OWN and flushes the file cleanly
  // (Windows proc.kill() is a hard TerminateProcess → no flush → 0-byte file). This is the
  // graceful stop the daemon's stream supervisor will use too (or stdin 'q').
  const args = [
    "-f", "f32le", "-ar", "44100", "-ac", "2",
    "-i", `tcp://127.0.0.1:${port}`,
    "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3",
    "-t", "6", "-y", out,
  ];
  const proc = cp.spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
  let ff = "";
  proc.stderr.on("data", d => ff += d.toString());
  proc.on("error", e => { console.error("ffmpeg spawn error:", e.message); A.audioStop("A", SID); process.exit(1); });
  const guard = setTimeout(() => { try { proc.kill(); } catch {} }, 15000); // safety if -t never fires

  proc.on("close", () => {
    clearTimeout(guard);
    A.audioStop("A", SID);
    let size = 0; try { size = fs.statSync(out).size; } catch {}
    // mp3 frame sync (0xFFEx) or ID3 tag at the head = real encoded audio
    let sync = false;
    try { const h = fs.readFileSync(out).subarray(0, 256); for (let i = 0; i < h.length - 1; i++) { if (h[i] === 0xFF && (h[i + 1] & 0xE0) === 0xE0) { sync = true; break; } } if (h.subarray(0, 3).toString() === "ID3") sync = true; } catch {}
    const sizes = [...ff.matchAll(/size=\s*([0-9]+)kB/g)]; const last = sizes.length ? sizes[sizes.length - 1][0] : "(no size line)";
    console.log("ffmpeg final progress:", last);
    console.log("output mp3:", size, "bytes | mp3 frame sync present:", sync);
    try { fs.unlinkSync(out); } catch {}
    const ok = size > 10000 && sync;
    console.log("\n→ STEP 5 VERDICT: " + (ok
      ? "✅ daemon runtime spawns ffmpeg-static and encodes the program bus (" + size + " bytes of valid mp3). Streaming can move into the daemon."
      : "❌ no/invalid mp3 — check ffmpeg stderr below:\n" + ff.slice(-600)));
    process.exit(ok ? 0 : 1);
  });
}
