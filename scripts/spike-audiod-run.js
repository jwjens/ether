// Phase 0 run spike (Item 10): does the engine, in BARE Node, actually open the audio
// device, decode + mix a local file, report real levels, and stand up the program-bus
// (stream source) — all with no Electron? This is the last empirical gate before Phase 1.
//
// It OPENS THE AUDIO DEVICE and PLAYS SOUND for ~3s. Gated behind --i-am-off-air so it
// can't fire on a live station by accident. Uses a throwaway station id (99) so it never
// touches OV's station-1 engine. File path via env ETHER_SPIKE_FILE.
if (!process.argv.includes("--i-am-off-air")) {
  console.error("Refusing to run: this opens the audio device and plays sound. Pass --i-am-off-air.");
  process.exit(2);
}
const path = require("path");
const file = process.env.ETHER_SPIKE_FILE;
if (!file) { console.error("Set ETHER_SPIKE_FILE to a local audio file path."); process.exit(2); }

const addon = require(path.join(__dirname, "..", "native", "ether-audio.node"));
const SID = 99; // throwaway station — isolated from OV (station 1)
console.log("bare node", process.version, "| station", SID, "| file:", file);

addon.initAudioEngine(SID);
addon.audioSetVolume("A", 0.4, SID);
addon.audioLoad("A", file, "Spike Test", "", 0, SID);
addon.audioPlay("A", SID);

let port = "n/a";
try { port = addon.audioGetProgramBusPort(SID); } catch (e) { port = "ERR:" + e.message; }
console.log("program-bus TCP port (stream source):", port, "\n");

let t = 0;
const timer = setInterval(() => {
  let st = {}, lv = {};
  try { st = JSON.parse(addon.audioGetState(SID)); } catch {}
  try { lv = JSON.parse(addon.audioGetLevels(SID)); } catch {}
  const a = st.deckA || {};
  console.log(`t=${(t * 0.5).toFixed(1)}s  deckA=${a.status}  pos=${(a.position_sec ?? a.positionSec ?? 0).toFixed ? (a.position_sec ?? 0).toFixed(1) : a.position_sec}s  levelA=${(lv.a ?? 0).toFixed(3)}  master=${(lv.master ?? 0).toFixed(3)}`);
  if (++t >= 6) {
    clearInterval(timer);
    addon.audioStop("A", SID);
    const played = (st.deckA && (st.deckA.status === "playing")) ;
    const heard = (lv.a ?? 0) > 0.001;
    console.log("\nSTOPPED.");
    console.log("VERDICT: cpal device opened + file decoded/played from bare Node:", played ? "YES ✅" : "check status");
    console.log("         real levels reported:", heard ? "YES ✅" : "no signal (check volume/file)");
    console.log("         program-bus stream source up:", typeof port === "number" ? "YES ✅ (port " + port + ")" : String(port));
    setTimeout(() => process.exit(0), 400);
  }
}, 500);
