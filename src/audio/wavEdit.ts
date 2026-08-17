// Shared audio-edit helpers for the voice-track / call editors.
// Decode a recorded blob, extract display peaks, apply trim + fades, encode to WAV.

/** Down-sample an AudioBuffer's first channel to `resolution` peak magnitudes (0..1). */
export function extractPeaks(buffer: AudioBuffer, resolution = 2000): Float32Array {
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / resolution));
  const peaks = new Float32Array(resolution);
  for (let i = 0; i < resolution; i++) {
    let max = 0;
    for (let j = 0; j < step; j++) {
      const v = Math.abs(data[i * step + j] || 0);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

/** Peaks for a sub-range [startSec, endSec] at `resolution` — gives true detail when zoomed. */
export function extractPeaksRange(buffer: AudioBuffer, startSec: number, endSec: number, resolution = 2000): Float32Array {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const s = Math.max(0, Math.floor(startSec * sr));
  const e = Math.min(buffer.length, Math.floor(endSec * sr));
  const span = Math.max(1, e - s);
  const step = Math.max(1, Math.floor(span / resolution));
  const peaks = new Float32Array(resolution);
  for (let i = 0; i < resolution; i++) {
    let max = 0; const base = s + i * step;
    for (let j = 0; j < step; j++) { const v = Math.abs(data[base + j] || 0); if (v > max) max = v; }
    peaks[i] = max;
  }
  return peaks;
}

/** What a waveform draw needs, packed as a GL-ready texture.
 *  width = `length`, height = `channels`; row c is channel c.
 *  - kind "envelope": R = max, G = min (both signed, encoded (v+1)/2), B = RMS (0..1)
 *  - kind "samples":  R = the sample itself, signed, encoded (v+1)/2
 */
export interface WaveDetail {
  kind:     "envelope" | "samples";
  channels: number;
  length:   number;
  rgba:     Uint8Array;
}

const enc = (v: number) => Math.max(0, Math.min(255, Math.round((Math.max(-1, Math.min(1, v)) + 1) * 127.5)));

/** Per-channel min/max/RMS over `resolution` buckets of [startSec, endSec].
 *  Unlike extractPeaks this keeps BOTH excursions and the RMS inside them, which is what gives a
 *  waveform its two-tone body — the outer shape is the peak, the brighter core is the energy. */
export function extractEnvelopeRange(
  buffer: AudioBuffer, startSec: number, endSec: number, resolution: number,
): WaveDetail {
  const chans = Math.min(2, buffer.numberOfChannels);
  const sr    = buffer.sampleRate;
  const s     = Math.max(0, Math.floor(startSec * sr));
  const e     = Math.min(buffer.length, Math.floor(endSec * sr));
  const span  = Math.max(1, e - s);
  const step  = Math.max(1, Math.floor(span / resolution));
  const rgba  = new Uint8Array(resolution * chans * 4);
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    const row  = c * resolution * 4;
    for (let i = 0; i < resolution; i++) {
      let mn = 1, mx = -1, sum = 0, cnt = 0;
      const base = s + i * step;
      for (let j = 0; j < step; j++) {
        const v = data[base + j];
        if (v === undefined) break;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v * v; cnt++;
      }
      if (!cnt) { mn = 0; mx = 0; }
      const o = row + i * 4;
      rgba[o]     = enc(mx);
      rgba[o + 1] = enc(mn);
      rgba[o + 2] = Math.min(255, Math.round(Math.sqrt(sum / Math.max(1, cnt)) * 255));
      rgba[o + 3] = 255;
    }
  }
  return { kind: "envelope", channels: chans, length: resolution, rgba };
}

/** Raw per-channel samples over [startSec, endSec], for the zoom depth where a waveform stops
 *  being a bar chart and becomes an actual signal trace. Refuses spans wider than `maxSamples`. */
export function extractSamplesRange(
  buffer: AudioBuffer, startSec: number, endSec: number, maxSamples: number,
): WaveDetail | null {
  const chans = Math.min(2, buffer.numberOfChannels);
  const sr    = buffer.sampleRate;
  const s     = Math.max(0, Math.floor(startSec * sr));
  const e     = Math.min(buffer.length, Math.floor(endSec * sr));
  const n     = e - s;
  if (n <= 1 || n > maxSamples) return null;
  const rgba = new Uint8Array(n * chans * 4);
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    const row  = c * n * 4;
    for (let i = 0; i < n; i++) {
      const o = row + i * 4;
      rgba[o] = enc(data[s + i] ?? 0);
      rgba[o + 3] = 255;
    }
  }
  return { kind: "samples", channels: chans, length: n, rgba };
}

/** Decode any recorded blob (webm/ogg/wav) to an AudioBuffer. */
export async function decodeBlobToBuffer(blob: Blob): Promise<AudioBuffer> {
  const ab = await blob.arrayBuffer();
  const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(ab.slice(0));
  } finally {
    ctx.close().catch(() => {});
  }
}

/**
 * Produce a new AudioBuffer trimmed to [startSec, endSec] with optional linear
 * fade-in / fade-out (seconds). This is the "bake the edits into the audio" step.
 */
