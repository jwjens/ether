// scripts/golden-review-diff.js — what changed between each OLD golden and the NEW render, in numbers (2026-10-13).
//
// docs/golden-review-4.6.59-2026-10-13.md. Reads the pairs scripts/render-golden-review.js wrote. Per pair: the largest
// sample difference (dB below full scale) and how much of the file differs at all. For the duck cases, the programme level
// in the moments the voice is talking vs. when it is not — using the voice (AUX) render to find those moments.
//   node scripts/golden-review-diff.js
"use strict";
const fs = require("fs"), path = require("path");
const DIR = path.join(__dirname, "..", "native", "goldens", "review-4.6.59");

function readWav(p) {
  const b = fs.readFileSync(p);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { tag: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") { data = b.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.bits !== 32) throw new Error(`${p}: expected 32-bit float WAV`);
  return { ...fmt, s: new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)) };
}
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const fmtDb = (x) => (Number.isFinite(x) ? `${x.toFixed(1)} dB` : "-inf");

// Mean power of `prog` in 100 ms windows where `voice` is above / below -45 dBFS RMS.
function duckLevels(prog, voice, rate) {
  const win = Math.round(rate * 0.1) * 2;
  let pOn = 0, nOn = 0, pOff = 0, nOff = 0;
  for (let i = 0; i + win <= Math.min(prog.length, voice.length); i += win) {
    let v = 0, p = 0;
    for (let k = i; k < i + win; k++) { v += voice[k] * voice[k]; p += prog[k] * prog[k]; }
    v /= win; p /= win;
    if (db(Math.sqrt(v)) > -45) { pOn += p; nOn++; } else { pOff += p; nOff++; }
  }
  return { talking: db(Math.sqrt(pOn / Math.max(1, nOn))), quiet: db(Math.sqrt(pOff / Math.max(1, nOff))), windowsTalking: nOn };
}

const files = fs.readdirSync(DIR).filter(f => / - OLD \(golden\)\.wav$/.test(f)).sort();
const voiceNew = files.find(f => f.startsWith("09 "));
const voice = voiceNew ? readWav(path.join(DIR, voiceNew.replace("OLD (golden)", "NEW (current engine)"))) : null;
const out = [];
for (const f of files) {
  const o = readWav(path.join(DIR, f)), n = readWav(path.join(DIR, f.replace("OLD (golden)", "NEW (current engine)")));
  const len = Math.min(o.s.length, n.s.length);
  let maxd = 0, changed = 0;
  for (let i = 0; i < len; i++) { const d = Math.abs(o.s[i] - n.s[i]); if (d > maxd) maxd = d; if (d > 1e-6) changed++; }
  // The new limiter adds 11 samples of latency (72 → 83), so a processed render is the old one SHIFTED as well as
  // changed. Aligned: the shift (in frames, 0..40) that best matches, and what differs once the shift is taken out.
  let best = { lag: 0, max: maxd };
  for (let lag = 1; lag <= 40; lag++) {
    let m = 0;
    for (let i = 0; i + lag * 2 < len; i++) { const d = Math.abs(o.s[i] - n.s[i + lag * 2]); if (d > m) m = d; if (m >= best.max) break; }
    if (m < best.max) best = { lag, max: m };
  }
  const row = { file: f.replace(" - OLD (golden).wav", ""), maxDiff: fmtDb(db(maxd)), changedPct: `${(100 * changed / len).toFixed(1)}%`, sameLength: o.s.length === n.s.length,
                alignedShiftFrames: best.lag, alignedMaxDiff: fmtDb(db(best.max)) };
  if (voice && /^0[78] /.test(f)) {
    const lo = duckLevels(o.s, voice.s, o.rate), ln = duckLevels(n.s, voice.s, n.rate);
    row.duck = { oldTalking: fmtDb(lo.talking), newTalking: fmtDb(ln.talking), oldQuiet: fmtDb(lo.quiet), newQuiet: fmtDb(ln.quiet), windowsTalking: lo.windowsTalking };
  }
  out.push(row);
  console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(DIR, "differences.json"), JSON.stringify(out, null, 2));
