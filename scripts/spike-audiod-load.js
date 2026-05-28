// Phase 0 spike (Item 10 — out-of-process audio engine): can the N-API audio addon load
// and expose its full API in a BARE Node process (no Electron)? This is the #1 de-risk —
// it decides whether the daemon can be standalone Node or must run under Electron's node.
//
// SAFE to run on a live on-air machine: this ONLY require()s the addon and inspects its
// exports. It does NOT call init_audio_engine, so it opens no audio device, makes no
// sound, and touches no Icecast stream. Run with BARE system node:
//   node scripts/spike-audiod-load.js
const path = require("path");
const addonPath = path.join(__dirname, "..", "native", "ether-audio.node");

console.log("Runtime : bare node", process.version, "|", process.platform, process.arch);
console.log("Addon   :", addonPath);
console.log("NODE_MODULE_VERSION:", process.versions.modules, "| napi:", process.versions.napi || "(N-API ABI-stable)");

let addon;
try {
  addon = require(addonPath);
} catch (e) {
  console.error("\nLOAD FAILED ❌:", e.message);
  console.error("→ The addon did NOT load in bare node. If this is an ABI/NODE_MODULE_VERSION");
  console.error("  error, it's a V8/NAN module (not pure N-API) and the daemon must run under");
  console.error("  Electron's node (ELECTRON_RUN_AS_NODE) or ship a node-version-matched rebuild.");
  process.exit(1);
}

const fns = Object.keys(addon).sort();
console.log("\nLOADED OK ✅ — " + fns.length + " exports:");
for (const f of fns) console.log("  " + f + " : " + typeof addon[f]);

const core = ["initAudioEngine", "audioLoad", "audioPlay", "audioPause", "audioStop",
  "audioGetState", "audioGetLevels", "audioSetBroadcastDelay", "audioDump", "getFileDuration"];
const missing = core.filter((n) => typeof addon[n] !== "function");
console.log("\nCore engine API present:", missing.length === 0 ? `YES — all ${core.length} ✅` : "MISSING ❌: " + missing.join(", "));
console.log(missing.length === 0
  ? "\n→ VERDICT: a bare Node process CAN host this engine. ether-audiod is viable as standalone Node + this addon (no Electron needed to load it)."
  : "\n→ VERDICT: some core functions are absent — re-check the addon build/exports.");
