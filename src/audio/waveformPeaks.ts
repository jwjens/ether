// waveformPeaks — min/max peaks per column for a waveform canvas.
//
// LIFTED OUT OF ReelSplitter, not copied. CLAUDE.md rules the region engine is shared and never
// duplicated ("one region engine, two surfaces, never a copy"), and this is the drawing half of it:
// the Reel Splitter, the StudioPro chop-and-send and the RACK mark editor all draw the same picture,
// so they compute it with the same function. A second implementation would be a second waveform that
// could disagree with the first about where a sound starts — which, for a surface whose whole job is
// saying where a sound starts, is the defect.

/** One min and one max sample per canvas column, from channel 0. */
export function computePeaks(buf: AudioBuffer, cols: number): { min: Float32Array; max: Float32Array } {
  const data = buf.getChannelData(0); const n = data.length; const per = Math.max(1, Math.floor(n / cols));
  const min = new Float32Array(cols), max = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    let lo = 1, hi = -1; const s = c * per, e = Math.min(n, s + per);
    for (let i = s; i < e; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[c] = lo === 1 ? 0 : lo; max[c] = hi === -1 ? 0 : hi;
  }
  return { min, max };
}