export function trimAndFade(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  fadeInSec = 0,
  fadeOutSec = 0,
): AudioBuffer {
  const sr = buffer.sampleRate;
  const startSample = Math.max(0, Math.floor(startSec * sr));
  const endSample = Math.min(buffer.length, Math.floor(endSec * sr));
  const len = Math.max(1, endSample - startSample);
  const out = new AudioBuffer({ length: len, numberOfChannels: buffer.numberOfChannels, sampleRate: sr });
  const fiS = Math.max(0, Math.floor(fadeInSec * sr));
  const foS = Math.max(0, Math.floor(fadeOutSec * sr));
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      let v = src[startSample + i] || 0;
      if (fiS > 0 && i < fiS) v *= i / fiS;
      if (foS > 0 && i > len - foS) v *= Math.max(0, (len - i) / foS);
      dst[i] = v;
    }
  }
  return out;
}

/** Remove [startSec, endSec] from the buffer and join the remainder (destructive trim/delete). */
export function spliceOut(buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const sr = buffer.sampleRate;
  const s = Math.max(0, Math.floor(startSec * sr));
  const e = Math.min(buffer.length, Math.floor(endSec * sr));
  const removed = Math.max(0, e - s);
  const newLen = Math.max(1, buffer.length - removed);
  const out = new AudioBuffer({ length: newLen, numberOfChannels: buffer.numberOfChannels, sampleRate: sr });
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < s; i++) dst[i] = src[i];               // keep before selection
    for (let i = e; i < buffer.length; i++) dst[s + (i - e)] = src[i]; // keep after, shifted left
  }
  return out;
}

/** Copy [startSec, endSec] out into a new buffer (for Copy/Cut clipboard). */
export function sliceRegion(buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const sr = buffer.sampleRate;
  const s = Math.max(0, Math.floor(startSec * sr));
  const e = Math.min(buffer.length, Math.floor(endSec * sr));
  const len = Math.max(1, e - s);
  const out = new AudioBuffer({ length: len, numberOfChannels: buffer.numberOfChannels, sampleRate: sr });
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch), dst = out.getChannelData(ch);
    for (let i = 0; i < len; i++) dst[i] = src[s + i] || 0;
  }
  return out;
}

/** Insert `insert` at atSec, returning a new joined buffer (Paste / Insert Silence). */
export function insertAt(buffer: AudioBuffer, atSec: number, insert: AudioBuffer): AudioBuffer {
  const sr = buffer.sampleRate;
  const at = Math.max(0, Math.min(buffer.length, Math.floor(atSec * sr)));
  const nCh = buffer.numberOfChannels;
  const out = new AudioBuffer({ length: buffer.length + insert.length, numberOfChannels: nCh, sampleRate: sr });
  for (let ch = 0; ch < nCh; ch++) {
    const src = buffer.getChannelData(ch);
    const ins = insert.getChannelData(Math.min(ch, insert.numberOfChannels - 1));
    const dst = out.getChannelData(ch);
    for (let i = 0; i < at; i++) dst[i] = src[i];
    for (let i = 0; i < insert.length; i++) dst[at + i] = ins[i] || 0;
    for (let i = at; i < buffer.length; i++) dst[insert.length + i] = src[i];
  }
  return out;
}

/** A silent buffer of `durSec` seconds. */
export function makeSilence(sampleRate: number, channels: number, durSec: number): AudioBuffer {
  return new AudioBuffer({ length: Math.max(1, Math.floor(durSec * sampleRate)), numberOfChannels: channels, sampleRate });
}

/** Apply a linear fade in/out across [startSec, endSec]; returns a new buffer. */
export function applyFadeRegion(buffer: AudioBuffer, startSec: number, endSec: number, type: "in" | "out"): AudioBuffer {
  const sr = buffer.sampleRate;
  const s = Math.max(0, Math.floor(startSec * sr));
  const e = Math.min(buffer.length, Math.floor(endSec * sr));
  const span = Math.max(1, e - s);
  const out = new AudioBuffer({ length: buffer.length, numberOfChannels: buffer.numberOfChannels, sampleRate: sr });
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch), dst = out.getChannelData(ch);
    for (let i = 0; i < buffer.length; i++) {
      let g = 1;
      if (i >= s && i < e) { const t = (i - s) / span; g = type === "in" ? t : 1 - t; }
      dst[i] = (src[i] || 0) * g;
    }
  }
  return out;
}

/** Encode an AudioBuffer to a 16-bit PCM WAV ArrayBuffer. */
export function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const samples = buffer.length;
  const bitsPerSample = 16;
  const byteRate = (sr * numCh * bitsPerSample) / 8;
  const blockAlign = (numCh * bitsPerSample) / 8;
  const dataSize = samples * numCh * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const write = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  write(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, sr, true); view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, bitsPerSample, true);
  write(36, "data"); view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return ab;
}

/** Convert an ArrayBuffer to a base64 data URL (for DB storage like the existing flow). */
export function wavToDataUrl(wav: ArrayBuffer): string {
  const bytes = new Uint8Array(wav);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return "data:audio/wav;base64," + btoa(bin);
}
