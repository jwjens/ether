// silenceRegions — JS silence-gap detector for the Reel Splitter. The shipped native cue detector
// (audio_engine.rs detect_cue_points) returns only 4 head/tail scalars for ONE clip and cannot emit
// interior regions (verified 2026-07-15), so we detect silence runs directly on the decoded AudioBuffer
// with the same RMS-per-hop / threshold concept. Returns the CONTENT regions between silence gaps.

export interface Region { start: number; end: number }   // seconds

export interface SilenceOpts {
  thresholdDb?: number;     // below this = silence (default -45 dBFS)
  minSilenceSec?: number;   // a gap must be at least this long to split (default 0.35s)
  minRegionSec?: number;    // drop content shorter than this (default 0.30s)
  padSec?: number;          // keep this much of the silence on each side of a region (default 0.05s)
  hopSec?: number;          // analysis hop (default 0.01s = 10ms)
}

// Mono RMS envelope (averaged across channels), one value per hop.
function rmsEnvelope(buffer: AudioBuffer, hop: number): { env: Float32Array; hop: number } {
  const chs = buffer.numberOfChannels;
  const n = buffer.length;
  const frames = Math.max(1, Math.floor(n / hop));
  const env = new Float32Array(frames);
  const data: Float32Array[] = [];
  for (let c = 0; c < chs; c++) data.push(buffer.getChannelData(c));
  for (let f = 0; f < frames; f++) {
    const s = f * hop, e = Math.min(n, s + hop);
    let sum = 0, cnt = 0;
    for (let i = s; i < e; i++) { for (let c = 0; c < chs; c++) { const v = data[c][i]; sum += v * v; cnt++; } }
    env[f] = cnt ? Math.sqrt(sum / cnt) : 0;
  }
  return { env, hop };
}

export function detectSilenceRegions(buffer: AudioBuffer, opts: SilenceOpts = {}): Region[] {
  const sr = buffer.sampleRate;
  const dur = buffer.duration;
  const thresholdDb = opts.thresholdDb ?? -45;
  const minSilence = opts.minSilenceSec ?? 0.35;
  const minRegion = opts.minRegionSec ?? 0.30;
  const pad = opts.padSec ?? 0.05;
  const hop = Math.max(1, Math.floor((opts.hopSec ?? 0.01) * sr));
  const thresh = Math.pow(10, thresholdDb / 20);   // linear amplitude

  const { env } = rmsEnvelope(buffer, hop);
  const hopSec = hop / sr;
  const minSilenceHops = Math.max(1, Math.round(minSilence / hopSec));

  // Walk the envelope; a run of >= minSilenceHops silent hops is a gap. Content lives between gaps.
  const regions: Region[] = [];
  let contentStart = -1;       // hop index where current content began (-1 = in silence)
  let silentRun = 0;
  const closeRegion = (endHop: number) => {
    if (contentStart < 0) return;
    let start = contentStart * hopSec - pad;
    let end = endHop * hopSec + pad;
    start = Math.max(0, start); end = Math.min(dur, end);
    if (end - start >= minRegion) regions.push({ start, end });
    contentStart = -1;
  };

  for (let f = 0; f < env.length; f++) {
    const silent = env[f] < thresh;
    if (silent) {
      silentRun++;
      if (contentStart >= 0 && silentRun >= minSilenceHops) closeRegion(f - silentRun + 1);
    } else {
      silentRun = 0;
      if (contentStart < 0) contentStart = f;
    }
  }
  closeRegion(env.length);

  // No silence found (or one long piece) → the whole reel is one region.
  if (regions.length === 0) return [{ start: 0, end: dur }];
  return regions;
}
