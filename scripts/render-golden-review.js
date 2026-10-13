// scripts/render-golden-review.js — the golden renders the approved changes moved, rendered for Jeff's ears (2026-10-13).
//
// docs/golden-review-4.6.59-2026-10-13.md. READ-ONLY toward the goldens: nothing is re-captured, the manifest is not
// touched. For each case it renders the CURRENT engine (the built ether-audio.node) with the render's own manifest
// settings, copies the OLD golden WAV beside it, and measures both with ffmpeg's BS.1770 meter (integrated loudness, true
// peak) so the ear has numbers next to it. Output: native/goldens/review-4.6.59/ (gitignored).
//   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/render-golden-review.js [path to ether-audio.node]
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const ROOT = path.join(__dirname, "..");
const NODE = path.resolve(process.argv[2] || path.join(ROOT, "native", "ether-audio.node"));
const A = require(NODE);
const G = path.join(ROOT, "native", "goldens");
const OUT = path.join(G, "review-4.6.59");
const FF = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
const manifest = JSON.parse(fs.readFileSync(path.join(G, "manifest.json"), "utf8"));

// [file prefix, plain name, render id, tap]
const CASES = [
  ["01", "Music with processing on - what the room hears", "music__LINKED", "monitor"],
  ["02", "Music on the stream, processed to -16 LUFS and a -2 dBTP ceiling", "music__SPLIT", "stream"],
  ["03", "Speech with processing on", "speech__LINKED", "monitor"],
  ["04", "Limiter at ceiling - a -1 dBFS signal with inter-sample peaks", "isp_m1__LINKED", "stream"],
  ["05", "Steady 1 kHz tone at -18 through processing", "tone_1k_m18__LINKED", "monitor"],
  ["06", "Sweep 20 Hz to 20 kHz through processing and EQ", "sweep_20_20k_m18__EQ", "stream"],
  ["07", "Music ducked under voice - processing off", "music__AUXDUCK_OFF", "monitor"],
  ["08", "Music ducked under voice - processing on", "music__AUXDUCK_LINKED", "monitor"],
  ["09", "Voice on the AUX room output - processing on", "music__AUXDUCK_LINKED", "aux"],
];

function measure(wav) {
  const r = cp.spawnSync(FF, ["-hide_banner", "-nostats", "-i", wav, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const t = r.stderr || "";
  const sum = t.slice(t.lastIndexOf("Summary:"));
  const num = (re) => { const m = re.exec(sum); return m ? Number(m[1]) : null; };
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/), tp: num(/Peak:\s+(-?[\d.]+|-inf) dBFS/) };
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const rows = [];
const rendered = new Map();
for (const [n, name, id, tap] of CASES) {
  const g = manifest.renders[id];
  if (!g) throw new Error(`not in manifest: ${id}`);
  let dir = rendered.get(id);
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-review-"));
    const cfg = JSON.parse(JSON.stringify(g.cfg));
    if (cfg.aux && cfg.aux.path) cfg.aux.path = path.join(G, "inputs", path.basename(cfg.aux.path));
    const input = path.join(G, "inputs", manifest.inputs[id.split("__")[0]].file);
    const r = JSON.parse(A.audioRenderOffline(input, JSON.stringify(cfg), dir));
    if (r.error) throw new Error(`${id}: ${r.error}`);
    rendered.set(id, dir);
  }
  const oldSrc = path.join(G, `${id}__${tap}.wav`);
  const oldDst = path.join(OUT, `${n} - ${name} - OLD (golden).wav`);
  const newDst = path.join(OUT, `${n} - ${name} - NEW (current engine).wav`);
  fs.copyFileSync(path.join(dir, `${tap}.wav`), newDst);
  const hasOld = fs.existsSync(oldSrc);
  if (hasOld) fs.copyFileSync(oldSrc, oldDst);
  const o = hasOld ? measure(oldDst) : null, w = measure(newDst);
  rows.push({ n, name, id, tap, old: o, new: w });
  console.log(`${n}  ${name.padEnd(68)} OLD ${o ? `${o.lufs} LUFS / ${o.tp} dBTP` : "(no golden wav)"}  NEW ${w.lufs} LUFS / ${w.tp} dBTP`);
}
for (const d of rendered.values()) fs.rmSync(d, { recursive: true, force: true });
fs.writeFileSync(path.join(OUT, "measurements.json"), JSON.stringify({ engine: NODE, at: new Date().toISOString(), rows }, null, 2));
console.log(`\n${OUT}`);
