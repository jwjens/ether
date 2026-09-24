// DSP PARITY HARNESS — the NAPI side. Renders through a BUILT ether-audio.node (the repo copy, a fresh
// native/target/release/ether_audio.dll copied to a .node, or the one inside dist-electron/win-unpacked)
// and checks the result against native/goldens/manifest.json. This is what proves the harness runs
// against the shipped artifact and not only inside `cargo test`. docs/dsp-parity-harness.md.
//
//   node scripts/diag-render-offline.js <ether-audio.node> [render-id ...]
//
// With no render ids it renders every render in the manifest. Each render is written to a temp dir,
// hashed by the addon, and compared to the manifest hash (bit-exact) — the manifest hashes come from
// `cargo test`, so a match here is ALSO the cross-build determinism receipt (test binary vs .node).
// Never opens an audio device; safe to run while nothing is airing on this box, and it never touches
// a station's engine in any case.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const nodePath = process.argv[2];
if (!nodePath) { console.error("usage: node scripts/diag-render-offline.js <ether-audio.node> [render-id ...]"); process.exit(2); }
const A = require(path.resolve(nodePath));
if (typeof A.audioRenderOffline !== "function") { console.error("this .node has no audioRenderOffline — built before the harness"); process.exit(2); }

const root = path.join(__dirname, "..", "native", "goldens");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const ids = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(manifest.renders);
const inputFor = (id) => path.join(root, "inputs", manifest.inputs[id.split("__")[0]].file);

let fails = 0;
for (const id of ids) {
  const g = manifest.renders[id];
  if (!g) { console.log(`[napi] ${id}: not in manifest`); fails++; continue; }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ether-render-"));
  const t0 = Date.now();
  // An aux deck is stored by file name; resolve it against the same inputs folder.
  const cfg = JSON.parse(JSON.stringify(g.cfg));
  if (cfg.aux && cfg.aux.path) cfg.aux.path = path.join(root, "inputs", path.basename(cfg.aux.path));
  const r = JSON.parse(A.audioRenderOffline(inputFor(id), JSON.stringify(cfg), out));
  const ms = Date.now() - t0;
  fs.rmSync(out, { recursive: true, force: true });
  if (r.error) { console.log(`[napi] ${id}: ERROR ${r.error}`); fails++; continue; }
  const ok = r.monitor.hash === g.monitor.hash && r.stream.hash === g.stream.hash && r.frames === g.frames
    && (!g.aux || (r.aux && r.aux.hash === g.aux.hash));
  if (!ok) fails++;
  console.log(`[napi] ${id.padEnd(30)} ${ok ? "BIT-EXACT" : "DIFFERS  "} monitor ${r.monitor.hash} stream ${r.stream.hash} frames ${r.frames} (${ms} ms)`);
}
console.log(`[napi] ${ids.length - fails}/${ids.length} renders bit-exact to the manifest`);
process.exit(fails ? 1 : 0);
