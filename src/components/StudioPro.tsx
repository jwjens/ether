// StudioPro.tsx — GarageBand-style DAW assembled from existing Ether studio components.
// This file is an INTEGRATION layer. It does not modify WaveformGL, VoiceTracker,
// SmartSegueEditor, StudioEditor, or Waveform. It copies `extractPeaks` and
// `encodeWav` verbatim from StudioEditor.tsx (per the "do not modify existing
// components" directive) and imports WaveformGL + VoiceTracker as-is.
//
// DATA MODEL
//   Track owns N Regions. Each region carries its own AudioBuffer, peaks,
//   timeline offset, trim, and fade envelope. Track owns its own FX state:
//   7-band EQ, compressor, reverb, saturation, sidechain, automation lanes.
//
// AUDIO CHAIN (per track, conventional order)
//   regionSrc → regionFadeGain → trackGain → pan
//             → eq[0..6] (7 BiquadFilters, low-shelf / 5×peaking / high-shelf)
//             → optional saturation (WaveShaper)
//             → optional compressor (Dynamics + makeup gain)
//             → sidechain duck gain
//             → master gain → optional limiter → analyser → destination
//   Reverb runs as a PARALLEL send: post-comp tap → reverbWetGain → ConvolverNode → master
//
// FX WINDOWS
//   One floating draggable window per track. Window open/closed/position state
//   lives in StudioPro local state (NOT on the track), because the prompt says
//   "FX window state ... not persisted."
//
// AUTOMATION
//   Each track can expand N automation lanes. Each lane targets one parameter
//   (volume / pan / eq band / comp threshold / reverb wet) and holds a list
//   of breakpoints. On play(), all upcoming points are pre-scheduled on the
//   actual AudioParam via linearRampToValueAtTime — sample-accurate, no
//   per-frame JS work.

import React, {
  useCallback, useEffect, useMemo, useReducer, useRef, useState,
} from "react";
import { createPortal } from "react-dom";
import WaveformGL from "./WaveformGL";
// The shared range extractor — "gives true detail when zoomed" (wavEdit.ts:21) and, until now,
// wired to nothing. StudioPro's own extractPeaks copy at :433 stays put; dedup is a backlog item.
import { extractEnvelopeRange, extractSamplesRange } from "../audio/wavEdit";
import type { WaveDetail } from "../audio/wavEdit";
import VoiceTracker from "./VoiceTracker";
import StudioSendBar from "./StudioSendBar";
import { execute, query } from "../db/client";
import { useUser } from "../UserContext";

// ── File-URL shim ────────────────────────────────────────────────

const convertFileSrc = (p: string) => `file:///${p.replace(/\\/g, "/")}`;

// ── Palette ──────────────────────────────────────────────────────

// Rainbow ramp descending the tracks: red → orange → yellow → green → blue → purple.
const PALETTE = [
  "#ef4444", // red
  "#f97316", // orange
  "#f59e0b", // amber
  "#eab308", // yellow
  "#84cc16", // lime
  "#22c55e", // green
  "#10b981", // teal-green
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#a855f7", // purple
];

// ── Layout constants ─────────────────────────────────────────────

const TOOLBAR_H        = 48;
const HEADER_W         = 268;   // was 220 — the button row, name and fader were all fighting for it
const INSPECTOR_W      = 260;
const TRACK_H          = 72;
const RULER_H          = 24;
const HANDLE_W         = 6;
const FADE_ZONE        = 12;
const DRAWER_H         = 320;
const BASE_PPS         = 80;
// Zoom floor. The old 0.25 floor meant 20 px/s — a three-minute song was 3,600px wide and could
// NEVER be seen whole in a ~1,200px editor, which is why zoom-out felt broken rather than merely
// limited. 0.002 is 0.16 px/s: an hour-long session fits inside 600px. Fit-to-window computes the
// exact factor and only meets this floor on sessions longer than about ten hours.
/** The edit surface is dark by convention under ANY skin — Audition, Pro Tools, every DAW.
 *  It must NEVER be `var(--bg-primary)`: that variable is theme-dependent and at least two shipped
 *  themes define it light (`.light-theme` #f0eeeb, `.theme-ether-default` #b8bcc4 "polished
 *  aluminum"). A light ancestor is what turned any non-painting clip into a white hole. */
const SURFACE_DARK     = "#0d0d0d";

const MIN_ZOOM         = 0.002;
/** Zoom ceiling. 8 put the floor of sample mode out of reach: that mode needs fewer than 2 samples
 *  per device pixel, i.e. pps > ~24,000 at 48kHz, i.e. zoom > ~300. At 512 (pps 40,960) a 48kHz
 *  file sits near 1.17 samples/px — inside sample mode with margin. */
const MAX_ZOOM         = 512;

/** …but zoom also sets the timeline's DOM width, and browsers cap element dimensions near 33.5M px
 *  (Chrome tracks layout in 1/64px units on a 32-bit int). At zoom 512 a three-minute song is
 *  ~7.4M px — fine — while a one-hour session would demand ~147M px and the layout would simply
 *  break. The ceiling is therefore whichever is smaller: MAX_ZOOM, or the zoom that keeps the
 *  content inside this budget. Long sessions lose the deepest zoom rather than losing the timeline.
 *  Consequence worth knowing: sample mode stays reachable up to roughly a 20-minute session. */
const MAX_CONTENT_PX   = 30_000_000;
const MAX_UNDO         = 50;
const MAX_AUTOSAVES    = 10;
const AUTOSAVE_LABEL   = "Auto-save";
const AUTOMATION_LANE_H = 64;
const AUTOMATION_BAR_H  = 28;        // per-track header bar above stacked auto-lanes

// ── EQ definition (frequencies in Hz) ────────────────────────────

const EQ_FREQS  = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_LABELS = ["31", "63", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
const EQ_BANDS  = EQ_FREQS.length;   // 10
const EQ_DB_RANGE = 12;     // ±12 dB

// ── Reverb defs ──────────────────────────────────────────────────

type ReverbType = "room" | "hall" | "plate" | "spring";

// ── Automation params ───────────────────────────────────────────

type AutomationParam =
  | "volume" | "pan"
  | "eq60" | "eq150" | "eq400" | "eq1k" | "eq2400" | "eq6k" | "eq15k"
  | "comp_threshold" | "reverb_wet";

const EQ_PARAM_TO_BAND_IDX: Record<string, number> = {
  eq60: 0, eq150: 1, eq400: 2, eq1k: 3, eq2400: 4, eq6k: 5, eq15k: 6,
};

interface AutomationParamSpec { label: string; min: number; max: number; defaultValue: number; }
const AUTOMATION_SPECS: Record<AutomationParam, AutomationParamSpec> = {
  volume:         { label: "Volume",         min: -48, max: 6,   defaultValue: 0 },
  pan:            { label: "Pan",            min: -1,  max: 1,   defaultValue: 0 },
  eq60:           { label: "EQ 60Hz",        min: -EQ_DB_RANGE, max: EQ_DB_RANGE, defaultValue: 0 },
  eq150:          { label: "EQ 150Hz",       min: -EQ_DB_RANGE, max: EQ_DB_RANGE, defaultValue: 0 },
  eq400:          { label: "EQ 400Hz",       min: -EQ_DB_RANGE, max: EQ_DB_RANGE, defaultValue: 0 },
  eq1k:           { label: "EQ 1kHz",        min: -EQ_DB_RANGE, max: EQ_DB_RANGE, defaultValue: 0 },
  eq2400:         { label: "EQ 2.4kHz",      min: -EQ_DB_RANGE, max: EQ_DB_RANGE, defaultValue: 0 },
  eq6k:           { label: "EQ 6kHz",        min: -EQ_DB_RANGE, max: EQ_DB_RANGE, defaultValue: 0 },
  eq15k:          { label: "EQ 15kHz",       min: -EQ_DB_RANGE, max: EQ_DB_RANGE, defaultValue: 0 },
  comp_threshold: { label: "Comp Threshold", min: -60, max: 0,   defaultValue: -18 },
  reverb_wet:     { label: "Reverb Wet",     min: 0,   max: 1,   defaultValue: 0 },
};

// ── Types ────────────────────────────────────────────────────────

interface StudioRegion {
  id:          string;
  buffer:      AudioBuffer | null;
  peaks:       Float32Array | null;
  filePath:    string | null;
  offsetMs:    number;
  trimStartMs: number;
  trimEndMs:   number;
  fadeInMs:    number;
  fadeOutMs:   number;
  clipGainDb:  number;   // per-region gain (post-fade, pre-track)
}

interface AutomationPoint { id: string; timeMs: number; value: number; }
interface AutomationLane  { id: string; param: AutomationParam; points: AutomationPoint[]; }

interface TrackCompressor {
  on: boolean;
  threshold: number;   // dB
  ratio: number;       // n:1
  attack: number;      // ms
  release: number;     // ms
  makeup: number;      // dB (post-compressor gain)
}

interface TrackReverb {
  on: boolean;
  type: ReverbType;
  wet: number;         // 0..1
  size: number;        // 0..1, scales IR length
}

interface TrackSaturation {
  on: boolean;
  drive: number;       // dB drive (0..24)
}

interface StudioTrack {
  id:        string;
  name:      string;
  color:     string;
  regions:   StudioRegion[];
  gainDb:    number;
  pan:       number;
  muted:     boolean;
  solo:      boolean;
  armed:     boolean;
  eq7:       number[];               // length 7, dB per band
  compressor: TrackCompressor;
  reverb:     TrackReverb;
  saturation: TrackSaturation;
  sidechainSourceId: string | null;
  sidechainAmountDb: number;
  automationOpen:    boolean;
  automationLanes:   AutomationLane[];
  originalContent:   boolean;
}

type TrackPatch = Partial<Omit<StudioTrack, "id" | "regions">>;
type RegionPatch = Partial<Omit<StudioRegion, "id">>;

type Action =
  | { type: "ADD_TRACK"; name?: string }
  | { type: "DELETE_TRACK"; id: string }
  | { type: "UPDATE_TRACK"; id: string; patch: TrackPatch }
  | { type: "CLEAR_TRACK"; id: string }
  | { type: "ADD_REGION"; trackId: string; region: StudioRegion; replaceAll?: boolean }
  | { type: "DELETE_REGION"; trackId: string; regionId: string }
  | { type: "UPDATE_REGION"; trackId: string; regionId: string; patch: RegionPatch }
  | { type: "MOVE_REGION"; trackId: string; regionId: string; offsetMs: number }
  | { type: "MOVE_REGION_TO_TRACK"; srcTrackId: string; destTrackId: string; regionId: string; offsetMs: number }
  | { type: "TRIM_REGION"; trackId: string; regionId: string; trimStartMs?: number; trimEndMs?: number; offsetMs?: number }
  | { type: "SPLIT_REGION"; trackId: string; regionId: string; atMs: number; bufA: AudioBuffer; peaksA: Float32Array; bufB: AudioBuffer; peaksB: Float32Array; newRightId: string }
  | { type: "MERGE_REGIONS"; trackId: string; ids: string[]; buffer: AudioBuffer; peaks: Float32Array; newId: string; offsetMs: number; fadeInMs: number; fadeOutMs: number }
  | { type: "ADD_MARKER"; marker: TimelineMarker }
  | { type: "DELETE_MARKER"; id: string }
  | { type: "RENAME_MARKER"; id: string; label: string }
  | { type: "DUPLICATE_REGION"; trackId: string; regionId: string; offsetMs: number; newId: string }
  | { type: "PASTE_REGION"; trackId: string; offsetMs: number; region: StudioRegion }
  | { type: "AUTO_CROSSFADE"; trackId: string; updates: Array<{ regionId: string; fadeInMs?: number; fadeOutMs?: number }> }
  | { type: "ADD_AUTOMATION_LANE"; trackId: string; param: AutomationParam }
  | { type: "REMOVE_AUTOMATION_LANE"; trackId: string; laneId: string }
  | { type: "SET_AUTOMATION_PARAM"; trackId: string; laneId: string; param: AutomationParam }
  | { type: "ADD_AUTO_POINT"; trackId: string; laneId: string; point: AutomationPoint }
  | { type: "MOVE_AUTO_POINT"; trackId: string; laneId: string; pointId: string; timeMs: number; value: number }
  | { type: "DELETE_AUTO_POINT"; trackId: string; laneId: string; pointId: string }
  | { type: "REPLACE"; tracks: StudioTrack[] }
  ;

interface TimelineMarker {
  id: string;
  timeMs: number;
  label: string;
  color: string;
}

interface MixerSnapshot {
  id: string;
  name: string;
  takenAt: number;
  tracksJson: any;     // shallow snapshot of all tracks (FX state, gain/pan/etc.; not buffers)
  master: { masterGainDb: number; limiterEnabled: boolean; limiterThresh: number; masterEq7: number[]; masterComp: TrackCompressor };
}

interface SessionVersion {
  id:             string;
  session_id:     string;
  version_number: number;
  label:          string | null;
  snapshot:       string;   // JSON
  created_at:     number;
  track_count?:   number;   // parsed from snapshot for display
}

interface StudioNote {
  id:          string;
  session_id:  string;
  position_ms: number;
  track_id:    string | null;
  author:      string;
  text:        string;
  color:       string;
  resolved:    number; // 0 | 1
  created_at:  number;
}

interface State {
  tracks: StudioTrack[];
  markers: TimelineMarker[];
}

// ── Module-level cache: survives unmount/remount cycles so switching to
//    Live and back doesn't wipe the studio session. AudioBuffers/peaks/blob
//    URLs all live in this object too. Cleared only on full page reload. ──

interface StudioCache {
  tracks: StudioTrack[];
  markers: TimelineMarker[];
  masterGainDb: number;
  limiterEnabled: boolean;
  limiterThresh: number;
  masterEq7: number[];
  masterComp: TrackCompressor;
  bpm: number;
  zoom: number;
  loopRange: { startMs: number; endMs: number } | null;
  loopEnabled: boolean;
  clickEnabled: boolean;
  gridEnabled: boolean;
  playheadMs: number;
  selection: { trackId: string; regionId: string | null } | null;
  snapshots: MixerSnapshot[];
}
let studioCache: StudioCache | null = null;
let studioClipboard: StudioRegion | null = null;   // module-level so it survives unmount

// ── Helpers ──────────────────────────────────────────────────────

const uuid = () =>
  (typeof crypto !== "undefined" && (crypto as any).randomUUID)
    ? (crypto as any).randomUUID()
    : "t_" + Math.random().toString(36).slice(2, 10);

function fmtTimecode(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = Math.floor(ms % 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
}
function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function dbToLinear(db: number): number { return Math.pow(10, db / 20); }
function linearToDb(v: number): number { return 20 * Math.log10(Math.max(1e-6, v)); }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function regionDurMs(r: StudioRegion): number {
  if (!r.buffer) return 0;
  return Math.max(0, r.buffer.duration * 1000 - r.trimStartMs - r.trimEndMs);
}
function regionEndMs(r: StudioRegion): number { return r.offsetMs + regionDurMs(r); }
function trackEndMs(t: StudioTrack): number {
  let end = 0;
  for (const r of t.regions) { const e = regionEndMs(r); if (e > end) end = e; }
  return end;
}

function newRegion(init: Partial<StudioRegion> = {}): StudioRegion {
  return {
    id: uuid(), buffer: null, peaks: null, filePath: null,
    offsetMs: 0, trimStartMs: 0, trimEndMs: 0,
    fadeInMs: 0, fadeOutMs: 0,
    clipGainDb: 0,
    ...init,
  };
}

function newTrack(name: string, color: string): StudioTrack {
  return {
    id: uuid(), name, color,
    regions: [],
    gainDb: 0, pan: 0,
    muted: false, solo: false, armed: false,
    eq7: Array(EQ_BANDS).fill(0),
    compressor: { on: false, threshold: -18, ratio: 3, attack: 20, release: 200, makeup: 0 },
    reverb:     { on: false, type: "plate", wet: 0.25, size: 0.5 },
    saturation: { on: false, drive: 6 },
    sidechainSourceId: null,
    sidechainAmountDb: 12,
    automationOpen: false,
    automationLanes: [],
    originalContent: false,
  };
}

function nextColor(tracks: StudioTrack[]): string {
  return PALETTE[tracks.length % PALETTE.length];
}

// ── Linear interpolation of an automation lane at a given timeMs ──
function interpolateLane(lane: AutomationLane, timeMs: number): number | null {
  if (lane.points.length === 0) return null;
  const sorted = [...lane.points].sort((a, b) => a.timeMs - b.timeMs);
  if (timeMs <= sorted[0].timeMs) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (timeMs >= last.timeMs) return last.value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (timeMs >= a.timeMs && timeMs <= b.timeMs) {
      const t = (timeMs - a.timeMs) / Math.max(1, b.timeMs - a.timeMs);
      return a.value + t * (b.value - a.value);
    }
  }
  return last.value;
}

// ── DSP: reverb IR generators ────────────────────────────────────

function makeReverbIR(ctx: BaseAudioContext, type: ReverbType, size: number): AudioBuffer {
  const sr = ctx.sampleRate;
  // Per-type base seconds
  const baseSeconds = type === "room"   ? 0.7
                    : type === "hall"   ? 3.0
                    : type === "plate"  ? 2.2
                    :                     1.6;     // spring
  const sizeFactor = 0.5 + size * 1.5;             // 0.5..2.0
  const seconds = baseSeconds * sizeFactor;
  const len = Math.max(1, Math.floor(sr * seconds));
  const ir = (ctx as AudioContext).createBuffer(2, len, sr);
  const preMs = type === "hall" ? 25 : type === "plate" ? 8 : type === "spring" ? 2 : 5;
  const pre = Math.floor(sr * preMs / 1000);

  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      if (i < pre) { data[i] = 0; continue; }
      const t = (i - pre) / sr;
      // Decay shape per type
      let env = 0;
      if (type === "room") {
        env = Math.pow(1 - (i - pre) / (len - pre), 2.0);     // fast decay
      } else if (type === "hall") {
        env = Math.exp(-3.5 * t / seconds);                    // long exp
      } else if (type === "plate") {
        env = Math.exp(-3.0 * t / seconds);                    // bright dense
      } else {
        // spring: shorter, with a low-frequency flutter
        const flutter = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t);
        env = Math.exp(-3.5 * t / seconds) * flutter;
      }
      // Stereo decorrelation; plate slightly brighter (more high content)
      let n = (Math.random() * 2 - 1) * env * 0.6;
      if (type === "plate" && i > 0) {
        // Soft high boost via simple difference
        n = n * 0.7 + (n - data[i - 1]) * 0.3;
      } else if (type === "room" && i > 1) {
        // Soft low pass
        n = n * 0.5 + data[i - 1] * 0.35 + data[i - 2] * 0.15;
      }
      data[i] = n;
    }
  }
  return ir;
}

// Tanh saturation curve
function makeSatCurve(driveDb: number, samples = 4096): Float32Array {
  const k = Math.pow(10, driveDb / 20);
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

// ── Copied verbatim from StudioEditor.tsx ────────────────────────

function extractPeaks(buffer: AudioBuffer, resolution = 2000): Float32Array {
  const data    = buffer.getChannelData(0);
  const step    = Math.max(1, Math.floor(data.length / resolution));
  const peaks   = new Float32Array(resolution);
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

function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const numCh    = buffer.numberOfChannels;
  const sr       = buffer.sampleRate;
  const samples  = buffer.length;
  const bitsPerSample = 16;
  const byteRate = (sr * numCh * bitsPerSample) / 8;
  const blockAlign = (numCh * bitsPerSample) / 8;
  const dataSize = samples * numCh * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const write = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  write(0,  "RIFF");
  view.setUint32(4,  36 + dataSize, true);
  write(8,  "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1,  true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr,    true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  write(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return ab;
}

// ── LSB watermark embedding (mirrors Rust audio_export.rs) ──────
// Magic: "ETHRWM01" | 4-byte LE payload length | JSON payload
// One bit per i16 sample, MSB-first per byte.
async function embedWatermarkInWav(
  wavBuffer: ArrayBuffer,
  meta: { stationId: string; timestamp: string; etherVersion: string }
): Promise<ArrayBuffer> {
  const view    = new DataView(wavBuffer);
  const buf     = new Uint8Array(wavBuffer);

  // Find the 'data' chunk
  let pcmOffset = -1, pcmLen = 0;
  let off = 12;
  while (off < buf.length - 8) {
    const id  = String.fromCharCode(buf[off], buf[off+1], buf[off+2], buf[off+3]);
    const len = view.getUint32(off + 4, true);
    if (id === "data") { pcmOffset = off + 8; pcmLen = len; break; }
    off += 8 + len + (len & 1);
  }
  if (pcmOffset < 0) return wavBuffer;

  const numSamples = Math.floor(pcmLen / 2);
  const samples    = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++)
    samples[i] = view.getInt16(pcmOffset + i * 2, true);

  // Hash with LSBs cleared (watermark-region will be cleared; rest untouched)
  // We compute the hash after embedding (Rust clears watermarked LSBs before hashing)
  // So: clear first-N sample LSBs, hash all, then embed.
  const MAGIC        = new TextEncoder().encode("ETHRWM01");
  // Build placeholder payload to know N
  const placeholderPayload = JSON.stringify({
    station_id: meta.stationId, timestamp: meta.timestamp,
    ether_version: meta.etherVersion, content_hash: "0".repeat(64),
  });
  const placeholderLen = new TextEncoder().encode(placeholderPayload).length;
  const samplesNeeded  = (8 + 4 + placeholderLen) * 8;

  if (numSamples < samplesNeeded) return wavBuffer; // too short

  // Clear LSBs of watermarked region for hashing
  const cleared = new Int16Array(samples);
  for (let i = 0; i < samplesNeeded; i++) cleared[i] = (cleared[i] & ~1) as number;
  const clearedBytes = new Uint8Array(cleared.buffer);
  const hashBuf      = await crypto.subtle.digest("SHA-256", clearedBytes);
  const hashHex      = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

  // Build final payload
  const payloadStr   = JSON.stringify({
    station_id: meta.stationId, timestamp: meta.timestamp,
    ether_version: meta.etherVersion, content_hash: hashHex,
  });
  const payloadBytes = new TextEncoder().encode(payloadStr);
  const payloadLen   = payloadBytes.length;

  // Build watermark byte sequence
  const wm = new Uint8Array(8 + 4 + payloadLen);
  wm.set(MAGIC, 0);
  wm[8]  =  payloadLen        & 0xff;
  wm[9]  = (payloadLen >>  8) & 0xff;
  wm[10] = (payloadLen >> 16) & 0xff;
  wm[11] = (payloadLen >> 24) & 0xff;
  wm.set(payloadBytes, 12);

  // Embed: one bit per sample, MSB-first per byte
  const totalBits = wm.length * 8;
  if (numSamples < totalBits) return wavBuffer;
  for (let b = 0; b < wm.length; b++) {
    for (let bit = 0; bit < 8; bit++) {
      const bitVal = (wm[b] >> (7 - bit)) & 1;
      const idx    = b * 8 + bit;
      samples[idx] = ((samples[idx] & ~1) | bitVal) as number;
    }
  }

  // Write modified samples back into a copy of the buffer
  const out     = wavBuffer.slice(0);
  const outView = new DataView(out);
  for (let i = 0; i < numSamples; i++)
    outView.setInt16(pcmOffset + i * 2, samples[i], true);
  return out;
}

// ── Reducer ──────────────────────────────────────────────────────

function mapRegion(t: StudioTrack, rid: string, f: (r: StudioRegion) => StudioRegion): StudioTrack {
  return { ...t, regions: t.regions.map(r => r.id === rid ? f(r) : r) };
}
function mapLane(t: StudioTrack, lid: string, f: (l: AutomationLane) => AutomationLane): StudioTrack {
  return { ...t, automationLanes: t.automationLanes.map(l => l.id === lid ? f(l) : l) };
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "ADD_TRACK": {
      const n = s.tracks.length + 1;
      return { ...s, tracks: [...s.tracks, newTrack(a.name || `Track ${n}`, nextColor(s.tracks))] };
    }
    case "DELETE_TRACK": {
      return { ...s, tracks: s.tracks.filter(t => t.id !== a.id) };
    }
    case "UPDATE_TRACK": {
      return { ...s, tracks: s.tracks.map(t => t.id === a.id ? { ...t, ...a.patch } : t) };
    }
    case "CLEAR_TRACK": {
      return { ...s, tracks: s.tracks.map(t => t.id === a.id ? { ...t, regions: [] } : t) };
    }
    case "ADD_REGION": {
      return { ...s, tracks: s.tracks.map(t => {
        if (t.id !== a.trackId) return t;
        const regions = a.replaceAll ? [a.region] : [...t.regions, a.region];
        return { ...t, regions };
      }) };
    }
    case "DELETE_REGION": {
      return { ...s, tracks: s.tracks.map(t => t.id === a.trackId
        ? { ...t, regions: t.regions.filter(r => r.id !== a.regionId) } : t) };
    }
    case "UPDATE_REGION": {
      return { ...s, tracks: s.tracks.map(t => t.id === a.trackId
        ? mapRegion(t, a.regionId, r => ({ ...r, ...a.patch })) : t) };
    }
    case "MOVE_REGION": {
      return { ...s, tracks: s.tracks.map(t => t.id === a.trackId
        ? mapRegion(t, a.regionId, r => ({ ...r, offsetMs: Math.max(0, a.offsetMs) })) : t) };
    }
    case "MOVE_REGION_TO_TRACK": {
      if (a.srcTrackId === a.destTrackId) {
        return reducer(s, { type: "MOVE_REGION", trackId: a.srcTrackId, regionId: a.regionId, offsetMs: a.offsetMs });
      }
      const srcTrack = s.tracks.find(t => t.id === a.srcTrackId);
      if (!srcTrack) return s;
      const region = srcTrack.regions.find(r => r.id === a.regionId);
      if (!region) return s;
      const moved: StudioRegion = { ...region, offsetMs: Math.max(0, a.offsetMs) };
      return { ...s, tracks: s.tracks.map(t => {
        if (t.id === a.srcTrackId) return { ...t, regions: t.regions.filter(r => r.id !== a.regionId) };
        if (t.id === a.destTrackId) return { ...t, regions: [...t.regions, moved] };
        return t;
      }) };
    }
    case "TRIM_REGION": {
      return { ...s, tracks: s.tracks.map(t => {
        if (t.id !== a.trackId) return t;
        return mapRegion(t, a.regionId, r => {
          const dur = r.buffer ? r.buffer.duration * 1000 : 0;
          const ts = a.trimStartMs !== undefined ? Math.max(0, Math.min(a.trimStartMs, dur - 50 - r.trimEndMs)) : r.trimStartMs;
          const te = a.trimEndMs   !== undefined ? Math.max(0, Math.min(a.trimEndMs,   dur - 50 - ts))         : r.trimEndMs;
          let of = r.offsetMs;
          if (a.trimStartMs !== undefined && a.offsetMs !== undefined) {
            const tsDelta = ts - r.trimStartMs;
            of = Math.max(0, r.offsetMs + tsDelta);
          } else if (a.offsetMs !== undefined) {
            of = Math.max(0, a.offsetMs);
          }
          return { ...r, trimStartMs: ts, trimEndMs: te, offsetMs: of };
        });
      }) };
    }
    case "SPLIT_REGION": {
      return { ...s, tracks: s.tracks.map(t => {
        if (t.id !== a.trackId) return t;
        const idx = t.regions.findIndex(r => r.id === a.regionId);
        if (idx < 0) return t;
        const src = t.regions[idx];
        const durA = a.bufA.duration * 1000;
        const left:  StudioRegion = { ...src, buffer: a.bufA, peaks: a.peaksA, trimStartMs: 0, trimEndMs: 0, fadeOutMs: 0 };
        const right: StudioRegion = { ...src, id: a.newRightId, buffer: a.bufB, peaks: a.peaksB, offsetMs: src.offsetMs + durA, trimStartMs: 0, trimEndMs: 0, fadeInMs: 0 };
        const regions = [...t.regions];
        regions.splice(idx, 1, left, right);
        return { ...t, regions };
      }) };
    }
    case "MERGE_REGIONS": {
      return { ...s, tracks: s.tracks.map(t => {
        if (t.id !== a.trackId) return t;
        const idSet = new Set(a.ids);
        const first = t.regions.find(r => idSet.has(r.id));
        if (!first) return t;
        const merged: StudioRegion = {
          ...first,
          id: a.newId,
          buffer: a.buffer, peaks: a.peaks,
          offsetMs: a.offsetMs, trimStartMs: 0, trimEndMs: 0,
          fadeInMs: a.fadeInMs, fadeOutMs: a.fadeOutMs,
        };
        const regions = [...t.regions.filter(r => !idSet.has(r.id)), merged]
          .sort((x, y) => x.offsetMs - y.offsetMs);
        return { ...t, regions };
      }) };
    }
    case "ADD_AUTOMATION_LANE": {
      return { ...s, tracks: s.tracks.map(t => t.id === a.trackId
        ? { ...t, automationOpen: true, automationLanes: [...t.automationLanes, { id: uuid(), param: a.param, points: [] }] }
        : t) };
    }
    case "REMOVE_AUTOMATION_LANE": {
      return { ...s, tracks: s.tracks.map(t => t.id === a.trackId
        ? { ...t, automationLanes: t.automationLanes.filter(l => l.id !== a.laneId) }
        : t) };
    }
    case "SET_AUTOMATION_PARAM": {
      return { ...s, tracks: s.tracks.map(t => t.id === a.trackId
        ? mapLane(t, a.laneId, l => ({ ...l, param: a.param, points: [] /* clear when changing param */ }))
        : t) };
    }
    case "ADD_AUTO_POINT": {
      return { ...s, tracks: s.tracks.map(t => t.id === a.trackId
        ? mapLane(t, a.laneId, l => ({ ...l, points: [...l.points, a.point].sort((x, y) => x.timeMs - y.timeMs) }))
        : t) };
    }
    case "MOVE_AUTO_POINT": {
      return { ...s, tracks: s.tracks.map(t => t.id === a.trackId
        ? mapLane(t, a.laneId, l => ({
            ...l,
            points: l.points
              .map(p => p.id === a.pointId ? { ...p, timeMs: Math.max(0, a.timeMs), value: a.value } : p)
              .sort((x, y) => x.timeMs - y.timeMs),
          }))
        : t) };
    }
    case "DELETE_AUTO_POINT": {
      return { ...s, tracks: s.tracks.map(t => t.id === a.trackId
        ? mapLane(t, a.laneId, l => ({ ...l, points: l.points.filter(p => p.id !== a.pointId) }))
        : t) };
    }
    case "ADD_MARKER": {
      return { ...s, markers: [...s.markers, a.marker].sort((x, y) => x.timeMs - y.timeMs) };
    }
    case "DELETE_MARKER": {
      return { ...s, markers: s.markers.filter(m => m.id !== a.id) };
    }
    case "RENAME_MARKER": {
      return { ...s, markers: s.markers.map(m => m.id === a.id ? { ...m, label: a.label } : m) };
    }
    case "DUPLICATE_REGION": {
      return { ...s, tracks: s.tracks.map(t => {
        if (t.id !== a.trackId) return t;
        const src = t.regions.find(r => r.id === a.regionId);
        if (!src) return t;
        const dup: StudioRegion = { ...src, id: a.newId, offsetMs: Math.max(0, a.offsetMs) };
        return { ...t, regions: [...t.regions, dup] };
      }) };
    }
    case "PASTE_REGION": {
      return { ...s, tracks: s.tracks.map(t => {
        if (t.id !== a.trackId) return t;
        return { ...t, regions: [...t.regions, { ...a.region, offsetMs: Math.max(0, a.offsetMs) }] };
      }) };
    }
    case "AUTO_CROSSFADE": {
      return { ...s, tracks: s.tracks.map(t => {
        if (t.id !== a.trackId) return t;
        return { ...t, regions: t.regions.map(r => {
          const u = a.updates.find(x => x.regionId === r.id);
          if (!u) return r;
          return {
            ...r,
            ...(u.fadeInMs  !== undefined ? { fadeInMs:  u.fadeInMs  } : {}),
            ...(u.fadeOutMs !== undefined ? { fadeOutMs: u.fadeOutMs } : {}),
          };
        }) };
      }) };
    }
    case "REPLACE": {
      return { ...s, tracks: a.tracks };
    }
  }
}

// ── Props ────────────────────────────────────────────────────────

interface Props {
  deckAPath:  string | null;
  deckATitle: string | undefined;
  deckBPath:  string | null;
  deckBTitle: string | undefined;
  stationId:  number;   // active station — for chop-and-send (imaging pools + the real deck-load path)
}

// "smart" is the default: no mandatory tool-switching. The pointer's position within a clip
// picks the gesture (trim / I-beam / grab / fade / crossfade). The five named tools survive
// as EXPLICIT overrides — pick one and it wins everywhere, press it again to fall back to smart.
type EditTool = "smart" | "select" | "grab" | "blade" | "trim" | "fade";

// ── Smart-tool zones ──────────────────────────────────────────────
// Bands are measured from the clip's own box. Every band is clamped against clip width so a
// two-second clip doesn't become all-corner-and-no-body.
type SmartZone = "trim-l" | "trim-r" | "fade-in" | "fade-out" | "xfade-l" | "xfade-r" | "ibeam" | "move";

const SMART_EDGE_W       = 8;    // left/right trim band
const SMART_CORNER_W     = 14;   // top-corner fade handle
const SMART_CORNER_H     = 14;
const SMART_XFADE_H      = 8;    // bottom band, only where a neighbour abuts
const SMART_XFADE_GAP_MS = 120;  // how close a neighbour must sit to offer a crossfade

/** ONE threshold for every overlay drawn on a clip — borders, wedges, handles, markers.
 *  Below this clip width they render NOTHING. Hand-tuned per-element thresholds are how a 14px
 *  white wedge ended up painted across a 6px clip; there is one number now and everything passes
 *  through it. The cursor still carries the meaning at any width. */
const OVERLAY_VISIBILITY_THRESHOLD_PX = 16;

/** How far beyond the visible window a clip's waveform canvas still renders, in CSS px.
 *  Wide enough that a normal scroll or wheel-zoom does not expose an unpainted edge; small enough
 *  that the canvas stays far below the driver's per-dimension limit at any zoom. */
const VIEWPORT_RENDER_MARGIN_PX = 400;

/** ── Zoomed-in detail peaks ────────────────────────────────────────────────
 *
 *  `region.peaks` is a FIXED 2000 samples for any clip length (extractPeaks, :433 — a private
 *  copy of the shared one; see the dedup item in docs/backlog.md). A 243-second clip therefore
 *  carries one peak per 122ms, and at zoom 8 a 1652px slice spans 1.06% of it — 21 texels stretched
 *  across 1652 pixels. That is the "blocky bars" starvation, and no mip level can fix it: level 0
 *  is already the finest thing that exists.
 *
 *  When the coarse array runs out of resolution we re-extract the VISIBLE SLICE ONLY from the
 *  decoded AudioBuffer at the density the screen can actually show. Same discipline as the viewport
 *  slice: never the whole clip.
 */
/** Mode thresholds, in samples per device pixel.
 *  Below SAMPLE_MODE_SPP there are so few samples per pixel that a bar chart is a lie about the
 *  signal — draw the actual trace. Below PEAKRMS_MODE_SPP a bucket still holds enough samples for
 *  min/max and RMS to mean something. Above it, the mip path, which is the only one cheap enough
 *  for a whole song on screen. */
const SAMPLE_MODE_SPP   = 2;
const PEAKRMS_MODE_SPP  = 4000;
const SAMPLE_MAX_POINTS = 32_768;

const DETAIL_BARS_PER_DEVICE_PX = 2;
const DETAIL_MAX_RESOLUTION     = 8192;
const DETAIL_MAX_SAMPLES        = 4_000_000;  // ~90s @44.1k — beyond this the coarse array stands
const detailCache = new Map<string, WaveDetail>();
const DETAIL_CACHE_MAX = 24;

/** Cache keyed on everything that changes the samples: trim and splice both mint new buffers or new
 *  trim bounds, so a mutated region can never read a stale array. */
function sliceDetailCached(
  region: StudioRegion, tStart: number, tEnd: number, resolution: number,
  kind: "samples" | "envelope", make: () => WaveDetail | null,
): WaveDetail | null {
  const buf = region.buffer;
  if (!buf || tEnd <= tStart) return null;
  const key = `${kind}|${region.id}|${region.trimStartMs}|${region.trimEndMs}|${buf.length}`
            + `|${tStart.toFixed(6)}|${tEnd.toFixed(6)}|${resolution}`;
  const hit = detailCache.get(key);
  if (hit) return hit;
  const made = make();
  if (!made) return null;
  if (detailCache.size >= DETAIL_CACHE_MAX) {
    const oldest = detailCache.keys().next().value;
    if (oldest !== undefined) detailCache.delete(oldest);
  }
  detailCache.set(key, made);
  return made;
}

function smartZoneAt(
  x: number, y: number, w: number, h: number,
  abutsLeft: boolean, abutsRight: boolean,
): SmartZone {
  const edge   = Math.min(SMART_EDGE_W,   Math.max(2, w * 0.2));
  const corner = Math.min(SMART_CORNER_W, Math.max(3, w * 0.25));
  // Most specific first: corners beat edges, edges beat the body.
  if (y <= SMART_CORNER_H) {
    if (x <= corner)     return "fade-in";
    if (x >= w - corner) return "fade-out";
  }
  if (y >= h - SMART_XFADE_H) {
    if (abutsLeft  && x <= corner)     return "xfade-l";
    if (abutsRight && x >= w - corner) return "xfade-r";
  }
  if (x <= edge)     return "trim-l";
  if (x >= w - edge) return "trim-r";
  return y <= h / 2 ? "ibeam" : "move";
}

const SMART_CURSOR: Record<SmartZone, string> = {
  "trim-l":   "ew-resize",
  "trim-r":   "ew-resize",
  "fade-in":  "nesw-resize",
  "fade-out": "nwse-resize",
  "xfade-l":  "col-resize",
  "xfade-r":  "col-resize",
  "ibeam":    "text",
  "move":     "grab",
};
type FxWindowType = "eq" | "comp" | "reverb";

const FX_WINDOW_LABELS: Record<FxWindowType, string> = {
  eq:     "7-Band EQ",
  comp:   "Compressor",
  reverb: "Reverb / Saturation / Sidechain",
};

// Default offsets so different window types don't pile up on each other when opened together
const FX_WINDOW_DEFAULT_X: Record<FxWindowType, number> = { eq: 100, comp: 440, reverb: 780 };

// ── Per-track audio param set returned by buildAndStart ───────────
interface TrackAudioParams {
  trackGainParam: AudioParam;
  panParam:       AudioParam;
  eqGainParams:   AudioParam[];   // 7 entries
  compThresholdParam?: AudioParam;
  reverbWetParam: AudioParam;
  compNode?:      DynamicsCompressorNode;   // for reduction metering (live only)
  // ── STALE-GRAPH FIX (Phase 1, 2026-08-16) ────────────────────────────────────────────────────
  // These nodes were built into the graph and then never referenced again, so the live-patch effect
  // had nothing to write to. Turning Ratio, Attack, Release or Makeup, changing reverb Type or Size,
  // or moving saturation Drive did nothing audible until the graph was torn down and rebuilt on the
  // next play: the knob moved, the readout changed, the sound did not. Holding the references here
  // is the whole fix — no new nodes, no graph change, nothing added to the audio path.
  compMakeupParam?: AudioParam;      // makeup gain after the compressor
  satShaper?:       WaveShaperNode;  // curve regenerated when drive changes
  reverbConv?:      ConvolverNode;   // IR regenerated when type/size change
}

// ── Main component ───────────────────────────────────────────────

const NOTE_COLORS = ["#f59e0b", "#3b82f6", "#10b981", "#ef4444"];

export default function StudioPro({ deckAPath, deckATitle, deckBPath, deckBTitle, stationId }: Props) {
  const currentUser = useUser();
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    tracks: studioCache?.tracks ?? [
      newTrack("Track 1", PALETTE[0]),
      newTrack("Track 2", PALETTE[1]),
    ],
    markers: studioCache?.markers ?? [],
  }));
  const tracks = state.tracks;

  // Selection (rehydrated from cache)
  const [selection, setSelection] = useState<{ trackId: string; regionId: string | null } | null>(
    () => studioCache?.selection ?? null
  );

  // Transport
  const [playing, setPlaying]         = useState(false);
  const [playheadMs, setPlayheadMs]   = useState(() => studioCache?.playheadMs ?? 0);
  const [recordArmed, setRecordArmed] = useState(false);
  const [recording, setRecording]     = useState(false);
  const [zoom, setZoom]               = useState(() => studioCache?.zoom ?? 1);
  const [bpm, setBpm]                 = useState(() => studioCache?.bpm ?? 120);
  const [vtOpen, setVtOpen]           = useState(false);
  const [editorOpen, setEditorOpen]   = useState(false);
  const [editorMode, setEditorMode]   = useState<"wave" | "eq">("wave");
  const [rowHeights, setRowHeights]   = useState<Record<string, number>>({});
  const [multiSel, setMultiSel]       = useState<{ trackId: string | null; ids: string[] }>({ trackId: null, ids: [] });
  const [status, setStatus]           = useState("");
  const [paletteForTrack, setPaletteForTrack] = useState<string | null>(null);

  // Edit tool
  const [tool, setTool] = useState<EditTool>("smart");
  const [bladeHover, setBladeHover] = useState<{ trackId: string; regionId: string; ms: number } | null>(null);
  const [snapMs, setSnapMs] = useState<number | null>(null);

  // Master bus (rehydrated from cache)
  const [masterGainDb, setMasterGainDb] = useState(() => studioCache?.masterGainDb ?? 0);
  const [limiterEnabled, setLimiterEnabled] = useState(() => studioCache?.limiterEnabled ?? true);
  const [limiterThresh, setLimiterThresh] = useState(() => studioCache?.limiterThresh ?? -1);
  const [masterEq7, setMasterEq7] = useState<number[]>(() => studioCache?.masterEq7 ?? Array(EQ_BANDS).fill(0));
  const [masterComp, setMasterComp] = useState<TrackCompressor>(() => studioCache?.masterComp ?? {
    on: false, threshold: -12, ratio: 2, attack: 30, release: 250, makeup: 0,
  });

  // Loop / click / grid (rehydrated)
  const [loopRange, setLoopRange] = useState<{ startMs: number; endMs: number } | null>(() => studioCache?.loopRange ?? null);
  const [loopEnabled, setLoopEnabled] = useState(() => studioCache?.loopEnabled ?? false);
  const [clickEnabled, setClickEnabled] = useState(() => studioCache?.clickEnabled ?? false);
  const [gridEnabled, setGridEnabled] = useState(() => studioCache?.gridEnabled ?? false);

  // Master FX window state
  const [masterFxOpen, setMasterFxOpen] = useState(false);
  const [masterFxPos, setMasterFxPos]   = useState<{ x: number; y: number; z: number }>({ x: 200, y: 80, z: 0 });

  // Snapshots (rehydrated)
  const [snapshots, setSnapshots] = useState<MixerSnapshot[]>(() => studioCache?.snapshots ?? []);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  // Library search import (2026-07-22) — same title/artist search the Library uses; results drag onto any
  // track/timeline and resolve via the standard path (local or R2, like a deck load). Complements + Import.
  const [libQ, setLibQ] = useState("");
  const [libResults, setLibResults] = useState<any[]>([]);
  const [libOpen, setLibOpen] = useState(false);
  const libAnchorRef = useRef<HTMLDivElement>(null);   // for the portal dropdown (toolbar clips overflow)
  const libDropRef = useRef<HTMLDivElement>(null);
  // Close the search dropdown on an outside click — via a document listener, NOT a full-screen backdrop
  // div (a backdrop over the timeline intercepts the drag → the "red circle" / can't drop on a track).
  useEffect(() => {
    if (!libOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (libAnchorRef.current?.contains(t) || libDropRef.current?.contains(t)) return;
      setLibOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [libOpen]);
  const runLibSearch = useCallback(async (q: string) => {
    setLibQ(q);
    if (!q.trim()) { setLibResults([]); setLibOpen(false); return; }
    try {
      const rows = await query(
        `SELECT s.id, s.title, a.name AS artist, s.file_path, s.file_key FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
          WHERE s.deleted_at IS NULL AND s.file_path IS NOT NULL AND (s.title LIKE ? OR a.name LIKE ?) ORDER BY s.title LIMIT 40`,
        [`%${q.trim()}%`, `%${q.trim()}%`]
      );
      setLibResults(Array.isArray(rows) ? rows : []); setLibOpen(true);
    } catch { setLibResults([]); }
  }, []);

  // Session version control
  const [sessionId, setSessionId]           = useState<string>(() => uuid());
  const [sessionName, setSessionName]       = useState("Untitled Session");
  const [sessionNameEditing, setSessionNameEditing] = useState(false);
  const [versions, setVersions]             = useState<SessionVersion[]>([]);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null);
  const sessionNameInputRef = useRef<HTMLInputElement>(null);

  // Collaboration notes
  const [notes, setNotes]                   = useState<StudioNote[]>([]);
  const [notesOpen, setNotesOpen]           = useState(false);
  const [noteInput, setNoteInput]           = useState<{ posMs: number; x: number; y: number } | null>(null);
  const [noteInputText, setNoteInputText]   = useState("");
  const [notePopover, setNotePopover]       = useState<string | null>(null); // note id

  // Keyboard help overlay
  const [helpOpen, setHelpOpen] = useState(false);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  const [wmDialogPath, setWmDialogPath]     = useState<string | null>(null);
  const [wmResult, setWmResult]             = useState<any>(null);
  const [wmVerifying, setWmVerifying]       = useState(false);
  const [exportWmDialog, setExportWmDialog] = useState<{ resolve: (v: boolean) => void } | null>(null);

  // Right-click context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: { label: string; onClick: () => void; danger?: boolean; separator?: boolean }[] } | null>(null);

  // FX windows: keyed by `${trackId}:${type}`. One window per (track, type).
  // type ∈ "eq" | "comp" | "reverb". The reverb window also holds sidechain + saturation.
  const [openFxWindows, setOpenFxWindows] = useState<Map<string, { trackId: string; type: FxWindowType; x: number; y: number; z: number }>>(new Map());
  const fxZRef = useRef(1);

  // Selected automation point — for visual highlight + delete
  const [selectedAutoPoint, setSelectedAutoPoint] = useState<{ trackId: string; laneId: string; pointId: string } | null>(null);

  // Live recording
  const liveRecRef = useRef<{
    trackId: string; startMs: number; startedAt: number;
    peaks: number[]; samplePeriodMs: number;
    analyser: AnalyserNode; source: MediaStreamAudioSourceNode; rafId: number;
  } | null>(null);
  const [liveRecTick, setLiveRecTick] = useState(0);

  // Audio engine refs
  const audioCtxRef        = useRef<AudioContext | null>(null);
  const sourcesRef         = useRef<AudioBufferSourceNode[]>([]);
  const trackAnalysersRef  = useRef<Map<string, AnalyserNode>>(new Map());
  const trackParamsRef     = useRef<Map<string, TrackAudioParams>>(new Map());
  const masterAnalyserRef  = useRef<AnalyserNode | null>(null);
  const masterLAnalyserRef = useRef<AnalyserNode | null>(null);
  const masterRAnalyserRef = useRef<AnalyserNode | null>(null);
  const masterKWeightedRef = useRef<AnalyserNode | null>(null);
  const sidechainGainsRef  = useRef<Map<string, GainNode>>(new Map());
  const sidechainFollowRef = useRef<Map<string, AnalyserNode>>(new Map());
  const compReductionRef   = useRef<Map<string, number>>(new Map());   // trackId → current dB reduction
  const lufsMomentaryRef   = useRef<number>(-Infinity);
  const correlationRef     = useRef<number>(0);
  const meterLevelsRef     = useRef<{ master: number; perTrack: Map<string, number> }>({
    master: 0, perTrack: new Map(),
  });
  const [, setMeterTick]   = useState(0);
  // Which pane is showing in each dock column (phase b). Static tabs became real here; full
  // dockview drag/dock/save is the remaining piece of (b) and is tracked in the delta table.
  const [rightPane, setRightPane] = useState<"Inspector" | "Mixer">("Inspector");
  const [leftPane,  setLeftPane]  = useState<"Tracks" | "Library">("Tracks");
  const rafRef             = useRef<number | null>(null);
  const playStartRef       = useRef<number>(0);
  const playheadMsRef      = useRef(0);
  const playFromRef        = useRef<number>(0);
  const timelineRef        = useRef<HTMLDivElement>(null);
  const headerScrollRef    = useRef<HTMLDivElement>(null);
  const scrollSyncing      = useRef(false);
  const recRef             = useRef<{ mr: MediaRecorder; chunks: Blob[]; trackId: string; startMs: number } | null>(null);
  const stateRef           = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // ── Auto-crossfade on overlap ─────────────────────────────────
  // When two regions on the same track overlap, set both regions' fades to
  // match the overlap duration. Recomputes lazily on tracks change. We avoid
  // dispatching when no change is needed to prevent a render loop.
  const crossfadeRunningRef = useRef(false);
  useEffect(() => {
    if (crossfadeRunningRef.current) return;
    crossfadeRunningRef.current = true;
    try {
      for (const t of state.tracks) {
        const sorted = [...t.regions]
          .filter(r => r.buffer)
          .map(r => ({ id: r.id, start: r.offsetMs, end: r.offsetMs + regionDurMs(r) }))
          .sort((a, b) => a.start - b.start);
        const updates: { regionId: string; fadeInMs?: number; fadeOutMs?: number }[] = [];
        // First pass: clear any existing auto-fades. We only set fades from overlaps.
        // But we shouldn't blow away USER-set fades. Heuristic: only adjust fades
        // when an overlap exists; never reduce a user's larger fade.
        for (let i = 0; i < sorted.length - 1; i++) {
          const cur  = sorted[i];
          const next = sorted[i + 1];
          const overlap = cur.end - next.start;
          if (overlap > 50) {
            const xfade = Math.min(overlap, 2000);     // cap at 2s
            const cReg = t.regions.find(r => r.id === cur.id)!;
            const nReg = t.regions.find(r => r.id === next.id)!;
            if (cReg.fadeOutMs < xfade) updates.push({ regionId: cur.id,  fadeOutMs: xfade });
            if (nReg.fadeInMs  < xfade) updates.push({ regionId: next.id, fadeInMs:  xfade });
          }
        }
        if (updates.length > 0) {
          dispatch({ type: "AUTO_CROSSFADE", trackId: t.id, updates });
        }
      }
    } finally {
      crossfadeRunningRef.current = false;
    }
  }, [state.tracks]);

  // ── Stop playback + recording on unmount, but KEEP state in cache ──
  useEffect(() => {
    return () => {
      sourcesRef.current.forEach(s => { try { s.stop(); } catch {} });
      sourcesRef.current = [];
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (recRef.current) { try { recRef.current.mr.stop(); } catch {} }
      if (liveRecRef.current) {
        cancelAnimationFrame(liveRecRef.current.rafId);
        try { liveRecRef.current.source.disconnect(); } catch {}
        liveRecRef.current = null;
      }
    };
  }, []);

  // ── Persist to module-level cache so unmount/remount doesn't wipe ──
  useEffect(() => {
    studioCache = {
      tracks: state.tracks,
      markers: state.markers,
      masterGainDb, limiterEnabled, limiterThresh, masterEq7, masterComp,
      bpm, zoom,
      loopRange, loopEnabled, clickEnabled, gridEnabled,
      playheadMs, selection,
      snapshots,
    };
  }, [
    state.tracks, state.markers,
    masterGainDb, limiterEnabled, limiterThresh, masterEq7, masterComp,
    bpm, zoom, loopRange, loopEnabled, clickEnabled, gridEnabled, playheadMs, selection,
    snapshots,
  ]);

  // ── Auto-save every 5 min to localStorage + DB ───────────────
  useEffect(() => {
    const id = setInterval(() => {
      try {
        const tracksJson = state.tracks.map(t => ({
          ...t,
          regions: t.regions
            .filter(r => r.filePath && !r.filePath.startsWith("blob:"))
            .map(r => ({
              id: r.id, filePath: r.filePath,
              offsetMs: r.offsetMs, trimStartMs: r.trimStartMs, trimEndMs: r.trimEndMs,
              fadeInMs: r.fadeInMs, fadeOutMs: r.fadeOutMs, clipGainDb: r.clipGainDb,
            })),
        }));
        const data = JSON.stringify({
          version: 1, savedAt: Date.now(),
          tracks: tracksJson, markers: state.markers,
          master: { masterGainDb, limiterEnabled, limiterThresh, masterEq7, masterComp },
          bpm, zoom,
        });
        localStorage.setItem("studiopro_autosave", data);
      } catch {}
      // Also persist to DB version history silently
      saveVersion(AUTOSAVE_LABEL, true);
    }, 5 * 60 * 1000);
    return () => clearInterval(id);
  // saveVersion is stable (useCallback). Including it would re-create the interval on every
  // version save, which we don't want — intentionally excluded.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tracks, state.markers, masterGainDb, limiterEnabled, limiterThresh, masterEq7, masterComp, bpm, zoom]);

  // Click scheduler refs
  const clickNextBeatTimeRef = useRef<number>(0);
  const clickNextBeatIdxRef  = useRef<number>(0);
  const clickEnabledRef      = useRef(clickEnabled);
  useEffect(() => { clickEnabledRef.current = clickEnabled; }, [clickEnabled]);
  const bpmRef = useRef(bpm);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);

  // Base lane height per track (resizable via the row drag-handle), default TRACK_H.
  const rowBaseHeights = useMemo(
    () => tracks.map(t => rowHeights[t.id] ?? TRACK_H),
    [tracks, rowHeights],
  );
  // Track height (base + automation lanes when expanded)
  const trackHeights = useMemo(() => tracks.map((t, i) =>
    rowBaseHeights[i] + (t.automationOpen ? AUTOMATION_BAR_H + t.automationLanes.length * AUTOMATION_LANE_H : 0)
  ), [tracks, rowBaseHeights]);
  const trackTops = useMemo(() => {
    const tops: number[] = [];
    let acc = 0;
    for (const h of trackHeights) { tops.push(acc); acc += h; }
    return tops;
  }, [trackHeights]);
  const totalLanesHeight = useMemo(() => trackHeights.reduce((a, b) => a + b, 0), [trackHeights]);

  // Keep the track-header column and the timeline lanes scrolling as one row.
  const syncScroll = useCallback((from: "header" | "timeline") => {
    if (scrollSyncing.current) return;
    const h = headerScrollRef.current, tl = timelineRef.current;
    if (!h || !tl) return;
    scrollSyncing.current = true;
    if (from === "timeline") h.scrollTop = tl.scrollTop;
    else tl.scrollTop = h.scrollTop;
    requestAnimationFrame(() => { scrollSyncing.current = false; });
  }, []);

  // Drag a track row's bottom edge to resize its height (focus a waveform).
  const beginRowResize = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const startH = rowHeights[id] ?? TRACK_H;
    const mv = (ev: MouseEvent) => {
      const next = Math.max(48, Math.min(400, startH + (ev.clientY - startY)));
      setRowHeights(prev => ({ ...prev, [id]: next }));
    };
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
  }, [rowHeights]);

  // Region selection — shift/ctrl/cmd-click adds to a multi-selection (same track).
  const handleRegionSelect = useCallback((trackId: string, regionId: string, additive: boolean) => {
    setSelection({ trackId, regionId });
    setMultiSel(prev => {
      if (additive && prev.trackId === trackId) {
        const ids = prev.ids.includes(regionId)
          ? prev.ids.filter(x => x !== regionId)
          : [...prev.ids, regionId];
        return { trackId, ids };
      }
      return { trackId, ids: [regionId] };
    });
  }, []);

  // Merge the selected adjacent segments on a track into a single clip.
  const mergeRegions = useCallback((trackId: string, ids: string[]) => {
    const t = stateRef.current.tracks.find(x => x.id === trackId);
    if (!t) return;
    const regs = t.regions
      .filter(r => ids.includes(r.id) && r.buffer)
      .sort((a, b) => a.offsetMs - b.offsetMs);
    if (regs.length < 2) return;

    const ctx = getCtx();
    const sr = regs[0].buffer!.sampleRate;
    const numCh = Math.max(...regs.map(r => r.buffer!.numberOfChannels));
    const slices = regs.map(r => {
      const buf = r.buffer!;
      const startF = Math.floor((r.trimStartMs / 1000) * buf.sampleRate);
      const endF = Math.floor(((buf.duration * 1000 - r.trimEndMs) / 1000) * buf.sampleRate);
      return { buf, startF, endF: Math.max(startF, endF) };
    });
    const totalFrames = slices.reduce((acc, s) => acc + (s.endF - s.startF), 0);
    if (totalFrames <= 0) return;
    const out = ctx.createBuffer(numCh, totalFrames, sr);
    for (let ch = 0; ch < numCh; ch++) {
      const od = out.getChannelData(ch);
      let pos = 0;
      for (const s of slices) {
        const srcCh = ch < s.buf.numberOfChannels ? s.buf.getChannelData(ch) : s.buf.getChannelData(0);
        for (let f = s.startF; f < s.endF; f++) od[pos++] = srcCh[f] || 0;
      }
    }
    const peaks = extractPeaks(out);
    const newId = uuid();
    dispatch({
      type: "MERGE_REGIONS", trackId, ids, buffer: out, peaks, newId,
      offsetMs: regs[0].offsetMs,
      fadeInMs: regs[0].fadeInMs,
      fadeOutMs: regs[regs.length - 1].fadeOutMs,
    });
    setSelection({ trackId, regionId: newId });
    setMultiSel({ trackId, ids: [newId] });
    setStatus(`✓ Merged ${regs.length} clips`);
  }, []);

  // Track colors follow row position: 1st track = PALETTE[0], 2nd = PALETTE[1], …
  // This is the single source of color for rendering (headers, lanes, waveforms,
  // inspector), overriding any color stored in an older saved session.
  const coloredTracks = useMemo(
    () => tracks.map((t, i) => {
      const c = PALETTE[i % PALETTE.length];
      return t.color === c ? t : { ...t, color: c };
    }),
    [tracks],
  );

  const pps = BASE_PPS * zoom;
  const msToX = useCallback((ms: number) => (ms / 1000) * pps, [pps]);
  const xToMs = useCallback((x: number) => (x / pps) * 1000, [pps]);

  const getCtx = () => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext({ sampleRate: 44100 });
    return audioCtxRef.current;
  };

  const totalDurMs = useMemo(() => {
    let max = 60000;
    for (const t of tracks) {
      const e = trackEndMs(t);
      if (e > max) max = e;
    }
    return max;
  }, [tracks]);

  /** The live zoom ceiling — MAX_ZOOM unless this session is long enough that it would blow past
   *  the browser's element-width limit first. Recomputed as the session grows. */
  const maxZoom = useMemo(() => {
    const totalSec = Math.max(1, totalDurMs / 1000);
    return clamp(MAX_CONTENT_PX / (totalSec * BASE_PPS), 1, MAX_ZOOM);
  }, [totalDurMs]);
  // Read through a ref inside the wheel and keydown handlers: both are long-lived listeners, and
  // closing over the value would freeze the ceiling at whatever the session length was on mount.
  const maxZoomRef = useRef(maxZoom);
  useEffect(() => { maxZoomRef.current = maxZoom; }, [maxZoom]);

  /** Fit-to-window: the session's whole duration spans the visible editor width.
   *  The focal point is the PLAYHEAD (song centre when the playhead is parked at 0) — on a session
   *  too long to fit even at MIN_ZOOM, the view centres on where you were working instead of
   *  snapping to the left edge and losing your place. */
  const fitToWindow = useCallback(() => {
    const el = timelineRef.current;
    if (!el) return;
    const width = el.clientWidth;
    if (!width) return;
    const end = Math.max(1000, totalDurMs);
    const next = clamp((width * 1000) / (end * BASE_PPS), MIN_ZOOM, maxZoom);
    const focusMs = playheadMs > 0 && playheadMs <= end ? playheadMs : end / 2;
    setZoom(next);
    requestAnimationFrame(() => {
      const e2 = timelineRef.current;
      if (!e2) return;
      const focusX = (focusMs / 1000) * (BASE_PPS * next);
      e2.scrollLeft = Math.max(0, focusX - e2.clientWidth / 2);
    });
  }, [totalDurMs, playheadMs, maxZoom]);

  /** The visible horizontal window of the timeline, in content pixels.
   *
   *  This exists because a clip's canvas cannot be the width of the clip. At full zoom a
   *  three-minute song is ~160,000px wide, which is past every driver's MAX_TEXTURE_SIZE — the
   *  draw then fails SILENTLY and the clip paints nothing. Clips now render only the slice of
   *  themselves that is on screen, so canvas width is bounded by the window, not by the song. */
  const [viewport, setViewport] = useState({ left: 0, width: 0 });
  const syncViewport = useCallback(() => {
    const el = timelineRef.current;
    if (!el) return;
    setViewport(prev => {
      const left = el.scrollLeft, width = el.clientWidth;
      // Only commit meaningful movement — a scroll event per pixel would re-render every lane.
      if (Math.abs(prev.left - left) < 32 && prev.width === width) return prev;
      return { left, width };
    });
  }, []);
  // Zoom changes content width without firing a scroll event, so re-measure on pps too.
  useEffect(() => { syncViewport(); }, [pps, syncViewport]);
  useEffect(() => {
    const el = timelineRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncViewport());
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncViewport]);

  const anySolo = useMemo(() => tracks.some(t => t.solo), [tracks]);

  const selectedTrack = useMemo(
    () => selection ? coloredTracks.find(t => t.id === selection.trackId) || null : null,
    [coloredTracks, selection],
  );
  const selectedRegion = useMemo(() => {
    if (!selectedTrack || !selection?.regionId) return null;
    return selectedTrack.regions.find(r => r.id === selection.regionId) || null;
  }, [selectedTrack, selection]);

  // ── Load audio into a track ───────────────────────────────────

  const loadAudio = useCallback(async (
    trackId: string, filePath: string,
    opts: { title?: string; atMs?: number; replaceAll?: boolean } = {},
  ) => {
    const name = filePath.split(/[\\/]/).pop() || filePath;
    setStatus(`Loading ${opts.title || name}...`);
    try {
      const ctx = getCtx();
      const url = filePath.startsWith("http") || filePath.startsWith("blob:") ? filePath : convertFileSrc(filePath);
      const resp = await fetch(url);
      const ab = await resp.arrayBuffer();
      const buffer = await ctx.decodeAudioData(ab);
      const peaks = extractPeaks(buffer);
      const t = stateRef.current.tracks.find(t => t.id === trackId);
      const atMs = opts.atMs ?? (t && !opts.replaceAll ? trackEndMs(t) : 0);
      const region = newRegion({ buffer, peaks, filePath, offsetMs: atMs });
      dispatch({ type: "ADD_REGION", trackId, region, replaceAll: !!opts.replaceAll });
      if (opts.title) dispatch({ type: "UPDATE_TRACK", id: trackId, patch: { name: opts.title } });
      setStatus(`✓ Loaded: ${opts.title || name}`);
    } catch (e: any) {
      setStatus(`✗ Failed: ${e?.message || e}`);
    }
  }, []);

  useEffect(() => {
    if (deckAPath && tracks[0]) loadAudio(tracks[0].id, deckAPath, { title: deckATitle, replaceAll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckAPath]);
  useEffect(() => {
    if (deckBPath && tracks[1]) loadAudio(tracks[1].id, deckBPath, { title: deckBTitle, replaceAll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckBPath]);

  // ── Custom events ─────────────────────────────────────────────

  useEffect(() => {
    const onSend = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (!d.filePath) return;
      if (d.trackId) {
        loadAudio(d.trackId as string, d.filePath, { title: d.title });
        return;
      }
      const emptyTrack = (stateRef.current?.tracks || []).find(t => t.regions.length === 0);
      if (emptyTrack) {
        loadAudio(emptyTrack.id, d.filePath, { title: d.title });
      } else {
        dispatch({ type: "ADD_TRACK" });
        setTimeout(() => {
          const newest = (stateRef.current?.tracks || []).slice(-1)[0];
          if (newest) loadAudio(newest.id, d.filePath, { title: d.title });
        }, 0);
      }
    };
    const onLoadDeck = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (!d.filePath) return;
      const idx = d.deck === "A" ? 0 : d.deck === "B" ? 1 : d.deck === "C" ? 2 : 0;
      while ((stateRef.current?.tracks.length || 0) <= idx) dispatch({ type: "ADD_TRACK" });
      setTimeout(() => {
        const t = stateRef.current?.tracks[idx];
        if (t) loadAudio(t.id, d.filePath, { title: d.title });
      }, 0);
    };
    window.addEventListener("ether:send-to-studio", onSend as EventListener);
    window.addEventListener("ether:studio-load-deck", onLoadDeck as EventListener);
    return () => {
      window.removeEventListener("ether:send-to-studio", onSend as EventListener);
      window.removeEventListener("ether:studio-load-deck", onLoadDeck as EventListener);
    };
  }, [loadAudio]);

  // ── Pop-out window bridges (Show+ DAW runs as its own window) ──────────────────
  // (a) Report dirty to main so the window's close-guard can warn before discarding uncommitted
  //     regions. Dirty = any track holds ≥1 loaded region (the session is not persisted, so any
  //     loaded audio is by definition uncommitted until it's sent to a deck / library / pool).
  const studioDirty = state.tracks.some(t => t.regions.length > 0);
  useEffect(() => {
    try { (window as any).ether?.invoke?.("studio:set-dirty", studioDirty); } catch { /* not in electron */ }
  }, [studioDirty]);

  // (b) Confirm-close from the main-process guard → in-app confirm → force-close.
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.on) return;
    const h = ether.on("studio:confirm-close", () => {
      const ok = window.confirm("Discard this Show+ session?\n\nRegions you haven't sent to a deck, the Library, or a jingle/sweeper pool will be lost.");
      if (ok) { try { ether.invoke("studio:force-close"); } catch { /* ignore */ } }
    });
    return () => { try { ether.off("studio:confirm-close", h); } catch { /* ignore */ } };
  }, []);

  // (c) Cross-window Send-to-Studio: the main window forwards a track over IPC; re-dispatch the
  //     same DOM event the in-window handler already consumes, so load logic stays in one place.
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.on) return;
    const h = ether.on("studio:load-track", (detail: any) => {
      try { window.dispatchEvent(new CustomEvent("ether:send-to-studio", { detail })); } catch { /* ignore */ }
    });
    return () => { try { ether.off("studio:load-track", h); } catch { /* ignore */ } };
  }, []);

  // ── Undo / Redo ───────────────────────────────────────────────

  const historyRef = useRef<{ past: StudioTrack[][]; future: StudioTrack[][] }>({ past: [], future: [] });
  const lastTracksRef = useRef<StudioTrack[]>(state.tracks);

  // A drag dispatches on every mousemove. Without coalescing, one trim writes ~40 history
  // entries and Ctrl+Z walks back through the drag a pixel at a time instead of undoing it.
  // A gesture captures the pre-drag tracks once and pushes exactly one entry on mouse-up.
  const gestureRef = useRef<{ active: boolean; base: StudioTrack[] | null }>({ active: false, base: null });

  useEffect(() => {
    if (lastTracksRef.current !== state.tracks) {
      if (!gestureRef.current.active) {
        historyRef.current.past.push(lastTracksRef.current);
        if (historyRef.current.past.length > MAX_UNDO) historyRef.current.past.shift();
        historyRef.current.future = [];
      }
      lastTracksRef.current = state.tracks;
    }
  }, [state.tracks]);

  const beginGesture = useCallback(() => {
    if (gestureRef.current.active) return;
    gestureRef.current = { active: true, base: lastTracksRef.current };
  }, []);

  const endGesture = useCallback(() => {
    const g = gestureRef.current;
    gestureRef.current = { active: false, base: null };
    if (!g.active || !g.base) return;
    // A drag that moved nothing (a click that never travelled) leaves no undo entry.
    if (g.base === lastTracksRef.current) return;
    historyRef.current.past.push(g.base);
    if (historyRef.current.past.length > MAX_UNDO) historyRef.current.past.shift();
    historyRef.current.future = [];
  }, []);

  const doUndo = useCallback(() => {
    const h = historyRef.current;
    if (!h.past.length) return;
    const prev = h.past.pop()!;
    h.future.unshift(lastTracksRef.current);
    lastTracksRef.current = prev;
    dispatch({ type: "REPLACE", tracks: prev });
  }, []);
  const doRedo = useCallback(() => {
    const h = historyRef.current;
    if (!h.future.length) return;
    const nxt = h.future.shift()!;
    h.past.push(lastTracksRef.current);
    lastTracksRef.current = nxt;
    dispatch({ type: "REPLACE", tracks: nxt });
  }, []);

  // ── Blade: split region at timeline ms ────────────────────────

  const splitRegion = useCallback((trackId: string, regionId: string, atMs: number) => {
    const t = stateRef.current.tracks.find(x => x.id === trackId);
    if (!t) return;
    const r = t.regions.find(x => x.id === regionId);
    if (!r || !r.buffer) return;
    const regionStart = r.offsetMs;
    const regionEnd   = r.offsetMs + regionDurMs(r);
    const MIN = 50;
    const clamped = Math.max(regionStart + MIN, Math.min(regionEnd - MIN, atMs));
    if (clamped <= regionStart || clamped >= regionEnd) return;
    const sr    = r.buffer.sampleRate;
    const nCh   = r.buffer.numberOfChannels;
    const srcLen = r.buffer.length;
    const trimStartS = Math.floor((r.trimStartMs / 1000) * sr);
    const trimEndS   = Math.floor((r.trimEndMs   / 1000) * sr);
    const splitWithinRegionMs = clamped - regionStart;
    const splitSample = Math.max(
      trimStartS + 1,
      Math.min(srcLen - trimEndS - 1,
        trimStartS + Math.floor((splitWithinRegionMs / 1000) * sr)),
    );
    const ctx = getCtx();
    const lenA = splitSample - trimStartS;
    const lenB = (srcLen - trimEndS) - splitSample;
    if (lenA <= 0 || lenB <= 0) return;
    const bufA = ctx.createBuffer(nCh, lenA, sr);
    const bufB = ctx.createBuffer(nCh, lenB, sr);
    for (let c = 0; c < nCh; c++) {
      const src = r.buffer.getChannelData(c);
      bufA.copyToChannel(src.subarray(trimStartS, splitSample), c);
      bufB.copyToChannel(src.subarray(splitSample, srcLen - trimEndS), c);
    }
    const peaksA = extractPeaks(bufA);
    const peaksB = extractPeaks(bufB);
    const newRightId = uuid();
    dispatch({ type: "SPLIT_REGION", trackId, regionId, atMs: clamped, bufA, peaksA, bufB, peaksB, newRightId });
    setSelection({ trackId, regionId });
    setBladeHover(null);
  }, []);

  // ── Refs that bridge keydown and later-defined functions ──────

  const playRef        = useRef<(() => void) | null>(null);
  const stopRef        = useRef<(() => void) | null>(null);
  const saveVersionRef = useRef<() => void>(() => {});
  const playingRef     = useRef(false);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { playheadMsRef.current = playheadMs; }, [playheadMs]);

  // ── Keyboard ──────────────────────────────────────────────────

  // Helper used by both keyboard shortcut and context menu
  const copySelectedRegion = useCallback(() => {
    if (!selection?.regionId) return;
    const t = stateRef.current.tracks.find(x => x.id === selection.trackId);
    const r = t?.regions.find(x => x.id === selection.regionId);
    if (r) studioClipboard = { ...r };
  }, [selection]);
  const pasteAtPlayhead = useCallback(() => {
    if (!studioClipboard) return;
    const dest = selection?.trackId || stateRef.current.tracks[0]?.id;
    if (!dest) return;
    const newId = uuid();
    dispatch({ type: "PASTE_REGION", trackId: dest, offsetMs: playheadMs, region: { ...studioClipboard, id: newId } });
    setSelection({ trackId: dest, regionId: newId });
  }, [selection, playheadMs]);
  const duplicateSelectedRegion = useCallback(() => {
    if (!selection?.regionId) return;
    const t = stateRef.current.tracks.find(x => x.id === selection.trackId);
    const r = t?.regions.find(x => x.id === selection.regionId);
    if (!r) return;
    const newId = uuid();
    const offset = r.offsetMs + regionDurMs(r);
    dispatch({ type: "DUPLICATE_REGION", trackId: selection.trackId, regionId: r.id, offsetMs: offset, newId });
    setSelection({ trackId: selection.trackId, regionId: newId });
  }, [selection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      // Copy / paste / duplicate
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault(); e.stopImmediatePropagation();
        copySelectedRegion();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        e.preventDefault(); e.stopImmediatePropagation();
        pasteAtPlayhead();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault(); e.stopImmediatePropagation();
        duplicateSelectedRegion();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault(); e.stopImmediatePropagation();
        saveVersionRef.current();
        return;
      }
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if ((k === "backspace" || k === "delete")) {
        if (selectedAutoPoint) {
          e.preventDefault();
          e.stopImmediatePropagation();
          dispatch({ type: "DELETE_AUTO_POINT", trackId: selectedAutoPoint.trackId, laneId: selectedAutoPoint.laneId, pointId: selectedAutoPoint.pointId });
          setSelectedAutoPoint(null);
          return;
        }
        if (selection?.regionId) {
          e.preventDefault();
          e.stopImmediatePropagation();
          dispatch({ type: "DELETE_REGION", trackId: selection.trackId, regionId: selection.regionId });
          setSelection({ trackId: selection.trackId, regionId: null });
          return;
        }
      }
      if (e.key === " " || k === "spacebar") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (playingRef.current) stopRef.current?.(); else playRef.current?.();
        return;
      }
      // ── KEYBOARD-FIRST (Phase 2, 2026-08-16) ──────────────────────────────────────────────────
      // Before this there were FOUR global shortcuts: undo/redo, copy/paste/duplicate, delete and
      // space. Everything else was a mouse trip to a toolbar. These are additive — every one is a
      // new branch in the handler that already exists, none replaces an existing binding, and none
      // touches the audio graph. Audition/Pro Tools muscle memory where a convention exists.
      const mod = e.ctrlKey || e.metaKey;

      // S — split the selected region at the playhead
      if (k === "s" && !mod && selection?.regionId && selection.trackId) {
        e.preventDefault(); e.stopImmediatePropagation();
        splitRegion(selection.trackId, selection.regionId, playheadMs);
        return;
      }
      // Home / End — jump to start / end of session
      if (e.key === "Home" && !mod) {
        e.preventDefault(); e.stopImmediatePropagation();
        setPlayheadMs(0);
        return;
      }
      if (e.key === "End" && !mod) {
        e.preventDefault(); e.stopImmediatePropagation();
        setPlayheadMs(Math.max(0, ...state.tracks.map(trackEndMs)));
        return;
      }
      // , / . — nudge the playhead one frame (40ms) ; with Shift, one second
      if ((e.key === "," || e.key === ".") && !mod) {
        e.preventDefault(); e.stopImmediatePropagation();
        const step = e.shiftKey ? 1000 : 40;
        setPlayheadMs(p => Math.max(0, p + (e.key === "," ? -step : step)));
        return;
      }
      // \ — fit the whole session in the window ; Z — same ; Shift+Z — reset to 1x
      // The old Z formula was (30000/end)*4, which never consulted the editor's width — it could
      // not fit anything except by coincidence. Both keys now run the real fit.
      if (e.key === "\\" && !mod) {
        e.preventDefault(); e.stopImmediatePropagation();
        fitToWindow();
        return;
      }
      if (k === "z" && !mod) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.shiftKey) setZoom(1); else fitToWindow();
        return;
      }
      // + / - — zoom in / out
      if ((e.key === "+" || e.key === "=" || e.key === "-") && !mod) {
        e.preventDefault(); e.stopImmediatePropagation();
        setZoom(zv => clamp(e.key === "-" ? zv / 1.25 : zv * 1.25, MIN_ZOOM, maxZoomRef.current));
        return;
      }
      // G — toggle snap
      if (k === "g" && !mod) {
        e.preventDefault(); e.stopImmediatePropagation();
        setSnapMs(v => (v == null ? 250 : null));
        return;
      }
      // 1..9 — focus the Nth track
      if (!mod && /^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        const t = state.tracks[idx];
        if (t) {
          e.preventDefault(); e.stopImmediatePropagation();
          setSelection({ trackId: t.id, regionId: null });
          return;
        }
      }

      // Markers: M drops a marker at the playhead
      if (k === "m") {
        e.preventDefault(); e.stopImmediatePropagation();
        const label = prompt("Marker label:") || "Marker";
        dispatch({ type: "ADD_MARKER", marker: { id: uuid(), timeMs: playheadMs, label, color: "#fde047" } });
        return;
      }
      // Help overlay (? or shift+/)
      if (k === "?" || (e.shiftKey && k === "/")) {
        e.preventDefault(); e.stopImmediatePropagation();
        setHelpOpen(v => !v);
        return;
      }
      // Escape closes overlays
      if (k === "escape") {
        if (helpOpen)        { setHelpOpen(false);    e.preventDefault(); return; }
        if (snapshotsOpen)   { setSnapshotsOpen(false); e.preventDefault(); return; }
        if (ctxMenu)         { setCtxMenu(null);     e.preventDefault(); return; }
      }
      if (k === "v" || k === "g" || k === "c" || k === "t" || k === "f") {
        e.preventDefault();
        e.stopImmediatePropagation();
        // Same key twice releases the override — you never have to hunt for "back to normal".
        const toggleTool = (id: EditTool) => setTool(cur => (cur === id ? "smart" : id));
        if (k === "v") { toggleTool("select"); return; }
        if (k === "g") { toggleTool("grab");   return; }
        if (k === "t") { toggleTool("trim");   return; }
        if (k === "f") { toggleTool("fade");   return; }
        // "c" = splice. In the Blade tool, cut at the hovered point; in any
        // other tool, splice the selected clip at the playhead.
        if (tool === "blade") {
          const hv = bladeHover;
          if (!hv) { setStatus("Hover a region to cut"); return; }
          splitRegion(hv.trackId, hv.regionId, hv.ms);
          return;
        }
        if (!selection?.regionId) { setStatus("Select a clip, then press C to splice at the playhead"); return; }
        const tk = stateRef.current.tracks.find(x => x.id === selection.trackId);
        const rg = tk?.regions.find(x => x.id === selection.regionId);
        const head = playheadMsRef.current;
        if (rg && head > rg.offsetMs && head < rg.offsetMs + regionDurMs(rg)) {
          splitRegion(selection.trackId, selection.regionId!, head);
        } else {
          setStatus("Move the playhead inside the selected clip, then press C to splice");
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [doUndo, doRedo, fitToWindow, tool, bladeHover, splitRegion, selection, selectedAutoPoint,
      copySelectedRegion, pasteAtPlayhead, duplicateSelectedRegion,
      playheadMs, helpOpen, snapshotsOpen, ctxMenu]);

  // ── Click scheduler helper ────────────────────────────────────

  const scheduleClickAt = (ctx: BaseAudioContext, time: number, accent: boolean) => {
    const osc = (ctx as AudioContext).createOscillator();
    const g   = (ctx as AudioContext).createGain();
    osc.type = "sine";
    osc.frequency.value = accent ? 1500 : 900;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(accent ? 0.45 : 0.28, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(g).connect((ctx as AudioContext).destination);
    osc.start(time);
    osc.stop(time + 0.06);
  };

  // ── Build full audio graph (online or offline) ─────────────────

  const buildAndStart = (
    ctx: BaseAudioContext,
    startCtxTime: number,
    headMs: number,
    durLimitMs: number | null,
    options: { withMeters: boolean },
  ): {
    sources: AudioBufferSourceNode[];
    trackAnalysers: Map<string, AnalyserNode>;
    masterAnalyser: AnalyserNode | null;
    masterLAnalyser: AnalyserNode | null;
    masterRAnalyser: AnalyserNode | null;
    masterKWeightedAnalyser: AnalyserNode | null;
    sidechainGains: Map<string, GainNode>;
    sidechainFollowAnalysers: Map<string, AnalyserNode>;
    trackParams: Map<string, TrackAudioParams>;
  } => {
    const sources: AudioBufferSourceNode[] = [];
    const trackAnalysers = new Map<string, AnalyserNode>();
    let masterAnalyser: AnalyserNode | null = null;
    let masterLAnalyser: AnalyserNode | null = null;
    let masterRAnalyser: AnalyserNode | null = null;
    let masterKWeightedAnalyser: AnalyserNode | null = null;
    const sidechainGains = new Map<string, GainNode>();
    const sidechainFollowAnalysers = new Map<string, AnalyserNode>();
    const trackParams = new Map<string, TrackAudioParams>();

    // Master bus: gain → master 7-band EQ → optional master comp → optional limiter → analyser → destination
    const master = (ctx as AudioContext).createGain();
    master.gain.value = dbToLinear(masterGainDb);
    let masterTail: AudioNode = master;
    // Master EQ
    const masterEqNodes: BiquadFilterNode[] = EQ_FREQS.map((f, i) => {
      const node = (ctx as AudioContext).createBiquadFilter();
      node.type = i === 0 ? "lowshelf" : i === 6 ? "highshelf" : "peaking";
      node.frequency.value = f;
      if (node.type === "peaking") node.Q.value = 1;
      node.gain.value = clamp(masterEq7[i] || 0, -EQ_DB_RANGE, EQ_DB_RANGE);
      return node;
    });
    for (const e of masterEqNodes) { masterTail.connect(e); masterTail = e; }
    // Master compressor
    if (masterComp.on) {
      const mc = (ctx as AudioContext).createDynamicsCompressor();
      mc.threshold.value = masterComp.threshold;
      mc.ratio.value     = masterComp.ratio;
      mc.attack.value    = masterComp.attack / 1000;
      mc.release.value   = masterComp.release / 1000;
      mc.knee.value      = 6;
      masterTail.connect(mc);
      const mkup = (ctx as AudioContext).createGain();
      mkup.gain.value = dbToLinear(masterComp.makeup);
      mc.connect(mkup);
      masterTail = mkup;
    }
    if (limiterEnabled) {
      const lim = (ctx as AudioContext).createDynamicsCompressor();
      lim.threshold.value = limiterThresh;
      lim.ratio.value = 20;
      lim.attack.value = 0.003;
      lim.release.value = 0.25;
      lim.knee.value = 0;
      masterTail.connect(lim);
      masterTail = lim;
    }
    if (options.withMeters && "createAnalyser" in ctx) {
      masterAnalyser = (ctx as AudioContext).createAnalyser();
      masterAnalyser.fftSize = 2048;
      masterTail.connect(masterAnalyser);
      masterAnalyser.connect((ctx as AudioContext).destination);

      // L/R split for correlation + goniometer
      const splitter = (ctx as AudioContext).createChannelSplitter(2);
      masterTail.connect(splitter);
      const lAn = (ctx as AudioContext).createAnalyser(); lAn.fftSize = 1024;
      const rAn = (ctx as AudioContext).createAnalyser(); rAn.fftSize = 1024;
      splitter.connect(lAn, 0);
      splitter.connect(rAn, 1);
      masterLAnalyser = lAn;
      masterRAnalyser = rAn;

      // K-weighted sidechain for LUFS (BS.1770 simplified):
      //   high-pass ≈38 Hz, then high-shelf +4 dB at 1.5 kHz
      const hp = (ctx as AudioContext).createBiquadFilter();
      hp.type = "highpass"; hp.frequency.value = 38;
      const shelf = (ctx as AudioContext).createBiquadFilter();
      shelf.type = "highshelf"; shelf.frequency.value = 1500; shelf.gain.value = 4;
      const kAn = (ctx as AudioContext).createAnalyser();
      kAn.fftSize = 2048;
      masterTail.connect(hp).connect(shelf).connect(kAn);
      masterKWeightedAnalyser = kAn;
    } else {
      masterTail.connect((ctx as AudioContext).destination);
    }

    const effSolo = stateRef.current.tracks.some(t => t.solo);
    const trackTaps = new Map<string, AudioNode>();   // for sidechain follower wiring

    stateRef.current.tracks.forEach(t => {
      if (!t.regions.length) return;
      const effMuted = t.muted || (effSolo && !t.solo);
      if (effMuted) return;

      // Track gain → pan
      const trackGain = (ctx as AudioContext).createGain();
      trackGain.gain.value = dbToLinear(t.gainDb);
      const panNode = (ctx as AudioContext).createStereoPanner();
      panNode.pan.value = clamp(t.pan, -1, 1);

      // 7-band EQ
      const eqBands: BiquadFilterNode[] = EQ_FREQS.map((f, i) => {
        const node = (ctx as AudioContext).createBiquadFilter();
        node.type = i === 0 ? "lowshelf" : i === 6 ? "highshelf" : "peaking";
        node.frequency.value = f;
        if (node.type === "peaking") node.Q.value = 1;
        node.gain.value = clamp(t.eq7[i] || 0, -EQ_DB_RANGE, EQ_DB_RANGE);
        return node;
      });

      // Wire gain → pan → eq[0] → ... → eq[6]
      let chainTail: AudioNode = trackGain;
      trackGain.connect(panNode); chainTail = panNode;
      for (const e of eqBands) { chainTail.connect(e); chainTail = e; }

      // Saturation (conventional position: pre-comp)
      let satShaper: WaveShaperNode | undefined;   // held so drive changes reach the live graph
      if (t.saturation.on && t.saturation.drive > 0) {
        const ws = (ctx as AudioContext).createWaveShaper();
        satShaper = ws;
        ws.curve = makeSatCurve(t.saturation.drive) as Float32Array<ArrayBuffer>;
        ws.oversample = "2x";
        chainTail.connect(ws); chainTail = ws;
      }

      // Compressor + makeup gain
      let compNode: DynamicsCompressorNode | undefined;
      let compThresholdParam: AudioParam | undefined;
      let compMakeupParam: AudioParam | undefined;
      if (t.compressor.on) {
        compNode = (ctx as AudioContext).createDynamicsCompressor();
        compNode.threshold.value = t.compressor.threshold;
        compNode.ratio.value     = t.compressor.ratio;
        compNode.attack.value    = t.compressor.attack / 1000;
        compNode.release.value   = t.compressor.release / 1000;
        compNode.knee.value      = 6;
        chainTail.connect(compNode);
        compThresholdParam = compNode.threshold;
        const makeup = (ctx as AudioContext).createGain();
        makeup.gain.value = dbToLinear(t.compressor.makeup);
        compMakeupParam = makeup.gain;   // held so Makeup reaches the live graph
        compNode.connect(makeup);
        chainTail = makeup;
      }

      // Per-track meter analyser (post-FX)
      if (options.withMeters && "createAnalyser" in ctx) {
        const an = (ctx as AudioContext).createAnalyser();
        an.fftSize = 256;
        chainTail.connect(an);
        trackAnalysers.set(t.id, an);
      }

      // Sidechain duck gain (between FX tail and master)
      const duckGain = (ctx as AudioContext).createGain();
      duckGain.gain.value = 1;
      chainTail.connect(duckGain).connect(master);
      sidechainGains.set(t.id, duckGain);

      // Reverb send (parallel) — per-track ConvolverNode
      const reverbWetGain = (ctx as AudioContext).createGain();
      reverbWetGain.gain.value = t.reverb.on ? clamp(t.reverb.wet, 0, 1) : 0;
      const conv = (ctx as AudioContext).createConvolver();
      conv.buffer = makeReverbIR(ctx, t.reverb.type, t.reverb.size);
      // tap the post-comp signal (chainTail before duck)
      chainTail.connect(reverbWetGain).connect(conv).connect(master);

      trackTaps.set(t.id, chainTail);

      trackParams.set(t.id, {
        trackGainParam: trackGain.gain,
        panParam:       panNode.pan,
        eqGainParams:   eqBands.map(e => e.gain),
        compThresholdParam,
        reverbWetParam: reverbWetGain.gain,
        compNode,
        compMakeupParam,
        satShaper,
        reverbConv: conv,
      });

      // Schedule region playback
      t.regions.forEach(r => {
        if (!r.buffer) return;
        const dur = regionDurMs(r) / 1000;
        const regionStartMs = r.offsetMs;
        const regionEndMs   = r.offsetMs + regionDurMs(r);
        const playEndMs = durLimitMs !== null ? Math.min(regionEndMs, headMs + durLimitMs) : regionEndMs;
        if (playEndMs <= headMs) return;
        const startWithinMs = Math.max(0, headMs - regionStartMs);
        const whenDelayMs   = Math.max(0, regionStartMs - headMs);
        const offsetIntoBuf = (r.trimStartMs + startWithinMs) / 1000;
        const remaining = Math.min(
          dur - startWithinMs / 1000,
          (playEndMs - Math.max(regionStartMs, headMs)) / 1000,
        );
        if (remaining <= 0) return;
        const src = (ctx as AudioContext).createBufferSource();
        src.buffer = r.buffer;
        const rg = (ctx as AudioContext).createGain();
        const peak = dbToLinear(r.clipGainDb || 0);
        const regionStartTime = startCtxTime + whenDelayMs / 1000;
        const regionEndTime   = regionStartTime + remaining;
        const fadeInS  = Math.min(r.fadeInMs  / 1000, remaining);
        const fadeOutS = Math.min(r.fadeOutMs / 1000, remaining);
        const fadeInConsumedS = Math.max(0, Math.min(fadeInS, startWithinMs / 1000));
        if (fadeInS > fadeInConsumedS) {
          rg.gain.setValueAtTime(0.0001, regionStartTime);
          rg.gain.exponentialRampToValueAtTime(peak, regionStartTime + (fadeInS - fadeInConsumedS));
        } else {
          rg.gain.setValueAtTime(peak, regionStartTime);
        }
        if (fadeOutS > 0) {
          const fadeOutStart = Math.max(regionStartTime, regionEndTime - fadeOutS);
          rg.gain.setValueAtTime(peak, fadeOutStart);
          rg.gain.exponentialRampToValueAtTime(0.0001, regionEndTime);
        }
        src.connect(rg).connect(trackGain);
        src.start(regionStartTime, offsetIntoBuf, remaining);
        sources.push(src);
      });
    });

    // Sidechain follower analysers (second pass)
    stateRef.current.tracks.forEach(t => {
      if (!t.sidechainSourceId) return;
      const srcTap = trackTaps.get(t.sidechainSourceId);
      if (!srcTap) return;
      if (sidechainFollowAnalysers.has(t.sidechainSourceId)) return;
      const an = (ctx as AudioContext).createAnalyser();
      an.fftSize = 256;
      srcTap.connect(an);
      sidechainFollowAnalysers.set(t.sidechainSourceId, an);
    });

    return { sources, trackAnalysers, masterAnalyser, masterLAnalyser, masterRAnalyser, masterKWeightedAnalyser, sidechainGains, sidechainFollowAnalysers, trackParams };
  };

  // ── Schedule automation on the actual AudioParams ──────────────

  const scheduleAutomation = (
    ctx: BaseAudioContext,
    startCtxTime: number,
    headMs: number,
    durLimitMs: number | null,
    trackParams: Map<string, TrackAudioParams>,
  ) => {
    const segEnd = durLimitMs !== null ? headMs + durLimitMs : Infinity;
    stateRef.current.tracks.forEach(t => {
      const params = trackParams.get(t.id);
      if (!params) return;
      for (const lane of t.automationLanes) {
        if (lane.points.length === 0) continue;
        const param = automationParamForLane(lane.param, params);
        if (!param) continue;
        // Automation values are stored in the "natural" units of the param spec.
        // For volume (dB) we need to convert to linear gain.
        // For everything else (pan, eq dB band gains, comp threshold dB, reverb wet 0..1)
        // the AudioParam expects the same units as we store.
        const toAudio = lane.param === "volume"
          ? (v: number) => dbToLinear(v)
          : (v: number) => v;

        // Initial value at headMs
        const initVal = interpolateLane(lane, headMs);
        if (initVal === null) continue;
        try { param.cancelScheduledValues(startCtxTime); } catch {}
        param.setValueAtTime(toAudio(initVal), startCtxTime);
        const sorted = [...lane.points].sort((a, b) => a.timeMs - b.timeMs);
        for (const p of sorted) {
          if (p.timeMs <= headMs) continue;
          if (p.timeMs > segEnd) break;
          const targetCtxTime = startCtxTime + (p.timeMs - headMs) / 1000;
          param.linearRampToValueAtTime(toAudio(p.value), targetCtxTime);
        }
      }
    });
  };

  const automationParamForLane = (param: AutomationParam, p: TrackAudioParams): AudioParam | null => {
    switch (param) {
      case "volume": return p.trackGainParam;
      case "pan":    return p.panParam;
      case "comp_threshold": return p.compThresholdParam || null;
      case "reverb_wet":     return p.reverbWetParam;
      default: {
        const idx = EQ_PARAM_TO_BAND_IDX[param];
        if (idx === undefined) return null;
        return p.eqGainParams[idx] || null;
      }
    }
  };

  // ── Playback ──────────────────────────────────────────────────

  const stop = useCallback(() => {
    sourcesRef.current.forEach(s => { try { s.stop(); } catch {} });
    sourcesRef.current = [];
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setPlaying(false);
    meterLevelsRef.current.master = 0;
    meterLevelsRef.current.perTrack.clear();
    compReductionRef.current.clear();
    setMeterTick(n => n + 1);
  }, []);
  useEffect(() => { stopRef.current = stop; }, [stop]);

  const play = useCallback(() => {
    const ctx = getCtx();
    if (ctx.state === "suspended") ctx.resume();
    stop();
    const now = ctx.currentTime;
    playStartRef.current = now;

    let head = playheadMs;
    const useLoop = loopEnabled && loopRange && loopRange.endMs > loopRange.startMs;
    if (useLoop && (head < loopRange!.startMs || head >= loopRange!.endMs)) {
      head = loopRange!.startMs;
      setPlayheadMs(head);
    }
    playFromRef.current = head;
    const segmentDurMs = useLoop ? loopRange!.endMs - head : null;

    const built = buildAndStart(ctx, now, head, segmentDurMs, { withMeters: true });
    sourcesRef.current = built.sources;
    trackAnalysersRef.current = built.trackAnalysers;
    masterAnalyserRef.current = built.masterAnalyser;
    masterLAnalyserRef.current = built.masterLAnalyser;
    masterRAnalyserRef.current = built.masterRAnalyser;
    masterKWeightedRef.current = built.masterKWeightedAnalyser;
    sidechainGainsRef.current = built.sidechainGains;
    sidechainFollowRef.current = built.sidechainFollowAnalysers;
    trackParamsRef.current = built.trackParams;

    // Pre-schedule automation
    scheduleAutomation(ctx, now, head, segmentDurMs, built.trackParams);

    if (clickEnabledRef.current) {
      const beatMs = 60000 / bpmRef.current;
      const nextBeatIdx = Math.ceil(head / beatMs);
      clickNextBeatIdxRef.current = nextBeatIdx;
      clickNextBeatTimeRef.current = now + (nextBeatIdx * beatMs - head) / 1000;
    }

    setPlaying(true);

    const tdBuf = new Uint8Array(1024);
    const masterBuf = new Uint8Array(1024);

    const tick = () => {
      const ctx2 = audioCtxRef.current;
      if (!ctx2) return;
      const elapsed = (ctx2.currentTime - playStartRef.current) * 1000;
      let head2 = playFromRef.current + elapsed;

      // Loop wrap
      if (useLoop && head2 >= loopRange!.endMs) {
        sourcesRef.current.forEach(s => { try { s.stop(); } catch {} });
        sourcesRef.current = [];
        const newStart = ctx2.currentTime;
        playStartRef.current = newStart;
        playFromRef.current = loopRange!.startMs;
        head2 = loopRange!.startMs;
        const seg = loopRange!.endMs - loopRange!.startMs;
        const built2 = buildAndStart(ctx2, newStart, loopRange!.startMs, seg, { withMeters: true });
        sourcesRef.current = built2.sources;
        trackAnalysersRef.current = built2.trackAnalysers;
        masterAnalyserRef.current = built2.masterAnalyser;
        masterLAnalyserRef.current = built2.masterLAnalyser;
        masterRAnalyserRef.current = built2.masterRAnalyser;
        masterKWeightedRef.current = built2.masterKWeightedAnalyser;
        sidechainGainsRef.current = built2.sidechainGains;
        sidechainFollowRef.current = built2.sidechainFollowAnalysers;
        trackParamsRef.current = built2.trackParams;
        scheduleAutomation(ctx2, newStart, loopRange!.startMs, seg, built2.trackParams);
        if (clickEnabledRef.current) {
          const beatMs = 60000 / bpmRef.current;
          const nextBeatIdx = Math.ceil(loopRange!.startMs / beatMs);
          clickNextBeatIdxRef.current = nextBeatIdx;
          clickNextBeatTimeRef.current = newStart + (nextBeatIdx * beatMs - loopRange!.startMs) / 1000;
        }
      }

      setPlayheadMs(head2);

      // Click scheduler
      if (clickEnabledRef.current) {
        const beatMs = 60000 / bpmRef.current;
        const beatS  = beatMs / 1000;
        const horizon = ctx2.currentTime + 0.5;
        while (clickNextBeatTimeRef.current < horizon) {
          const accent = clickNextBeatIdxRef.current % 4 === 0;
          scheduleClickAt(ctx2, clickNextBeatTimeRef.current, accent);
          clickNextBeatTimeRef.current += beatS;
          clickNextBeatIdxRef.current  += 1;
        }
      }

      // Meters
      const ma = masterAnalyserRef.current;
      if (ma) {
        ma.getByteTimeDomainData(masterBuf);
        let m = 0;
        for (let i = 0; i < masterBuf.length; i++) {
          const v = Math.abs(masterBuf[i] - 128) / 128;
          if (v > m) m = v;
        }
        meterLevelsRef.current.master = m;
      }
      const sourceLevels = new Map<string, number>();
      trackAnalysersRef.current.forEach((an, tid) => {
        an.getByteTimeDomainData(tdBuf);
        let m = 0;
        for (let i = 0; i < an.fftSize; i++) {
          const v = Math.abs(tdBuf[i] - 128) / 128;
          if (v > m) m = v;
        }
        meterLevelsRef.current.perTrack.set(tid, m);
        sourceLevels.set(tid, m);
      });
      // Compressor reduction (per-track)
      trackParamsRef.current.forEach((p, tid) => {
        if (p.compNode) compReductionRef.current.set(tid, (p.compNode as any).reduction || 0);
      });

      // LUFS momentary (BS.1770 simplified — K-weighted mean square)
      const kAn = masterKWeightedRef.current;
      if (kAn) {
        const buf = new Float32Array(kAn.fftSize);
        kAn.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
        const meanSq = sumSq / buf.length;
        const lufs = meanSq > 1e-10 ? -0.691 + 10 * Math.log10(meanSq) : -Infinity;
        lufsMomentaryRef.current = lufs;
      }
      // Stereo correlation (mean(L*R) / sqrt(mean(L²)*mean(R²)))
      const lAn = masterLAnalyserRef.current, rAn = masterRAnalyserRef.current;
      if (lAn && rAn) {
        const lBuf = new Float32Array(lAn.fftSize);
        const rBuf = new Float32Array(rAn.fftSize);
        lAn.getFloatTimeDomainData(lBuf);
        rAn.getFloatTimeDomainData(rBuf);
        let sumLR = 0, sumLL = 0, sumRR = 0;
        for (let i = 0; i < lBuf.length; i++) {
          sumLR += lBuf[i] * rBuf[i];
          sumLL += lBuf[i] * lBuf[i];
          sumRR += rBuf[i] * rBuf[i];
        }
        const denom = Math.sqrt(sumLL * sumRR);
        correlationRef.current = denom > 1e-12 ? sumLR / denom : 0;
      }
      // Sidechain duck
      stateRef.current.tracks.forEach(t => {
        if (!t.sidechainSourceId) return;
        const duck = sidechainGainsRef.current.get(t.id);
        if (!duck) return;
        const srcLevel = sourceLevels.get(t.sidechainSourceId) || 0;
        const driveAmt = Math.max(0, Math.min(1, (srcLevel - 0.05) / 0.45));
        const reductionDb = -t.sidechainAmountDb * driveAmt;
        const targetGain = dbToLinear(reductionDb);
        duck.gain.setTargetAtTime(targetGain, ctx2.currentTime, 0.03);
      });
      setMeterTick(n => (n + 1) & 0x3fffffff);

      if (!useLoop && head2 >= totalDurMs) {
        stop();
        setPlayheadMs(totalDurMs);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [stop, playheadMs, totalDurMs, masterGainDb, limiterEnabled, limiterThresh, masterEq7, masterComp, loopEnabled, loopRange]);

  useEffect(() => { playRef.current = play; }, [play]);

  // ── Live param sync ───────────────────────────────────────────
  // The audio graph is built once at play(); without this, manual edits to
  // EQ / gain / pan / reverb / comp only take effect on the *next* play.
  // Push them onto the running AudioParams while playing so drags are audible
  // immediately (smoothed to avoid zipper noise).
  useEffect(() => {
    if (!playingRef.current) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const now = ctx.currentTime;
    const TC = 0.02;
    for (const t of tracks) {
      const p = trackParamsRef.current.get(t.id);
      if (!p) continue;
      try { p.trackGainParam.setTargetAtTime(dbToLinear(t.gainDb), now, TC); } catch {}
      try { p.panParam.setTargetAtTime(clamp(t.pan, -1, 1), now, TC); } catch {}
      for (let i = 0; i < EQ_BANDS; i++) {
        const g = p.eqGainParams[i];
        if (g) { try { g.setTargetAtTime(clamp(t.eq7[i] || 0, -EQ_DB_RANGE, EQ_DB_RANGE), now, TC); } catch {} }
      }
      if (p.reverbWetParam) { try { p.reverbWetParam.setTargetAtTime(t.reverb.on ? clamp(t.reverb.wet, 0, 1) : 0, now, TC); } catch {} }
      if (p.compThresholdParam) { try { p.compThresholdParam.setTargetAtTime(t.compressor.threshold, now, TC); } catch {} }

      // ── STALE-GRAPH FIX (Phase 1, 2026-08-16) ─────────────────────────────────────────────────
      // Everything below was built into the graph once and then never updated. Turning Ratio,
      // Attack, Release or Makeup, moving saturation Drive, or changing reverb Type/Size changed
      // the readout and nothing else — the sound only caught up when the graph was rebuilt on the
      // next play. The knob lied, which is the honest-UI failure in its purest form: a control that
      // reports it did something it did not do.
      //
      // Ratio/attack/release are k-rate AudioParams on the existing node — setTargetAtTime, same as
      // every line above. Makeup is a plain gain. Neither adds a node or changes the signal path.
      if (p.compNode) {
        try { p.compNode.ratio.setTargetAtTime(clamp(t.compressor.ratio, 1, 20), now, TC); } catch {}
        try { p.compNode.attack.setTargetAtTime(clamp(t.compressor.attack / 1000, 0, 1), now, TC); } catch {}
        try { p.compNode.release.setTargetAtTime(clamp(t.compressor.release / 1000, 0, 1), now, TC); } catch {}
      }
      if (p.compMakeupParam) { try { p.compMakeupParam.setTargetAtTime(dbToLinear(t.compressor.makeup), now, TC); } catch {} }

      // Curve and IR are BUFFERS, not params — they are swapped, not ramped. Both are assignments
      // on a node already in the path, so neither reconnects anything. Guarded by an equality check
      // so a re-render that did not touch the value does not rebuild an impulse response every tick.
      if (p.satShaper && t.saturation.on) {
        const wantDrive = clamp(t.saturation.drive, 0, 24);
        if ((p.satShaper as any).__driveDb !== wantDrive) {
          try {
            p.satShaper.curve = makeSatCurve(wantDrive) as Float32Array<ArrayBuffer>;
            (p.satShaper as any).__driveDb = wantDrive;
          } catch {}
        }
      }
      if (p.reverbConv && t.reverb.on) {
        const sig = `${t.reverb.type}:${t.reverb.size}`;
        if ((p.reverbConv as any).__irSig !== sig) {
          try {
            p.reverbConv.buffer = makeReverbIR(ctx, t.reverb.type, t.reverb.size);
            (p.reverbConv as any).__irSig = sig;
          } catch {}
        }
      }
    }
  }, [tracks]);

  const returnToStart = useCallback(() => {
    stop();
    setPlayheadMs(loopEnabled && loopRange ? loopRange.startMs : 0);
  }, [stop, loopEnabled, loopRange]);

  // ── Recording (punch-in allowed) ──────────────────────────────

  const toggleRecord = useCallback(async () => {
    if (recording) {
      const r = recRef.current;
      if (r) r.mr.stop();
      return;
    }
    const armed = tracks.find(t => t.armed);
    if (!armed) { setStatus("Arm a track first (⏺ button)."); return; }
    if (!recordArmed) { setStatus("Record-arm is off. Toggle ⏺ in toolbar."); return; }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        if (liveRecRef.current) {
          cancelAnimationFrame(liveRecRef.current.rafId);
          try { liveRecRef.current.source.disconnect(); } catch {}
          liveRecRef.current = null;
          setLiveRecTick(n => n + 1);
        }
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: "audio/webm" });
        const ab = await blob.arrayBuffer();
        const ctx = getCtx();
        try {
          const buffer = await ctx.decodeAudioData(ab);
          const peaks  = extractPeaks(buffer);
          const url = URL.createObjectURL(blob);
          const atMs = recRef.current?.startMs || 0;
          const region = newRegion({ buffer, peaks, filePath: url, offsetMs: atMs });
          dispatch({ type: "ADD_REGION", trackId: armed.id, region });
          setStatus("✓ Recording placed");
        } catch (err: any) {
          setStatus(`✗ Decode failed: ${err?.message || err}`);
        }
        setRecording(false);
        recRef.current = null;
      };
      recRef.current = { mr, chunks, trackId: armed.id, startMs: playheadMs };

      const ctx = getCtx();
      if (ctx.state === "suspended") await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const sampleBuf = new Float32Array(analyser.fftSize);
      const samplePeriodMs = 33;
      const startedAt = performance.now();
      liveRecRef.current = {
        trackId: armed.id, startMs: playheadMs, startedAt,
        peaks: [], samplePeriodMs, analyser, source, rafId: 0,
      };
      let nextSampleAt = startedAt;
      const tickRec = () => {
        const lr = liveRecRef.current;
        if (!lr) return;
        const now = performance.now();
        if (now >= nextSampleAt) {
          analyser.getFloatTimeDomainData(sampleBuf);
          let max = 0;
          for (let i = 0; i < sampleBuf.length; i++) {
            const v = Math.abs(sampleBuf[i]);
            if (v > max) max = v;
          }
          lr.peaks.push(max);
          nextSampleAt += samplePeriodMs;
          setLiveRecTick(n => n + 1);
        }
        lr.rafId = requestAnimationFrame(tickRec);
      };
      tickRec();

      mr.start();
      setRecording(true);
      setStatus("● Recording...");
    } catch (e: any) {
      setStatus(`✗ Mic error: ${e?.message || e}`);
    }
  }, [recording, tracks, recordArmed, playheadMs]);

  // ── Export WAV (mirrors live chain + bakes automation + sidechain) ──

  const exportWav = useCallback(async () => {
    const liveTracks = tracks.filter(t => t.regions.some(r => r.buffer) && !t.muted && (!anySolo || t.solo));
    if (!liveTracks.length) { setStatus("Nothing to export."); return; }

    // Ask about watermark if any live track is marked as original content
    const hasOriginal = liveTracks.some(t => t.originalContent);
    let embedWm = false;
    if (hasOriginal) {
      embedWm = await new Promise<boolean>(resolve => setExportWmDialog({ resolve }));
    }

    const sr = 44100;
    const totalSec = totalDurMs / 1000;

    // Pre-pass: compute sidechain envelopes
    const sidechainSourceIds = new Set<string>();
    for (const t of liveTracks) if (t.sidechainSourceId) sidechainSourceIds.add(t.sidechainSourceId);
    const envelopes = new Map<string, Float32Array>();
    if (sidechainSourceIds.size > 0) {
      setStatus("Computing sidechain envelopes...");
      for (const srcId of sidechainSourceIds) {
        const src = liveTracks.find(t => t.id === srcId);
        if (!src) continue;
        const srcCtx = new OfflineAudioContext(1, Math.ceil(totalSec * sr), sr);
        const g = srcCtx.createGain(); g.gain.value = 1;
        g.connect(srcCtx.destination);
        src.regions.forEach(r => {
          if (!r.buffer) return;
          const node = srcCtx.createBufferSource(); node.buffer = r.buffer;
          node.connect(g);
          node.start(r.offsetMs / 1000, r.trimStartMs / 1000, regionDurMs(r) / 1000);
        });
        const srcRendered = await srcCtx.startRendering();
        const data = srcRendered.getChannelData(0);
        const envBuf = new Float32Array(data.length);
        let env = 0;
        const atk = Math.exp(-1 / (sr * 0.005));
        const rel = Math.exp(-1 / (sr * 0.150));
        for (let i = 0; i < data.length; i++) {
          const x = Math.abs(data[i]);
          env = x > env ? atk * env + (1 - atk) * x : rel * env + (1 - rel) * x;
          envBuf[i] = env;
        }
        envelopes.set(srcId, envBuf);
      }
    }

    setStatus("Rendering mix...");
    const offline = new OfflineAudioContext(2, Math.ceil(totalSec * sr), sr);

    // Master: gain → EQ → optional comp → optional limiter → destination
    const master = offline.createGain();
    master.gain.value = dbToLinear(masterGainDb);
    let masterTail: AudioNode = master;
    EQ_FREQS.forEach((f, i) => {
      const node = offline.createBiquadFilter();
      node.type = i === 0 ? "lowshelf" : i === 6 ? "highshelf" : "peaking";
      node.frequency.value = f;
      if (node.type === "peaking") node.Q.value = 1;
      node.gain.value = clamp(masterEq7[i] || 0, -EQ_DB_RANGE, EQ_DB_RANGE);
      masterTail.connect(node); masterTail = node;
    });
    if (masterComp.on) {
      const mc = offline.createDynamicsCompressor();
      mc.threshold.value = masterComp.threshold;
      mc.ratio.value     = masterComp.ratio;
      mc.attack.value    = masterComp.attack / 1000;
      mc.release.value   = masterComp.release / 1000;
      mc.knee.value      = 6;
      masterTail.connect(mc);
      const mkup = offline.createGain();
      mkup.gain.value = dbToLinear(masterComp.makeup);
      mc.connect(mkup);
      masterTail = mkup;
    }
    if (limiterEnabled) {
      const lim = offline.createDynamicsCompressor();
      lim.threshold.value = limiterThresh; lim.ratio.value = 20;
      lim.attack.value = 0.003; lim.release.value = 0.25; lim.knee.value = 0;
      masterTail.connect(lim); masterTail = lim;
    }
    masterTail.connect(offline.destination);

    // Per-track AudioParam map for offline automation scheduling
    const offlineParams = new Map<string, TrackAudioParams>();

    liveTracks.forEach(t => {
      const trackGain = offline.createGain();
      trackGain.gain.value = dbToLinear(t.gainDb);
      const panNode = offline.createStereoPanner(); panNode.pan.value = clamp(t.pan, -1, 1);
      const eqBands: BiquadFilterNode[] = EQ_FREQS.map((f, i) => {
        const node = offline.createBiquadFilter();
        node.type = i === 0 ? "lowshelf" : i === 6 ? "highshelf" : "peaking";
        node.frequency.value = f;
        if (node.type === "peaking") node.Q.value = 1;
        node.gain.value = clamp(t.eq7[i] || 0, -EQ_DB_RANGE, EQ_DB_RANGE);
        return node;
      });
      let chainTail: AudioNode = trackGain;
      trackGain.connect(panNode); chainTail = panNode;
      for (const e of eqBands) { chainTail.connect(e); chainTail = e; }
      if (t.saturation.on && t.saturation.drive > 0) {
        const ws = offline.createWaveShaper();
        ws.curve = makeSatCurve(t.saturation.drive) as Float32Array<ArrayBuffer>;
        ws.oversample = "2x";
        chainTail.connect(ws); chainTail = ws;
      }
      let compThresholdParam: AudioParam | undefined;
      if (t.compressor.on) {
        const comp = offline.createDynamicsCompressor();
        comp.threshold.value = t.compressor.threshold;
        comp.ratio.value     = t.compressor.ratio;
        comp.attack.value    = t.compressor.attack / 1000;
        comp.release.value   = t.compressor.release / 1000;
        comp.knee.value      = 6;
        chainTail.connect(comp);
        compThresholdParam = comp.threshold;
        const makeup = offline.createGain();
        makeup.gain.value = dbToLinear(t.compressor.makeup);
        comp.connect(makeup);
        chainTail = makeup;
      }
      // Sidechain (baked envelope)
      const duckGain = offline.createGain();
      duckGain.gain.value = 1;
      if (t.sidechainSourceId && envelopes.has(t.sidechainSourceId)) {
        const env = envelopes.get(t.sidechainSourceId)!;
        const stride = Math.max(1, Math.floor(sr / 200));
        const downLen = Math.floor(env.length / stride);
        const curve = new Float32Array(downLen);
        for (let i = 0; i < downLen; i++) {
          const srcLevel = env[i * stride];
          const driveAmt = Math.max(0, Math.min(1, (srcLevel - 0.05) / 0.45));
          curve[i] = dbToLinear(-t.sidechainAmountDb * driveAmt);
        }
        duckGain.gain.setValueCurveAtTime(curve, 0, totalSec);
      }
      chainTail.connect(duckGain).connect(master);

      // Per-track parallel reverb send
      const reverbWetGain = offline.createGain();
      reverbWetGain.gain.value = t.reverb.on ? clamp(t.reverb.wet, 0, 1) : 0;
      const conv = offline.createConvolver();
      conv.buffer = makeReverbIR(offline, t.reverb.type, t.reverb.size);
      chainTail.connect(reverbWetGain).connect(conv).connect(master);

      offlineParams.set(t.id, {
        trackGainParam: trackGain.gain,
        panParam:       panNode.pan,
        eqGainParams:   eqBands.map(e => e.gain),
        compThresholdParam,
        reverbWetParam: reverbWetGain.gain,
      });

      // Region playback
      t.regions.forEach(r => {
        if (!r.buffer) return;
        const src = offline.createBufferSource(); src.buffer = r.buffer;
        const rg = offline.createGain();
        const peak = dbToLinear(r.clipGainDb || 0);
        const startS = r.offsetMs / 1000;
        const durS   = regionDurMs(r) / 1000;
        const endS   = startS + durS;
        const fiS = Math.min(r.fadeInMs  / 1000, durS);
        const foS = Math.min(r.fadeOutMs / 1000, durS);
        if (fiS > 0) {
          rg.gain.setValueAtTime(0.0001, startS);
          rg.gain.exponentialRampToValueAtTime(peak, startS + fiS);
        } else {
          rg.gain.setValueAtTime(peak, startS);
        }
        if (foS > 0) {
          rg.gain.setValueAtTime(peak, endS - foS);
          rg.gain.exponentialRampToValueAtTime(0.0001, endS);
        }
        src.connect(rg).connect(trackGain);
        src.start(startS, r.trimStartMs / 1000, durS);
      });
    });

    // Bake automation curves into offline AudioParams
    liveTracks.forEach(t => {
      const params = offlineParams.get(t.id);
      if (!params) return;
      for (const lane of t.automationLanes) {
        if (lane.points.length === 0) continue;
        const param = automationParamForLane(lane.param, params);
        if (!param) continue;
        const toAudio = lane.param === "volume" ? (v: number) => dbToLinear(v) : (v: number) => v;
        const sorted = [...lane.points].sort((a, b) => a.timeMs - b.timeMs);
        const initVal = sorted[0].value;
        try { param.cancelScheduledValues(0); } catch {}
        param.setValueAtTime(toAudio(initVal), 0);
        for (const p of sorted) {
          param.linearRampToValueAtTime(toAudio(p.value), p.timeMs / 1000);
        }
      }
    });

    const rendered = await offline.startRendering();
    let   wavBuf   = encodeWav(rendered);

    if (embedWm) {
      setStatus("Embedding watermark…");
      const stationId = await (window as any).ether?.invoke?.("repl:get-site-id").catch(() => "unknown") ?? "unknown";
      wavBuf = await embedWatermarkInWav(wavBuf, {
        stationId,
        timestamp:    new Date().toISOString(),
        etherVersion: "2.1.1",
      });
    }

    const ether = (window as any).ether;
    if (ether?.dialog?.saveFile && ether?.fs?.writeFile) {
      try {
        const res = await ether.dialog.saveFile({
          defaultPath: `StudioPro_Mix_${Date.now()}.wav`,
          filters: [{ name: "WAV", extensions: ["wav"] }],
        });
        const path = typeof res === "string" ? res : res?.filePath;
        if (path) {
          await ether.fs.writeFile(path, new Uint8Array(wavBuf));
          setStatus(`✓ Exported${embedWm ? " (watermarked)" : ""}: ${path}`);
          setLastExportPath(embedWm ? path : null);
          if (embedWm) {
            try {
              const wmp = JSON.parse(localStorage.getItem("ether_watermarked_paths") || "[]");
              if (!wmp.includes(path)) wmp.push(path);
              localStorage.setItem("ether_watermarked_paths", JSON.stringify(wmp));
            } catch {}
          }
          return;
        }
      } catch (e: any) {
        setStatus(`✗ Save failed: ${e?.message || e}`);
      }
    }
    const blob = new Blob([wavBuf], { type: "audio/wav" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `StudioPro_Mix_${Date.now()}.wav`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setStatus("✓ Exported (downloaded)");
  }, [tracks, anySolo, totalDurMs, masterGainDb, limiterEnabled, limiterThresh, masterEq7, masterComp]);

  // ── Export stems: one WAV per track + the mix ────────────────

  const exportStems = useCallback(async () => {
    const stemTracks = tracks.filter(t => t.regions.some(r => r.buffer));
    if (!stemTracks.length) { setStatus("Nothing to export."); return; }
    const ether = (window as any).ether;
    const dirRes = ether?.dialog?.saveFile && await ether.dialog.saveFile({
      defaultPath: `StudioPro_Stems_${Date.now()}.wav`,
      filters: [{ name: "WAV", extensions: ["wav"] }],
    });
    const basePath = typeof dirRes === "string" ? dirRes : dirRes?.filePath;
    if (ether?.dialog?.saveFile && !basePath) { setStatus("Stem export cancelled."); return; }

    const sr = 44100;
    const totalSec = totalDurMs / 1000;
    let exported = 0;

    for (const t of stemTracks) {
      setStatus(`Rendering stem ${exported + 1}/${stemTracks.length}: ${t.name}...`);
      const offline = new OfflineAudioContext(2, Math.ceil(totalSec * sr), sr);
      // Stems render through the track's own FX chain, no master EQ/comp/limiter
      const trackGain = offline.createGain();
      trackGain.gain.value = dbToLinear(t.gainDb);
      const panNode = offline.createStereoPanner(); panNode.pan.value = clamp(t.pan, -1, 1);
      let chainTail: AudioNode = trackGain;
      trackGain.connect(panNode); chainTail = panNode;
      EQ_FREQS.forEach((f, i) => {
        const node = offline.createBiquadFilter();
        node.type = i === 0 ? "lowshelf" : i === 6 ? "highshelf" : "peaking";
        node.frequency.value = f;
        if (node.type === "peaking") node.Q.value = 1;
        node.gain.value = clamp(t.eq7[i] || 0, -EQ_DB_RANGE, EQ_DB_RANGE);
        chainTail.connect(node); chainTail = node;
      });
      if (t.saturation.on && t.saturation.drive > 0) {
        const ws = offline.createWaveShaper();
        ws.curve = makeSatCurve(t.saturation.drive) as Float32Array<ArrayBuffer>;
        ws.oversample = "2x";
        chainTail.connect(ws); chainTail = ws;
      }
      if (t.compressor.on) {
        const comp = offline.createDynamicsCompressor();
        comp.threshold.value = t.compressor.threshold;
        comp.ratio.value = t.compressor.ratio;
        comp.attack.value = t.compressor.attack / 1000;
        comp.release.value = t.compressor.release / 1000;
        comp.knee.value = 6;
        chainTail.connect(comp);
        const mkup = offline.createGain();
        mkup.gain.value = dbToLinear(t.compressor.makeup);
        comp.connect(mkup);
        chainTail = mkup;
      }
      chainTail.connect(offline.destination);
      // Reverb in parallel
      if (t.reverb.on && t.reverb.wet > 0) {
        const wet = offline.createGain(); wet.gain.value = clamp(t.reverb.wet, 0, 1);
        const conv = offline.createConvolver(); conv.buffer = makeReverbIR(offline, t.reverb.type, t.reverb.size);
        chainTail.connect(wet).connect(conv).connect(offline.destination);
      }

      t.regions.forEach(r => {
        if (!r.buffer) return;
        const src = offline.createBufferSource(); src.buffer = r.buffer;
        const rg = offline.createGain();
        const peak = dbToLinear(r.clipGainDb || 0);
        const startS = r.offsetMs / 1000;
        const durS   = regionDurMs(r) / 1000;
        const endS   = startS + durS;
        const fiS = Math.min(r.fadeInMs  / 1000, durS);
        const foS = Math.min(r.fadeOutMs / 1000, durS);
        if (fiS > 0) { rg.gain.setValueAtTime(0.0001, startS); rg.gain.exponentialRampToValueAtTime(peak, startS + fiS); }
        else { rg.gain.setValueAtTime(peak, startS); }
        if (foS > 0) { rg.gain.setValueAtTime(peak, endS - foS); rg.gain.exponentialRampToValueAtTime(0.0001, endS); }
        src.connect(rg).connect(trackGain);
        src.start(startS, r.trimStartMs / 1000, durS);
      });

      const rendered = await offline.startRendering();
      const wav = encodeWav(rendered);
      const safeName = t.name.replace(/[^\w\s-]/g, "_").trim() || `Track${exported + 1}`;

      if (basePath && ether?.fs?.writeFile) {
        const stemPath = basePath.replace(/\.wav$/i, `_${safeName}.wav`);
        await ether.fs.writeFile(stemPath, new Uint8Array(wav));
      } else {
        const blob = new Blob([wav], { type: "audio/wav" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `StudioPro_Stem_${safeName}.wav`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
      exported++;
    }

    setStatus(`✓ Exported ${exported} stem${exported === 1 ? "" : "s"}`);
  }, [tracks, totalDurMs]);

  // ── Watermark verification ────────────────────────────────────

  const verifyWatermark = useCallback(async (filePath: string) => {
    setWmDialogPath(filePath);
    setWmResult(null);
    setWmVerifying(true);
    try {
      const result = await (window as any).ether.invoke("watermark:verify", { filePath });
      setWmResult(result);
    } catch (e: any) {
      setWmResult({ found: false, valid: false, error: e?.message || "Verification failed" });
    } finally {
      setWmVerifying(false);
    }
  }, []);

  const openVerifyFilePicker = useCallback(async () => {
    const paths = await (window as any).ether.invoke("dialog:openFile", {
      filters: [{ name: "WAV Audio", extensions: ["wav"] }],
    });
    if (paths?.[0]) verifyWatermark(paths[0]);
  }, [verifyWatermark]);

  // ── Save / Load session JSON ──────────────────────────────────

  const saveSession = useCallback(async () => {
    // Strip non-serializable fields. AudioBuffers can't be saved; we keep filePath
    // so we can re-fetch on load. Recorded blob: URLs won't survive a reload —
    // we drop those regions and warn.
    let droppedBlobRegions = 0;
    const tracksJson = tracks.map(t => ({
      ...t,
      regions: t.regions
        .filter(r => {
          const isBlob = r.filePath?.startsWith("blob:");
          if (isBlob) droppedBlobRegions++;
          return r.filePath && !isBlob;
        })
        .map(r => ({
          id: r.id, filePath: r.filePath,
          offsetMs: r.offsetMs, trimStartMs: r.trimStartMs, trimEndMs: r.trimEndMs,
          fadeInMs: r.fadeInMs, fadeOutMs: r.fadeOutMs,
        })),
    }));
    const session = {
      version: 1,
      tracks: tracksJson,
      master: { masterGainDb, limiterEnabled, limiterThresh, masterEq7, masterComp },
      bpm, zoom,
      loop: { range: loopRange, enabled: loopEnabled },
      flags: { clickEnabled, gridEnabled },
    };
    const json = JSON.stringify(session, null, 2);
    const ether = (window as any).ether;
    if (ether?.dialog?.saveFile && ether?.fs?.writeFile) {
      try {
        const res = await ether.dialog.saveFile({
          defaultPath: `StudioPro_Session_${Date.now()}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        const path = typeof res === "string" ? res : res?.filePath;
        if (path) {
          await ether.fs.writeFile(path, json);
          setStatus(`✓ Saved session${droppedBlobRegions ? ` (${droppedBlobRegions} recording(s) skipped — bounce them first)` : ""}`);
          return;
        }
      } catch (e: any) {
        setStatus(`✗ Save failed: ${e?.message || e}`);
      }
    }
    // Fallback: download
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `StudioPro_Session_${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setStatus("✓ Saved session (download)");
  }, [tracks, masterGainDb, limiterEnabled, limiterThresh, masterEq7, masterComp, bpm, zoom, loopRange, loopEnabled, clickEnabled, gridEnabled]);

  const loadSession = useCallback(async () => {
    const ether = (window as any).ether;
    let json: string | null = null;
    if (ether?.dialog?.openFile && ether?.fs?.readFile) {
      try {
        const res = await ether.dialog.openFile({ filters: [{ name: "JSON", extensions: ["json"] }] });
        const path = typeof res === "string" ? res : res?.filePath;
        if (!path) return;
        const buf = await ether.fs.readFile(path);
        json = new TextDecoder().decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
      } catch (e: any) { setStatus(`✗ Open failed: ${e?.message || e}`); return; }
    } else {
      // Fallback: file picker
      const input = document.createElement("input");
      input.type = "file"; input.accept = ".json";
      const file = await new Promise<File | null>(res => {
        input.onchange = () => res(input.files?.[0] || null);
        input.click();
      });
      if (!file) return;
      json = await file.text();
    }
    if (!json) return;
    let session: any;
    try { session = JSON.parse(json); }
    catch (e) { setStatus("✗ Invalid JSON"); return; }

    setStatus("Loading session — re-fetching audio...");
    const ctx = getCtx();
    const restoredTracks: StudioTrack[] = [];
    for (const tj of session.tracks || []) {
      const restoredRegions: StudioRegion[] = [];
      for (const rj of tj.regions || []) {
        if (!rj.filePath) continue;
        try {
          const url = rj.filePath.startsWith("http") || rj.filePath.startsWith("blob:")
            ? rj.filePath : convertFileSrc(rj.filePath);
          const resp = await fetch(url);
          const ab = await resp.arrayBuffer();
          const buffer = await ctx.decodeAudioData(ab);
          const peaks = extractPeaks(buffer);
          restoredRegions.push({
            ...newRegion({}), ...rj,
            buffer, peaks,
          });
        } catch (e) {
          // Skip missing files; keep going
        }
      }
      restoredTracks.push({
        ...newTrack(tj.name || "Track", tj.color || PALETTE[0]),
        ...tj,
        regions: restoredRegions,
      });
    }
    dispatch({ type: "REPLACE", tracks: restoredTracks });
    if (session.master) {
      if (typeof session.master.masterGainDb === "number") setMasterGainDb(session.master.masterGainDb);
      if (typeof session.master.limiterEnabled === "boolean") setLimiterEnabled(session.master.limiterEnabled);
      if (typeof session.master.limiterThresh === "number") setLimiterThresh(session.master.limiterThresh);
      if (Array.isArray(session.master.masterEq7)) setMasterEq7(session.master.masterEq7);
      if (session.master.masterComp) setMasterComp(session.master.masterComp);
    }
    if (typeof session.bpm === "number") setBpm(session.bpm);
    if (typeof session.zoom === "number") setZoom(session.zoom);
    if (session.loop) {
      if (session.loop.range) setLoopRange(session.loop.range);
      if (typeof session.loop.enabled === "boolean") setLoopEnabled(session.loop.enabled);
    }
    if (session.flags) {
      if (typeof session.flags.clickEnabled === "boolean") setClickEnabled(session.flags.clickEnabled);
      if (typeof session.flags.gridEnabled === "boolean") setGridEnabled(session.flags.gridEnabled);
    }
    setStatus(`✓ Loaded session (${restoredTracks.length} tracks)`);
  }, []);

  const sendToDeck = useCallback(async (deck: "A" | "B" | "C") => {
    const liveTracks = tracks.filter(t => t.regions.some(r => r.buffer) && !t.muted && (!anySolo || t.solo));
    if (!liveTracks.length) { setStatus("Nothing to send."); return; }
    const sr = 44100;
    const offline = new OfflineAudioContext(2, Math.ceil(totalDurMs / 1000 * sr), sr);
    liveTracks.forEach(t => {
      const trackGain = offline.createGain();
      trackGain.gain.value = dbToLinear(t.gainDb);
      trackGain.connect(offline.destination);
      t.regions.forEach(r => {
        if (!r.buffer) return;
        const src = offline.createBufferSource(); src.buffer = r.buffer;
        src.connect(trackGain);
        src.start(r.offsetMs / 1000, r.trimStartMs / 1000, regionDurMs(r) / 1000);
      });
    });
    setStatus(`Rendering for Deck ${deck}...`);
    const rendered = await offline.startRendering();
    const wav = encodeWav(rendered);
    const blob = new Blob([wav], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    window.dispatchEvent(new CustomEvent("ether:deck-load", { detail: { deck, filePath: url, title: `StudioPro Mix` } }));
    setStatus(`✓ Sent to Deck ${deck}`);
  }, [tracks, anySolo, totalDurMs]);

  // ── Drag: region move / trim ──────────────────────────────────

  const beginRegionDrag = useCallback((
    e: React.MouseEvent, trackId: string, regionId: string, mode: "move" | "trim-l" | "trim-r",
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const t = stateRef.current.tracks.find(x => x.id === trackId);
    const r0 = t?.regions.find(x => x.id === regionId);
    if (!r0 || !r0.buffer) return;
    beginGesture();
    // Alt + edge-drag trims AND lays a fade over exactly the amount trimmed away.
    const withFade = e.altKey && mode !== "move";
    const startX = e.clientX;
    const orig = { offset: r0.offsetMs, ts: r0.trimStartMs, te: r0.trimEndMs };
    const dragDurMs = regionDurMs(r0);
    const maxFadeMs = dragDurMs / 2;
    const playheadSnapshot = playheadMs;
    const snapTargets: number[] = [0, playheadSnapshot];
    for (const t of stateRef.current.tracks) {
      for (const r of t.regions) {
        if (r.id === regionId) continue;
        snapTargets.push(r.offsetMs);
        snapTargets.push(r.offsetMs + regionDurMs(r));
      }
    }
    let currentTrackId = trackId;
    const trackIdAtPoint = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const lane = (el as Element).closest("[data-track-id]");
      return lane ? (lane as HTMLElement).dataset.trackId || null : null;
    };
    const SNAP_PX = 8;
    const beatMs = 60000 / bpm;
    const useGridSnap = gridEnabled;
    const computeSnap = (candidateOffset: number): { offset: number; snapAt: number | null } => {
      const thresholdMs = xToMs(SNAP_PX);
      const candStart = candidateOffset;
      const candEnd   = candidateOffset + dragDurMs;
      let bestDelta = Infinity;
      let bestOffset = candidateOffset;
      let bestTarget: number | null = null;
      for (const target of snapTargets) {
        // The timeline start (0:00) gets a much stronger pull so regions lock to it.
        const th = target === 0 ? thresholdMs * 4 : thresholdMs;
        const dStart = target - candStart;
        const dEnd   = target - candEnd;
        if (Math.abs(dStart) < th && Math.abs(dStart) < Math.abs(bestDelta)) {
          bestDelta = dStart; bestOffset = candidateOffset + dStart; bestTarget = target;
        }
        if (Math.abs(dEnd) < th && Math.abs(dEnd) < Math.abs(bestDelta)) {
          bestDelta = dEnd; bestOffset = candidateOffset + dEnd; bestTarget = target;
        }
      }
      if (useGridSnap) {
        const gridThresholdMs = xToMs(SNAP_PX * 1.5);
        const beatNearStart = Math.round(candStart / beatMs) * beatMs;
        const beatNearEnd   = Math.round(candEnd   / beatMs) * beatMs;
        const dStart = beatNearStart - candStart;
        const dEnd   = beatNearEnd   - candEnd;
        if (Math.abs(dStart) < gridThresholdMs && Math.abs(dStart) < Math.abs(bestDelta)) {
          bestDelta = dStart; bestOffset = candidateOffset + dStart; bestTarget = beatNearStart;
        }
        if (Math.abs(dEnd) < gridThresholdMs && Math.abs(dEnd) < Math.abs(bestDelta)) {
          bestDelta = dEnd; bestOffset = candidateOffset + dEnd; bestTarget = beatNearEnd;
        }
      }
      return { offset: bestOffset, snapAt: bestTarget };
    };
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dms = xToMs(dx);
      if (mode === "move") {
        const rawOffset = Math.max(0, orig.offset + dms);
        const { offset: snappedOffset, snapAt } = computeSnap(rawOffset);
        setSnapMs(snapAt);
        const newOffset = Math.max(0, snappedOffset);
        const targetTrackId = trackIdAtPoint(ev.clientX, ev.clientY);
        if (targetTrackId && targetTrackId !== currentTrackId) {
          dispatch({ type: "MOVE_REGION_TO_TRACK", srcTrackId: currentTrackId, destTrackId: targetTrackId, regionId, offsetMs: newOffset });
          currentTrackId = targetTrackId;
          setSelection({ trackId: targetTrackId, regionId });
        } else {
          dispatch({ type: "MOVE_REGION", trackId: currentTrackId, regionId, offsetMs: newOffset });
        }
      } else if (mode === "trim-l") {
        dispatch({ type: "TRIM_REGION", trackId, regionId, trimStartMs: orig.ts + dms, offsetMs: orig.offset + dms });
        if (withFade) {
          const fade = Math.max(0, Math.min(maxFadeMs, dms));
          dispatch({ type: "UPDATE_REGION", trackId, regionId, patch: { fadeInMs: fade } });
        }
      } else {
        dispatch({ type: "TRIM_REGION", trackId, regionId, trimEndMs: orig.te - dms });
        if (withFade) {
          const fade = Math.max(0, Math.min(maxFadeMs, -dms));
          dispatch({ type: "UPDATE_REGION", trackId, regionId, patch: { fadeOutMs: fade } });
        }
      }
    };
    const onUp = () => {
      setSnapMs(null);
      endGesture();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [xToMs, playheadMs, bpm, gridEnabled, beginGesture, endGesture]);

  const beginFadeDrag = useCallback((
    e: React.MouseEvent, trackId: string, regionId: string, side: "in" | "out",
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const t = stateRef.current.tracks.find(x => x.id === trackId);
    const r0 = t?.regions.find(x => x.id === regionId);
    if (!r0 || !r0.buffer) return;
    beginGesture();
    const startX = e.clientX;
    const orig = side === "in" ? r0.fadeInMs : r0.fadeOutMs;
    const maxMs = regionDurMs(r0) / 2;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dms = xToMs(dx);
      const next = Math.max(0, Math.min(maxMs, orig + (side === "in" ? dms : -dms)));
      dispatch({
        type: "UPDATE_REGION", trackId, regionId,
        patch: side === "in" ? { fadeInMs: next } : { fadeOutMs: next },
      });
    };
    const onUp = () => { endGesture(); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [xToMs, beginGesture, endGesture]);

  // Crossfade: the bottom corner where two clips meet drags BOTH sides of the joint at once —
  // this clip's fade and the neighbour's opposing fade, kept equal. One gesture, one undo entry.
  const beginCrossfadeDrag = useCallback((
    e: React.MouseEvent, trackId: string, regionId: string, side: "left" | "right",
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const t = stateRef.current.tracks.find(x => x.id === trackId);
    const r0 = t?.regions.find(x => x.id === regionId);
    if (!t || !r0 || !r0.buffer) return;
    const myStart = r0.offsetMs;
    const myEnd   = r0.offsetMs + regionDurMs(r0);
    // The neighbour on that side, nearest joint wins.
    let neighbour: StudioRegion | null = null;
    for (const r of t.regions) {
      if (r.id === regionId || !r.buffer) continue;
      const rEnd = r.offsetMs + regionDurMs(r);
      const gap = side === "left" ? Math.abs(myStart - rEnd) : Math.abs(r.offsetMs - myEnd);
      if (gap <= SMART_XFADE_GAP_MS) {
        if (!neighbour) neighbour = r;
        else {
          const nEnd = neighbour.offsetMs + regionDurMs(neighbour);
          const nGap = side === "left" ? Math.abs(myStart - nEnd) : Math.abs(neighbour.offsetMs - myEnd);
          if (gap < nGap) neighbour = r;
        }
      }
    }
    if (!neighbour) return;
    beginGesture();
    const startX = e.clientX;
    // side "left"  → my fade-IN  pairs with the neighbour's fade-OUT
    // side "right" → my fade-OUT pairs with the neighbour's fade-IN
    const origMine  = side === "left" ? r0.fadeInMs        : r0.fadeOutMs;
    const maxMs     = Math.min(regionDurMs(r0), regionDurMs(neighbour)) / 2;
    const nbId      = neighbour.id;
    const onMove = (ev: MouseEvent) => {
      const dms = xToMs(ev.clientX - startX);
      const next = Math.max(0, Math.min(maxMs, origMine + (side === "left" ? dms : -dms)));
      dispatch({
        type: "AUTO_CROSSFADE", trackId,
        updates: side === "left"
          ? [{ regionId, fadeInMs: next },  { regionId: nbId, fadeOutMs: next }]
          : [{ regionId, fadeOutMs: next }, { regionId: nbId, fadeInMs:  next }],
      });
    };
    const onUp = () => { endGesture(); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [xToMs, beginGesture, endGesture]);

  const onLaneDrop = useCallback((e: React.DragEvent, trackId: string) => {
    e.preventDefault();
    let dropMs = 0;
    if (timelineRef.current) {
      const rect = timelineRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + timelineRef.current.scrollLeft;
      dropMs = Math.max(0, xToMs(x));
    }
    // Library search import (2026-07-22): a dragged library result carries our custom payload. Resolve it
    // the standard way (local-first → R2-by-file_key, like a deck load), then load onto this track at the
    // drop position via a file:// URL (the same renderer path ClipEditor uses).
    const libData = e.dataTransfer.getData("application/x-ether-library");
    if (libData) {
      try {
        const item = JSON.parse(libData);
        setLibOpen(false);
        (async () => {
          try {
            const ether = (window as any).ether;
            const r = await ether.invoke("audio:resolve-local-path", item.file_path);
            const p = (r && r.ok && r.filePath) ? r.filePath : item.file_path;
            if (!p) { setStatus(`Couldn't load "${item.title}" — file not on this machine`); return; }
            loadAudio(trackId, "file:///" + String(p).replace(/\\/g, "/"), { title: item.title || "track", atMs: dropMs });
          } catch { setStatus("Couldn't load library track"); }
        })();
      } catch { /* not our payload */ }
      return;
    }
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 1) {
      // Bulk import: first file lands on this track at drop position;
      // additional files create new tracks below.
      const url0 = URL.createObjectURL(files[0]);
      loadAudio(trackId, url0, { title: files[0].name, atMs: dropMs });
      for (let i = 1; i < files.length; i++) {
        const f = files[i];
        // Add a track and load (the timeout ensures track exists in stateRef before load)
        dispatch({ type: "ADD_TRACK", name: f.name });
        const url = URL.createObjectURL(f);
        const idxAtAdd = i;
        setTimeout(() => {
          const newest = (stateRef.current?.tracks || [])[stateRef.current.tracks.length - files.length + idxAtAdd];
          if (newest) loadAudio(newest.id, url, { title: f.name, atMs: dropMs });
        }, 30 * i);
      }
      setStatus(`Importing ${files.length} files...`);
      return;
    }
    const file = files[0];
    if (!file) {
      const path = e.dataTransfer.getData("text/plain");
      if (path) loadAudio(trackId, path, { atMs: dropMs });
      return;
    }
    const url = URL.createObjectURL(file);
    loadAudio(trackId, url, { title: file.name, atMs: dropMs });
  }, [loadAudio, xToMs]);

  // ── Ctrl/Cmd + wheel = zoom around cursor ─────────────────────

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorViewportX = e.clientX - rect.left;
      const cursorContentX  = cursorViewportX + el.scrollLeft;
      const cursorMs = (cursorContentX / pps) * 1000;
      const factor = e.deltaY > 0 ? 1 / 1.15 : 1.15;
      setZoom(prev => {
        const next = clamp(prev * factor, MIN_ZOOM, maxZoomRef.current);
        requestAnimationFrame(() => {
          if (!timelineRef.current) return;
          const newPps = BASE_PPS * next;
          const newCursorContentX = (cursorMs / 1000) * newPps;
          timelineRef.current.scrollLeft = Math.max(0, newCursorContentX - cursorViewportX);
        });
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pps]);

  const onRulerMouseDown = useCallback((e: React.MouseEvent) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const startX = e.clientX;
    const startMs = Math.max(0, xToMs(startX - rect.left + timelineRef.current.scrollLeft));
    let dragging = false;
    let endMs = startMs;
    const DRAG_THRESHOLD = 3;
    const onMove = (ev: MouseEvent) => {
      if (!timelineRef.current) return;
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) >= DRAG_THRESHOLD) dragging = true;
      if (!dragging) return;
      endMs = Math.max(0, xToMs(ev.clientX - rect.left + timelineRef.current.scrollLeft));
      const lo = Math.min(startMs, endMs);
      const hi = Math.max(startMs, endMs);
      if (hi - lo >= 50) setLoopRange({ startMs: lo, endMs: hi });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (dragging) {
        setLoopEnabled(true);
        setStatus("Loop set · ↻ in toolbar to disable");
      } else {
        setPlayheadMs(startMs);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [xToMs]);

  // ── FX window helpers ─────────────────────────────────────────

  const fxKey = (trackId: string, type: FxWindowType) => `${trackId}:${type}`;

  const toggleFxWindow = useCallback((trackId: string, type: FxWindowType) => {
    setOpenFxWindows(prev => {
      const next = new Map(prev);
      const k = `${trackId}:${type}`;
      if (next.has(k)) {
        next.delete(k);
      } else {
        // Stagger by track index so multiple tracks' windows don't perfectly overlap
        const trackIdx = stateRef.current.tracks.findIndex(t => t.id === trackId);
        const z = ++fxZRef.current;
        next.set(k, {
          trackId, type,
          x: FX_WINDOW_DEFAULT_X[type] + (trackIdx >= 0 ? trackIdx * 24 : 0),
          y: 120 + (trackIdx >= 0 ? trackIdx * 24 : 0),
          z,
        });
      }
      return next;
    });
  }, []);
  const moveFxWindow = useCallback((key: string, x: number, y: number) => {
    setOpenFxWindows(prev => {
      const next = new Map(prev);
      const w = next.get(key);
      if (w) next.set(key, { ...w, x, y });
      return next;
    });
  }, []);
  const bringFxToFront = useCallback((key: string) => {
    setOpenFxWindows(prev => {
      const next = new Map(prev);
      const w = next.get(key);
      if (!w) return prev;
      const z = ++fxZRef.current;
      next.set(key, { ...w, z });
      return next;
    });
  }, []);

  // Close FX windows when the underlying track is removed
  useEffect(() => {
    setOpenFxWindows(prev => {
      const next = new Map(prev);
      let changed = false;
      for (const [k, w] of Array.from(next.entries())) {
        if (!tracks.find(t => t.id === w.trackId)) { next.delete(k); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [tracks]);

  // ── Render mix to AudioBuffer (helper for normalize / cartwall / stream) ──

  const renderMixOffline = useCallback(async (): Promise<AudioBuffer | null> => {
    const liveTracks = tracks.filter(t => t.regions.some(r => r.buffer) && !t.muted && (!anySolo || t.solo));
    if (!liveTracks.length) return null;
    const sr = 44100;
    const totalSec = totalDurMs / 1000;
    const offline = new OfflineAudioContext(2, Math.ceil(totalSec * sr), sr);
    // Use a simple direct mix (bypass master FX for normalize-target purity)
    liveTracks.forEach(t => {
      const trackGain = offline.createGain();
      trackGain.gain.value = dbToLinear(t.gainDb);
      trackGain.connect(offline.destination);
      t.regions.forEach(r => {
        if (!r.buffer) return;
        const src = offline.createBufferSource(); src.buffer = r.buffer;
        const peak = dbToLinear(r.clipGainDb || 0);
        const rg = offline.createGain();
        rg.gain.setValueAtTime(peak, r.offsetMs / 1000);
        src.connect(rg).connect(trackGain);
        src.start(r.offsetMs / 1000, r.trimStartMs / 1000, regionDurMs(r) / 1000);
      });
    });
    return await offline.startRendering();
  }, [tracks, anySolo, totalDurMs]);

  // ── Auto-normalize: measure rendered LUFS, adjust master gain to target ──

  const measureIntegratedLUFS = (rendered: AudioBuffer): number => {
    // K-weighted approximation using RMS over the rendered buffer.
    // Simplified: compute mean square of all samples (no real K-weighting filter
    // since we'd need OfflineAudioContext with biquads — but the offset between
    // RMS dBFS and LUFS is roughly -0.5 to -1 for typical content).
    let sumSq = 0;
    let n = 0;
    for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
      const data = rendered.getChannelData(ch);
      for (let i = 0; i < data.length; i++) { sumSq += data[i] * data[i]; n++; }
    }
    const ms = sumSq / Math.max(1, n);
    return ms > 1e-10 ? -0.691 + 10 * Math.log10(ms) : -Infinity;
  };

  const autoNormalize = useCallback(async (target: number) => {
    setStatus(`Measuring loudness...`);
    const rendered = await renderMixOffline();
    if (!rendered) { setStatus("Nothing to normalize."); return; }
    const integrated = measureIntegratedLUFS(rendered);
    if (!isFinite(integrated)) { setStatus("Mix is silent."); return; }
    const delta = target - integrated;
    setMasterGainDb(prev => clamp(prev + delta, -24, 12));
    setStatus(`✓ Normalized: ${integrated.toFixed(1)} → ${target} LUFS (Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} dB)`);
  }, [renderMixOffline]);

  // ── Send to cart wall + Stream this mix (CustomEvent dispatch) ──

  // Quick import (file-pick) — rides the SAME verified path as the drag-and-drop lane import: a picked
  // file becomes a blob URL loaded via loadAudio onto a fresh track. Replaces the removed dead "send to
  // cart wall / stream" buttons (they dispatched CustomEvents no one listened to — decoration, per the
  // reel-splitter inventory). The real send lives in the region editor's Send bar (StudioSendBar).
  const importFiles = useCallback((files: File[]) => {
    if (!files.length) return;
    files.forEach((f, i) => {
      dispatch({ type: "ADD_TRACK", name: f.name });
      const url = URL.createObjectURL(f);
      setTimeout(() => {
        const tracks = stateRef.current?.tracks || [];
        const newest = tracks[tracks.length - files.length + i];
        if (newest) loadAudio(newest.id, url, { title: f.name });
      }, 30 * (i + 1));
    });
    setStatus(`Importing ${files.length} file${files.length === 1 ? "" : "s"}…`);
  }, [loadAudio]);

  const pickImport = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "audio/*"; input.multiple = true;
    input.onchange = () => importFiles(Array.from(input.files || []));
    input.click();
  }, [importFiles]);

  // ── Session Version Control ───────────────────────────────────

  // Seed default session row
  useEffect(() => {
    (async () => {
      try {
        const now = Date.now();
        await execute(
          `INSERT OR IGNORE INTO studio_sessions (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
          [sessionId, sessionName, now, now]
        );
      } catch (e) {
        console.warn("[StudioPro] DB init failed:", e);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build a serializable snapshot (same shape as saveSession, no AudioBuffers)
  const buildSnapshot = useCallback((): string => {
    const tracksJson = stateRef.current.tracks.map(t => ({
      ...t,
      regions: t.regions
        .filter(r => r.filePath && !r.filePath.startsWith("blob:"))
        .map(r => ({
          id: r.id, filePath: r.filePath,
          offsetMs: r.offsetMs, trimStartMs: r.trimStartMs, trimEndMs: r.trimEndMs,
          fadeInMs: r.fadeInMs, fadeOutMs: r.fadeOutMs, clipGainDb: r.clipGainDb,
        })),
      // Strip non-serializable fields
      buffer: undefined, peaks: undefined,
    }));
    return JSON.stringify({
      version: 1, savedAt: Date.now(),
      tracks: tracksJson, markers: stateRef.current.markers,
      master: { masterGainDb, limiterEnabled, limiterThresh, masterEq7, masterComp },
      bpm, zoom,
    });
  }, [masterGainDb, limiterEnabled, limiterThresh, masterEq7, masterComp, bpm, zoom]);

  // Load all versions for current session from DB
  const loadVersions = useCallback(async () => {
    try {
      const rows = await query<SessionVersion>(
        `SELECT id, session_id, version_number, label, created_at,
                json_array_length(json(snapshot), '$.tracks') as track_count
         FROM studio_session_versions
         WHERE session_id = ?
         ORDER BY version_number DESC`,
        [sessionId]
      );
      setVersions(rows ?? []);
    } catch (e) {
      console.warn("[StudioPro] loadVersions failed:", e);
    }
  }, [sessionId]);

  // ── Collaboration Notes ───────────────────────────────────────

  const loadNotes = useCallback(async () => {
    try {
      const rows = await query<StudioNote>(
        `SELECT * FROM studio_notes WHERE session_id = ? ORDER BY position_ms ASC`,
        [sessionId]
      );
      setNotes(rows ?? []);
    } catch (e) {
      console.warn("[StudioPro] loadNotes failed:", e);
    }
  }, [sessionId]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  const addNote = useCallback(async (posMs: number, text: string) => {
    const author = currentUser?.name || "Unknown";
    // Assign color based on how many distinct authors exist so far
    const authors = Array.from(new Set(notes.map(n => n.author)));
    if (!authors.includes(author)) authors.push(author);
    const color = NOTE_COLORS[authors.indexOf(author) % NOTE_COLORS.length];
    const note: StudioNote = {
      id: uuid(), session_id: sessionId, position_ms: posMs,
      track_id: null, author, text, color, resolved: 0, created_at: Date.now(),
    };
    try {
      await execute(
        `INSERT INTO studio_notes (id, session_id, position_ms, track_id, author, text, color, resolved, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [note.id, note.session_id, note.position_ms, note.track_id, note.author, note.text, note.color, note.resolved, note.created_at]
      );
      setNotes(prev => [...prev, note].sort((a, b) => a.position_ms - b.position_ms));
    } catch (e) {
      console.warn("[StudioPro] addNote failed:", e);
    }
  }, [sessionId, currentUser, notes]);

  const resolveNote = useCallback(async (id: string) => {
    try {
      await execute(`UPDATE studio_notes SET resolved = 1 WHERE id = ?`, [id]);
      setNotes(prev => prev.map(n => n.id === id ? { ...n, resolved: 1 } : n));
    } catch (e) {
      console.warn("[StudioPro] resolveNote failed:", e);
    }
  }, []);

  const deleteNote = useCallback(async (id: string) => {
    try {
      await execute(`DELETE FROM studio_notes WHERE id = ?`, [id]);
      setNotes(prev => prev.filter(n => n.id !== id));
    } catch (e) {
      console.warn("[StudioPro] deleteNote failed:", e);
    }
  }, []);

  // Save a version snapshot to DB
  const saveVersion = useCallback(async (labelArg?: string, isAutosave = false) => {
    try {
      // Determine label
      let label = labelArg;
      if (!label && !isAutosave) {
        const input = prompt("Name this version:", `Version ${(versions.length + 1)}`);
        if (input === null) return; // cancelled
        label = input || `Version ${versions.length + 1}`;
      }
      if (isAutosave) label = AUTOSAVE_LABEL;

      const now = Date.now();
      const snapshot = buildSnapshot();

      // Next version number
      const maxRow = await query<{ mx: number | null }>(
        `SELECT MAX(version_number) as mx FROM studio_session_versions WHERE session_id = ?`,
        [sessionId]
      );
      const nextNum = (maxRow[0]?.mx ?? 0) + 1;

      await execute(
        `INSERT INTO studio_session_versions (id, session_id, version_number, label, snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuid(), sessionId, nextNum, label, snapshot, now]
      );

      // Update session updated_at
      await execute(`UPDATE studio_sessions SET updated_at = ?, name = ? WHERE id = ?`,
        [now, sessionName, sessionId]);

      // Trim auto-saves if over limit
      if (isAutosave) {
        const autoRows = await query<{ id: string }>(
          `SELECT id FROM studio_session_versions WHERE session_id = ? AND label = ?
           ORDER BY version_number ASC`,
          [sessionId, AUTOSAVE_LABEL]
        );
        const toDelete = autoRows.slice(0, Math.max(0, autoRows.length - MAX_AUTOSAVES));
        for (const r of toDelete) {
          await execute(`DELETE FROM studio_session_versions WHERE id = ?`, [r.id]);
        }
      }

      await loadVersions();
      if (!isAutosave) setStatus(`✓ Version saved: ${label}`);
    } catch (e: any) {
      console.warn("[StudioPro] saveVersion failed:", e);
      if (!isAutosave) setStatus(`✗ Version save failed: ${e?.message}`);
    }
  }, [sessionId, sessionName, versions.length, buildSnapshot, loadVersions]);

  // Restore a version (auto-saves current state first)
  const restoreVersion = useCallback(async (v: SessionVersion) => {
    if (!confirm(`Restore "${v.label || `Version ${v.version_number}`}"?\n\nYour current state will be auto-saved first so nothing is lost.`)) return;
    // Auto-save current state before restoring
    await saveVersion(`Before restore to v${v.version_number}`, false);

    try {
      // We need the full snapshot — fetch it
      const rows = await query<{ snapshot: string }>(
        `SELECT snapshot FROM studio_session_versions WHERE id = ?`, [v.id]
      );
      const snap = rows[0]?.snapshot;
      if (!snap) { setStatus("✗ Snapshot data missing"); return; }
      const session = JSON.parse(snap);

      setStatus("Restoring version — re-fetching audio...");
      const ctx = getCtx();
      const restoredTracks: StudioTrack[] = [];
      for (const tj of session.tracks || []) {
        const restoredRegions: StudioRegion[] = [];
        for (const rj of tj.regions || []) {
          if (!rj.filePath) continue;
          try {
            const url = rj.filePath.startsWith("http") || rj.filePath.startsWith("blob:")
              ? rj.filePath : convertFileSrc(rj.filePath);
            const resp = await fetch(url);
            const ab = await resp.arrayBuffer();
            const buffer = await ctx.decodeAudioData(ab);
            const peaks = extractPeaks(buffer);
            restoredRegions.push({ ...newRegion({}), ...rj, buffer, peaks });
          } catch {}
        }
        restoredTracks.push({ ...newTrack(tj.name || "Track", tj.color || PALETTE[0]), ...tj, regions: restoredRegions });
      }
      dispatch({ type: "REPLACE", tracks: restoredTracks });
      if (session.master) {
        if (typeof session.master.masterGainDb === "number")    setMasterGainDb(session.master.masterGainDb);
        if (typeof session.master.limiterEnabled === "boolean") setLimiterEnabled(session.master.limiterEnabled);
        if (typeof session.master.limiterThresh === "number")   setLimiterThresh(session.master.limiterThresh);
        if (Array.isArray(session.master.masterEq7))            setMasterEq7(session.master.masterEq7);
        if (session.master.masterComp)                          setMasterComp(session.master.masterComp);
      }
      if (typeof session.bpm  === "number") setBpm(session.bpm);
      if (typeof session.zoom === "number") setZoom(session.zoom);
      setPreviewVersionId(null);
      setStatus(`✓ Restored: ${v.label || `Version ${v.version_number}`}`);
      await loadVersions();
    } catch (e: any) {
      setStatus(`✗ Restore failed: ${e?.message}`);
    }
  }, [saveVersion, loadVersions]);

  // Rename session
  const renameSession = useCallback(async (newName: string) => {
    const name = newName.trim() || "Untitled Session";
    setSessionName(name);
    try {
      await execute(`UPDATE studio_sessions SET name = ?, updated_at = ? WHERE id = ?`,
        [name, Date.now(), sessionId]);
    } catch {}
  }, [sessionId]);

  // Keep ref in sync so keyboard handler can call saveVersion without stale closure
  useEffect(() => { saveVersionRef.current = () => saveVersion(); }, [saveVersion]);

  // Load versions when history panel opens
  useEffect(() => {
    if (versionHistoryOpen) loadVersions();
  }, [versionHistoryOpen, loadVersions]);

  // ── Snapshots ─────────────────────────────────────────────────

  const takeSnapshot = useCallback(() => {
    const name = prompt("Snapshot name:", `Snapshot ${snapshots.length + 1}`);
    if (!name) return;
    const snap: MixerSnapshot = {
      id: uuid(), name, takenAt: Date.now(),
      tracksJson: stateRef.current.tracks.map(t => ({
        id: t.id, name: t.name, color: t.color,
        gainDb: t.gainDb, pan: t.pan, muted: t.muted, solo: t.solo, armed: t.armed,
        eq7: [...t.eq7],
        compressor: { ...t.compressor },
        reverb: { ...t.reverb },
        saturation: { ...t.saturation },
        sidechainSourceId: t.sidechainSourceId,
        sidechainAmountDb: t.sidechainAmountDb,
      })),
      master: {
        masterGainDb, limiterEnabled, limiterThresh,
        masterEq7: [...masterEq7], masterComp: { ...masterComp },
      },
    };
    setSnapshots(prev => [...prev, snap]);
    setStatus(`✓ Snapshot saved: ${name}`);
  }, [snapshots, masterGainDb, limiterEnabled, limiterThresh, masterEq7, masterComp]);

  const recallSnapshot = useCallback((snap: MixerSnapshot) => {
    // Apply per-track patches (preserves regions/automation; only restores mixer state)
    snap.tracksJson.forEach((tj: any) => {
      dispatch({ type: "UPDATE_TRACK", id: tj.id, patch: {
        name: tj.name, color: tj.color, gainDb: tj.gainDb, pan: tj.pan,
        muted: tj.muted, solo: tj.solo, armed: tj.armed,
        eq7: tj.eq7, compressor: tj.compressor, reverb: tj.reverb,
        saturation: tj.saturation, sidechainSourceId: tj.sidechainSourceId,
        sidechainAmountDb: tj.sidechainAmountDb,
      }});
    });
    setMasterGainDb(snap.master.masterGainDb);
    setLimiterEnabled(snap.master.limiterEnabled);
    setLimiterThresh(snap.master.limiterThresh);
    setMasterEq7([...snap.master.masterEq7]);
    setMasterComp({ ...snap.master.masterComp });
    setStatus(`✓ Recalled: ${snap.name}`);
  }, []);

  const deleteSnapshot = useCallback((id: string) => {
    setSnapshots(prev => prev.filter(s => s.id !== id));
  }, []);

  // ── Track templates (preset + Add Track combos) ──────────────

  const addTrackFromTemplate = useCallback((template: "vocal" | "music" | "drum" | "plain") => {
    const idx = stateRef.current.tracks.length;
    const color = nextColor(stateRef.current.tracks);
    const name =
      template === "vocal" ? `Vocal ${idx + 1}` :
      template === "music" ? `Music ${idx + 1}` :
      template === "drum"  ? `Drum ${idx + 1}`  :
                             `Track ${idx + 1}`;
    dispatch({ type: "ADD_TRACK", name });
    // Apply preset settings on next tick
    setTimeout(() => {
      const newest = stateRef.current.tracks[stateRef.current.tracks.length - 1];
      if (!newest) return;
      let patch: TrackPatch = { color };
      if (template === "vocal") {
        patch = {
          ...patch,
          eq7: [-4, -3, -2, -1, 0, 1, 2, 3, 2, 1],
          compressor: { on: true, threshold: -18, ratio: 3, attack: 15, release: 200, makeup: 3 },
          reverb: { on: true, type: "plate", wet: 0.18, size: 0.5 },
        };
      } else if (template === "music") {
        patch = { ...patch, eq7: [2, 2, 1, 0, -1, 0, 1, 2, 2, 3] };
      } else if (template === "drum") {
        patch = {
          ...patch,
          compressor: { on: true, threshold: -12, ratio: 6, attack: 2, release: 80, makeup: 4 },
          saturation: { on: true, drive: 6 },
        };
      }
      dispatch({ type: "UPDATE_TRACK", id: newest.id, patch });
    }, 0);
  }, []);

  // ── Region context menu helper ────────────────────────────────

  const openRegionContextMenu = useCallback((e: React.MouseEvent, trackId: string, regionId: string) => {
    e.preventDefault(); e.stopPropagation();
    // Preserve a multi-selection if this region is part of one; otherwise select just it.
    const inMulti = multiSel.trackId === trackId && multiSel.ids.includes(regionId) && multiSel.ids.length >= 2;
    if (!inMulti) {
      setSelection({ trackId, regionId });
      setMultiSel({ trackId, ids: [regionId] });
    } else {
      setSelection({ trackId, regionId });
    }
    const mergeIds = inMulti ? multiSel.ids : [];
    const items = [
      ...(mergeIds.length >= 2 ? [
        { label: `⛓ Merge ${mergeIds.length} clips`, onClick: () => mergeRegions(trackId, mergeIds) },
        { label: "", onClick: () => {}, separator: true },
      ] : []),
      { label: "Split here", onClick: () => {
        // Use cursor X within the region to compute split point
        const target = e.target as HTMLElement;
        const lane = target.closest("[data-track-id]") as HTMLElement | null;
        if (!lane) return;
        const rect = lane.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const t = stateRef.current.tracks.find(x => x.id === trackId);
        const r = t?.regions.find(x => x.id === regionId);
        if (!r) return;
        const ms = r.offsetMs + xToMs(x - (r.offsetMs / 1000) * pps);
        splitRegion(trackId, regionId, ms);
      } },
      { label: "Duplicate (Ctrl+D)", onClick: () => {
        const newId = uuid();
        const t = stateRef.current.tracks.find(x => x.id === trackId);
        const r = t?.regions.find(x => x.id === regionId);
        if (r) dispatch({ type: "DUPLICATE_REGION", trackId, regionId, offsetMs: r.offsetMs + regionDurMs(r), newId });
      } },
      { label: "Copy (Ctrl+C)",  onClick: copySelectedRegion },
      { label: "", onClick: () => {}, separator: true },
      { label: "Delete region",  onClick: () => dispatch({ type: "DELETE_REGION", trackId, regionId }), danger: true },
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  }, [copySelectedRegion, splitRegion, xToMs, pps, multiSel, mergeRegions]);

  const openTrackContextMenu = useCallback((e: React.MouseEvent, trackId: string) => {
    e.preventDefault(); e.stopPropagation();
    const t = stateRef.current.tracks.find(x => x.id === trackId);
    if (!t) return;
    const items = [
      { label: "Open EQ window",     onClick: () => toggleFxWindow(trackId, "eq") },
      { label: "Open Compressor",    onClick: () => toggleFxWindow(trackId, "comp") },
      { label: "Open Reverb / FX",   onClick: () => toggleFxWindow(trackId, "reverb") },
      { label: "", onClick: () => {}, separator: true },
      { label: "Toggle mute (M)",    onClick: () => dispatch({ type: "UPDATE_TRACK", id: trackId, patch: { muted: !t.muted } }) },
      { label: "Toggle solo",        onClick: () => dispatch({ type: "UPDATE_TRACK", id: trackId, patch: { solo: !t.solo } }) },
      { label: "Toggle automation",  onClick: () => dispatch({ type: "UPDATE_TRACK", id: trackId, patch: { automationOpen: !t.automationOpen } }) },
      { label: "Clear all regions",  onClick: () => dispatch({ type: "CLEAR_TRACK", id: trackId }) },
      { label: "", onClick: () => {}, separator: true },
      { label: "Delete track",       onClick: () => dispatch({ type: "DELETE_TRACK", id: trackId }), danger: true },
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  // ── Render ────────────────────────────────────────────────────

  return (
    <div data-studiopro="true" style={{
      display: "flex", flexDirection: "column",
      width: "100%", height: "100%",
      background: "var(--bg-primary)", color: "var(--text-primary)",
      fontFamily: "Inter, system-ui, sans-serif",
      position: "relative",
    }}>
      {/* TOP TOOLBAR */}
      <div style={{
        height: TOOLBAR_H, flex: `0 0 ${TOOLBAR_H}px`,
        background: "var(--bg-primary)", borderBottom: "1px solid var(--border-primary)",
        display: "flex", alignItems: "center", padding: "0 8px", gap: 4,
        overflow: "hidden",
      }}>
        {/* TRANSPORT MOVED OUT (phase a). Play/stop/record/timecode are RANK 1 and now own the
            bottom bar — see <TransportBar/>. A utility row that carried transport alongside BPM,
            zoom, import and export ranked twenty controls equally, which ranks nothing. */}
        <TBtn
          onClick={() => {
            if (!loopRange) { setStatus("Drag on the ruler to set a loop range"); return; }
            setLoopEnabled(v => !v);
          }}
          title={loopRange
            ? `Loop ${loopEnabled ? "ON" : "OFF"} · ${fmtDuration(loopRange.startMs)} → ${fmtDuration(loopRange.endMs)}`
            : "Drag on the ruler to set a loop range"}
          active={loopEnabled && !!loopRange}
        >↻</TBtn>
        <TBtn onClick={() => setClickEnabled(v => !v)} title="Click / metronome" active={clickEnabled}>♩</TBtn>
        <TBtn onClick={() => setGridEnabled(v => !v)} title="Beat grid" active={gridEnabled}>▦</TBtn>

        <div style={{ flex: 1 }} />

        <label style={lbl}>BPM</label>
        <input type="number" min={40} max={240} value={bpm}
          onChange={(e) => setBpm(Math.max(40, Math.min(240, +e.target.value || 120)))}
          style={{ width: 44, background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", padding: "3px 4px", fontSize: "var(--t-micro)", borderRadius: 0 }}
        />
        <div style={{ width: 1, height: 20, background: "var(--border-primary)", flexShrink: 0 }} />
        <TBtn onClick={() => setZoom(z => clamp(z / 1.25, MIN_ZOOM, maxZoom))} title="Zoom out">−</TBtn>
        {/* The range is now 0.002–512, so a fixed percent reads as "0%" at one end and "51200%" at
            the other. Below 1x stays a percent (0.2% is meaningful); at or above 1x it becomes a
            multiplier, which is both shorter and what a DAW operator actually thinks in. */}
        <span style={{ fontSize: "var(--t-micro)", color: "var(--text-secondary)", minWidth: 46, textAlign: "center" }}
              title={`Zoom ${(zoom * 100).toFixed(zoom < 0.1 ? 2 : 0)}% · ceiling ${maxZoom.toFixed(0)}×`}>
          {zoom >= 1 ? `${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×` : `${(zoom * 100).toFixed(zoom < 0.1 ? 1 : 0)}%`}
        </span>
        <TBtn onClick={() => setZoom(z => clamp(z * 1.25, MIN_ZOOM, maxZoom))} title="Zoom in">+</TBtn>
        <TBtn onClick={fitToWindow} title="Fit the whole session in the window (\)">FIT</TBtn>
        <div style={{ width: 1, height: 20, background: "var(--border-primary)", flexShrink: 0 }} />
        <TBtn onClick={() => setMasterFxOpen(v => !v)} title="Master FX (EQ + Compressor + Limiter)" active={masterFxOpen}>FX</TBtn>
        <TBtn onClick={() => setSnapshotsOpen(v => !v)} title="Snapshots — save/recall mixer state" active={snapshotsOpen}>📸</TBtn>
        <NormalizeMenu onPick={(t) => autoNormalize(t)} />
        <TBtn onClick={pickImport} title="Import audio file(s) into the DAW — quick import to chop & send">＋ Import</TBtn>
        {/* Library search import — search the library; drag a result onto any track/timeline. The results
            dropdown is PORTALED to <body> (position:fixed off the input's rect) because the toolbar row
            clips overflow — an in-flow absolute dropdown was hidden. */}
        <div ref={libAnchorRef} style={{ flexShrink: 0 }}>
          <input value={libQ} onChange={e => runLibSearch(e.target.value)} onFocus={() => { if (libResults.length) setLibOpen(true); }}
            placeholder="Search library…" title="Search the library (title/artist) — drag a result onto a track"
            style={{ width: 150, padding: "5px 8px", fontSize: "var(--t-small)", background: "var(--bg-primary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
        </div>
        {libOpen && libResults.length > 0 && libAnchorRef.current && createPortal(
          <div ref={libDropRef} style={{ position: "fixed", top: libAnchorRef.current.getBoundingClientRect().bottom + 3, left: libAnchorRef.current.getBoundingClientRect().left, width: 300, maxHeight: 340, overflowY: "auto", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", zIndex: 99999, boxShadow: "var(--e-float)" }}>
              <div style={{ padding: "5px 10px", fontSize: "var(--t-micro)", fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, borderBottom: "1px solid var(--border-primary)" }}>Drag onto a track ↓</div>
              {libResults.map(r => (
                <div key={r.id} draggable
                  onDragStart={e => { e.dataTransfer.setData("application/x-ether-library", JSON.stringify({ title: r.title, file_path: r.file_path, file_key: r.file_key })); e.dataTransfer.effectAllowed = "copy"; }}
                  style={{ padding: "7px 10px", cursor: "grab", borderBottom: "1px solid var(--border-primary)" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                  <div style={{ fontSize: "var(--t-body)", fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
                  <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>{r.artist || "—"}</div>
                </div>
              ))}
          </div>,
          document.body
        )}
        <div style={{ width: 1, height: 20, background: "var(--border-primary)", flexShrink: 0 }} />
        {/* Session name — double-click to rename */}
        {sessionNameEditing ? (
          <input
            ref={sessionNameInputRef}
            defaultValue={sessionName}
            autoFocus
            onBlur={e => { renameSession(e.target.value); setSessionNameEditing(false); }}
            onKeyDown={e => {
              if (e.key === "Enter") { renameSession((e.target as HTMLInputElement).value); setSessionNameEditing(false); }
              if (e.key === "Escape") setSessionNameEditing(false);
            }}
            style={{
              height: 24, padding: "0 6px", background: "#1a1a2e", color: "#fff",
              border: "1px solid #4f4fcc", outline: "none", fontSize: "var(--t-micro)",
              fontFamily: "Inter, system-ui, sans-serif", borderRadius: 0, width: 110,
            }}
          />
        ) : (
          <div
            onDoubleClick={() => setSessionNameEditing(true)}
            title="Double-click to rename session"
            style={{
              height: 24, padding: "0 6px", display: "flex", alignItems: "center",
              background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)",
              fontSize: "var(--t-micro)", cursor: "default", maxWidth: 120, flexShrink: 0,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {sessionName}
          </div>
        )}
        <TBtn onClick={() => setNotesOpen(v => !v)} title="Collaboration notes" active={notesOpen}>
          Notes{notes.filter(n => !n.resolved).length > 0 ? ` (${notes.filter(n => !n.resolved).length})` : ""}
        </TBtn>
        <TBtn onClick={() => setVersionHistoryOpen(v => !v)} title="Version history" active={versionHistoryOpen}>Hist ▾</TBtn>
        <TBtn onClick={saveSession} title="Save session to disk">💾</TBtn>
        <TBtn onClick={loadSession} title="Load session from disk">📂</TBtn>
        <ExportMenu onExportMix={exportWav} onExportStems={() => exportStems()} />
        {lastExportPath && (
          <button
            onClick={() => verifyWatermark(lastExportPath)}
            title={`Verify watermark: ${lastExportPath}`}
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", background: "rgba(0,200,168,0.1)", border: "1px solid #00c8a8", color: "#00c8a8", fontSize: "var(--t-micro)", fontWeight: 700, cursor: "pointer", letterSpacing: "0.06em" }}
          >🛡 ✓ Watermarked</button>
        )}
        <TBtn onClick={openVerifyFilePicker} title="Verify watermark on any WAV file">🛡 Verify</TBtn>
        <DeckMenu onPick={sendToDeck} />
        <TBtn onClick={() => setEditorOpen(v => !v)} title="Editor — large waveform for precise trim/fade (select a region)" active={editorOpen}>Editor ⤒</TBtn>
        <TBtn onClick={() => setVtOpen(v => !v)} title="Voice Tracker" active={vtOpen}>VT ▾</TBtn>
      </div>

      {/* EDIT TOOLS ROW */}
      <div style={{
        height: 36, flex: "0 0 36px",
        background: "var(--bg-primary)", borderBottom: "1px solid var(--border-primary)",
        display: "flex", alignItems: "center", padding: "0 12px", gap: 6,
      }}>
        {([
          { id: "smart",  icon: <span style={{ fontSize: "var(--t-lead)" }}>✦</span>, label: "Smart",  key: "" },
          { id: "select", icon: <span style={{ fontSize: "var(--t-lead)" }}>⌖</span>, label: "Select", key: "V" },
          { id: "grab",   icon: <span style={{ fontSize: "var(--t-lead)" }}>✋</span>, label: "Grab",   key: "G" },
          { id: "blade",  icon: <IBeamIcon />,                            label: "Splice", key: "C" },
          { id: "trim",   icon: <span style={{ fontSize: "var(--t-lead)" }}>⊢⊣</span>, label: "Trim",   key: "T" },
          { id: "fade",   icon: <span style={{ fontSize: "var(--t-lead)" }}>⌒</span>,  label: "Fade",   key: "F" },
        ] as const).map(t => {
          const active = tool === t.id;
          const accent = selectedTrack?.color || "var(--accent-blue)";
          return (
            <button key={t.id}
              // An explicit tool is an override, so pressing the active one releases it back to smart.
              onClick={() => setTool(cur => (cur === t.id && t.id !== "smart") ? "smart" : (t.id as EditTool))}
              title={t.id === "smart"
                ? "Smart — the cursor follows the pointer's position on the clip"
                : `${t.label} (${t.key}) — click again to release back to Smart`}
              style={{
                height: 26, padding: "0 10px", borderRadius: 0,
                background: active ? `${accent}22` : "var(--button-bg, var(--bg-tertiary))",
                color: active ? accent : "var(--button-text, var(--text-secondary))",
                border: active ? `1px solid ${accent}` : "var(--button-border, 1px solid var(--border-primary))",
                fontSize: "var(--t-body)", cursor: "pointer",
                display: "flex", alignItems: "center", gap: 6,
                fontFamily: "ui-monospace, monospace",
              }}
            >
              {t.icon}
              <span style={{ fontSize: "var(--t-micro)", fontWeight: 700, letterSpacing: 0.5 }}>{t.label}</span>
              <span style={{ fontSize: "var(--t-micro)", color: active ? accent : "var(--text-tertiary)", opacity: 0.7 }}>{t.key}</span>
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>
          {tool === "smart"  && "Edges trim · top corners fade · upper half sets the cursor · lower half moves · bottom corners crossfade · Alt+edge trims with a fade"}
          {tool === "select" && "Click a clip to drop the cursor for a precise cut · Shift-click to multi-select · C splices there"}
          {tool === "grab"   && "Drag clips to move them"}
          {tool === "blade"  && "Click region to cut at cursor"}
          {tool === "trim"   && "Drag region edges or body to trim"}
          {tool === "fade"   && "Drag top-left for fade-in · top-right for fade-out"}
        </span>
      </div>

      {status && (
        <div style={{ height: 20, background: "var(--bg-primary)", borderBottom: "1px solid var(--border-primary)", fontSize: "var(--t-small)", color: "var(--text-secondary)", padding: "2px 12px", display: "flex", alignItems: "center" }}>
          {status}
        </div>
      )}

      {/* MAIN AREA */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
        {/* TRACK HEADERS */}
        <div style={{
          width: HEADER_W, flex: `0 0 ${HEADER_W}px`,
          background: "var(--bg-primary)", borderRight: "1px solid var(--border-primary)",
          display: "flex", flexDirection: "column", position: "relative",
        }}>
          <PaneTabs tabs={["Tracks", "Library"]} active={leftPane}
            onPick={(t) => setLeftPane(t as "Tracks" | "Library")} />
          <div style={{ height: RULER_H, borderBottom: "1px solid var(--border-primary)" }} />
          <div ref={headerScrollRef} onScroll={() => syncScroll("header")}
            style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
            {coloredTracks.map((t, i) => (
              <TrackHeaderRow
                key={t.id}
                track={t}
                height={trackHeights[i]}
                onResizeStart={(e) => beginRowResize(e, t.id)}
                onResizeReset={() => setRowHeights(prev => { const n = { ...prev }; delete n[t.id]; return n; })}
                level={meterLevelsRef.current.perTrack.get(t.id) || 0}
                selected={selection?.trackId === t.id && !selection?.regionId}
                fxOpenSet={new Set(
                  Array.from(openFxWindows.values()).filter(w => w.trackId === t.id).map(w => w.type)
                )}
                onSelect={() => setSelection({ trackId: t.id, regionId: null })}
                onPatch={(patch) => dispatch({ type: "UPDATE_TRACK", id: t.id, patch })}
                onDelete={() => dispatch({ type: "DELETE_TRACK", id: t.id })}
                onColorPick={() => setPaletteForTrack(t.id)}
                showPalette={paletteForTrack === t.id}
                onChooseColor={(c) => { dispatch({ type: "UPDATE_TRACK", id: t.id, patch: { color: c } }); setPaletteForTrack(null); }}
                onClosePalette={() => setPaletteForTrack(null)}
                onToggleFx={(type) => toggleFxWindow(t.id, type)}
                onToggleAutomation={() => dispatch({ type: "UPDATE_TRACK", id: t.id, patch: { automationOpen: !t.automationOpen } })}
                onAddAutomationLane={() => dispatch({ type: "ADD_AUTOMATION_LANE", trackId: t.id, param: "volume" })}
                onRemoveAutomationLane={(laneId) => dispatch({ type: "REMOVE_AUTOMATION_LANE", trackId: t.id, laneId })}
                onSetAutomationParam={(laneId, param) => dispatch({ type: "SET_AUTOMATION_PARAM", trackId: t.id, laneId, param })}
                onContext={(e) => openTrackContextMenu(e, t.id)}
                reductionDb={compReductionRef.current.get(t.id) || 0}
                onToggleOriginal={() => dispatch({ type: "UPDATE_TRACK", id: t.id, patch: { originalContent: !t.originalContent } })}
              />
            ))}
            <AddTrackMenu onAdd={addTrackFromTemplate} />
          </div>
          {leftPane === "Library" && (
            <div style={{
              position: "absolute", inset: 0, top: RULER_H + 30, background: "var(--bg-primary)",
              display: "flex", flexDirection: "column", zIndex: 3,
            }}>
              <div style={{ padding: "var(--s-3) var(--s-4)", borderBottom: "1px solid var(--border-primary)" }}>
                <input value={libQ} onChange={e => runLibSearch(e.target.value)}
                  placeholder="Search library…"
                  style={{
                    width: "100%", background: "var(--bg-secondary)", color: "var(--text-primary)",
                    border: "1px solid var(--border-primary)", borderRadius: "var(--r-0)",
                    padding: "var(--s-2) var(--s-3)", fontSize: "var(--t-body)", outline: "none",
                  }} />
              </div>
              <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
                {libResults.length === 0 ? (
                  <div style={{ padding: "var(--s-5)", fontSize: "var(--t-body)", color: "var(--text-tertiary)" }}>
                    {libQ.trim() ? "Nothing in the library matches that." : "Search the library to place a track."}
                  </div>
                ) : libResults.map((r: any) => (
                  <div key={r.id} title={r.file_path}
                    style={{
                      display: "flex", alignItems: "center", gap: "var(--s-3)", height: 24,
                      padding: "0 var(--s-4)", borderBottom: "1px solid var(--border-primary)",
                      fontSize: "var(--t-body)", color: "var(--text-secondary)",
                    }}>
                    <span style={{
                      flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                      whiteSpace: "nowrap", color: "var(--text-primary)",
                    }}>{r.title}</span>
                    <span style={{
                      fontSize: "var(--t-micro)", color: "var(--text-tertiary)", maxWidth: 90,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>{r.artist || ""}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* TIMELINE */}
        <div ref={timelineRef}
          onScroll={() => { syncScroll("timeline"); syncViewport(); }}
          // The edit surface is explicitly dark — never var(--bg-primary), which two shipped themes
          // define light. This is the outermost timeline container: everything inside inherits it.
          style={{ flex: 1, overflow: "auto", background: SURFACE_DARK, position: "relative" }}
          className="studiopro-scroll"
        >
          {/* Ruler */}
          <div onMouseDown={onRulerMouseDown}
            onContextMenu={(e) => {
              if (!timelineRef.current) return;
              e.preventDefault();
              e.stopPropagation();
              const rect = timelineRef.current.getBoundingClientRect();
              const posMs = Math.max(0, xToMs(e.clientX - rect.left + timelineRef.current.scrollLeft));
              setNoteInput({ posMs, x: e.clientX, y: e.clientY });
              setNoteInputText("");
            }}
            style={{
              height: RULER_H, width: msToX(totalDurMs),
              position: "sticky", top: 0, zIndex: 3,
              background: "var(--bg-primary)", borderBottom: "1px solid var(--border-primary)",
              cursor: "text",
            }}
          >
            <Ruler totalMs={totalDurMs} pps={pps} bpm={bpm} showBeats={gridEnabled} />
            {/* Markers */}
            {state.markers.map(m => (
              <div key={m.id}
                onClick={(e) => { e.stopPropagation(); setPlayheadMs(m.timeMs); }}
                onContextMenu={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  setCtxMenu({
                    x: e.clientX, y: e.clientY,
                    items: [
                      { label: "Rename...", onClick: () => {
                        const v = prompt("Marker label:", m.label);
                        if (v && v.trim()) dispatch({ type: "RENAME_MARKER", id: m.id, label: v.trim() });
                      } },
                      { label: "Jump here", onClick: () => setPlayheadMs(m.timeMs) },
                      { label: "", onClick: () => {}, separator: true },
                      { label: "Delete marker", onClick: () => dispatch({ type: "DELETE_MARKER", id: m.id }), danger: true },
                    ],
                  });
                }}
                title={`${m.label} · ${fmtTimecode(m.timeMs)}`}
                style={{
                  position: "absolute", top: 0, left: msToX(m.timeMs) - 6,
                  width: 12, height: RULER_H,
                  display: "flex", flexDirection: "column", alignItems: "center",
                  cursor: "pointer", zIndex: 4,
                }}
              >
                <div style={{
                  width: 0, height: 0,
                  borderLeft: "6px solid transparent", borderRight: "6px solid transparent",
                  borderTop: `8px solid ${m.color}`,
                  filter: `drop-shadow(0 0 3px ${m.color})`,
                }} />
                <div style={{
                  fontSize: "var(--t-micro)", color: m.color, marginTop: 1,
                  whiteSpace: "nowrap" as const, fontFamily: "ui-monospace, monospace",
                  background: "rgba(8,8,12,0.7)", padding: "0 2px",
                }}>{m.label.slice(0, 10)}</div>
              </div>
            ))}
            {loopRange && (
              <div style={{
                position: "absolute", top: 0,
                left: msToX(loopRange.startMs),
                width: Math.max(2, msToX(loopRange.endMs - loopRange.startMs)),
                height: RULER_H,
                background: loopEnabled ? "#fde04733" : "#fde04711",
                borderLeft: `2px solid ${loopEnabled ? "#fde047" : "#fde04766"}`,
                borderRight: `2px solid ${loopEnabled ? "#fde047" : "#fde04766"}`,
                pointerEvents: "none",
              }} />
            )}
            {/* Note flags */}
            {notes.filter(n => !n.resolved).map(n => (
              <div key={n.id}
                onClick={(e) => { e.stopPropagation(); setNotePopover(prev => prev === n.id ? null : n.id); }}
                title={`${n.author}: ${n.text}`}
                style={{
                  position: "absolute", bottom: 0, left: msToX(n.position_ms) - 5,
                  width: 10, cursor: "pointer", zIndex: 5,
                }}
              >
                <div style={{
                  width: 0, height: 0,
                  borderLeft: "5px solid transparent", borderRight: "5px solid transparent",
                  borderBottom: `8px solid ${n.color}`,
                }} />
                <div style={{ width: 2, height: 6, background: n.color, marginLeft: 4 }} />
                {notePopover === n.id && (
                  <div style={{
                    position: "absolute", bottom: "100%", left: 0,
                    background: "var(--bg-secondary)", border: `1px solid ${n.color}`,
                    padding: "6px 8px", minWidth: 160, maxWidth: 240, zIndex: 20,
                    fontFamily: "Inter, system-ui, sans-serif", fontSize: "var(--t-small)",
                    boxShadow: "var(--e-float)",
                  }}
                    onClick={e => e.stopPropagation()}
                  >
                    <div style={{ color: n.color, fontWeight: 700, marginBottom: 3 }}>{n.author}</div>
                    <div style={{ color: "var(--text-primary)", lineHeight: 1.4 }}>{n.text}</div>
                    <div style={{ color: "var(--text-tertiary)", fontSize: "var(--t-micro)", marginTop: 4 }}>{fmtTimecode(n.position_ms)}</div>
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <button onClick={() => { setPlayheadMs(n.position_ms); setNotePopover(null); }}
                        style={{ flex: 1, padding: "3px 0", fontSize: "var(--t-micro)", background: "rgba(255,255,255,0.05)", color: "var(--text-secondary)", border: "1px solid #333", cursor: "pointer" }}>
                        Jump
                      </button>
                      <button onClick={() => { resolveNote(n.id); setNotePopover(null); }}
                        style={{ flex: 1, padding: "3px 0", fontSize: "var(--t-micro)", background: "rgba(16,185,129,0.1)", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)", cursor: "pointer" }}>
                        Resolve
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {/* Inline note input */}
            {noteInput && (
              <div style={{
                position: "fixed", top: noteInput.y, left: noteInput.x,
                zIndex: 99999, background: "#1a1a1e", border: "1px solid #f59e0b",
                padding: "4px 6px", display: "flex", gap: 4, alignItems: "center",
                boxShadow: "var(--e-float)",
              }}>
                <input
                  autoFocus
                  value={noteInputText}
                  onChange={e => setNoteInputText(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === "Enter" && noteInputText.trim()) {
                      await addNote(noteInput.posMs, noteInputText.trim());
                      setNoteInput(null); setNoteInputText("");
                    }
                    if (e.key === "Escape") { setNoteInput(null); setNoteInputText(""); }
                  }}
                  placeholder="Add note… (Enter to save)"
                  style={{
                    width: 200, padding: "3px 6px", background: "var(--bg-secondary)", color: "#fff",
                    border: "none", outline: "none", fontSize: "var(--t-small)",
                    fontFamily: "Inter, system-ui, sans-serif",
                  }}
                />
                <button onClick={() => { setNoteInput(null); setNoteInputText(""); }}
                  style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: "var(--t-body)" }}>✕</button>
              </div>
            )}
          </div>

          {/* Lanes */}
          <div style={{ position: "relative", width: msToX(totalDurMs), height: totalLanesHeight }}>
            {gridEnabled && (
              <BeatGrid totalMs={totalDurMs} bpm={bpm} pps={pps} height={totalLanesHeight} />
            )}

            {coloredTracks.map((t, i) => (
              <div key={t.id} style={{
                position: "absolute", top: trackTops[i],
                left: 0, width: "100%", height: trackHeights[i],
              }}>
                <TrackLane
                  track={t}
                  pps={pps}
                  laneH={rowBaseHeights[i]}
                  tool={tool}
                  selection={selection}
                  bladeHover={bladeHover?.trackId === t.id ? bladeHover : null}
                  liveRec={(() => {
                    void liveRecTick;
                    const lr = liveRecRef.current;
                    return lr && lr.trackId === t.id ? {
                      startMs: lr.startMs, peaks: lr.peaks, samplePeriodMs: lr.samplePeriodMs,
                    } : null;
                  })()}
                  selectedRegionIds={multiSel.trackId === t.id ? multiSel.ids : []}
                  onSelectRegion={(regionId, additive) => handleRegionSelect(t.id, regionId, additive)}
                  onSelectTrack={() => { setSelection({ trackId: t.id, regionId: null }); setMultiSel({ trackId: null, ids: [] }); }}
                  onDrop={(e) => onLaneDrop(e, t.id)}
                  onRegionDrag={(e, regionId, mode) => beginRegionDrag(e, t.id, regionId, mode)}
                  onBladeHover={(regionId, ms) => setBladeHover({ trackId: t.id, regionId, ms })}
                  onBladeLeave={() => setBladeHover(null)}
                  onBladeSplit={(regionId, ms) => splitRegion(t.id, regionId, ms)}
                  onFadeDrag={(e, regionId, side) => beginFadeDrag(e, t.id, regionId, side)}
                  onCrossfadeDrag={(e, regionId, side) => beginCrossfadeDrag(e, t.id, regionId, side)}
                  viewport={viewport}
                  playheadMs={playheadMs}
                  onRegionContext={(e, regionId) => openRegionContextMenu(e, t.id, regionId)}
                  onOpenEditor={(regionId) => { setSelection({ trackId: t.id, regionId }); setEditorMode("wave"); setEditorOpen(true); }}
                  onSeek={(ms) => setPlayheadMs(Math.max(0, ms))}
                />

                {t.automationOpen && (
                  <div style={{
                    position: "absolute", left: 0, top: rowBaseHeights[i],
                    width: "100%", height: trackHeights[i] - rowBaseHeights[i],
                    background: "var(--bg-primary)", borderTop: "1px solid var(--border-primary)",
                  }}>
                    {/* per-lane stack */}
                    {t.automationLanes.map((lane, li) => (
                      <AutomationLaneView
                        key={lane.id}
                        track={t}
                        lane={lane}
                        pps={pps}
                        totalDurMs={totalDurMs}
                        topY={li * AUTOMATION_LANE_H}
                        selectedPointId={selectedAutoPoint?.laneId === lane.id ? selectedAutoPoint.pointId : null}
                        onSelectPoint={(pid) => setSelectedAutoPoint(pid ? { trackId: t.id, laneId: lane.id, pointId: pid } : null)}
                        onAddPoint={(timeMs, value) => dispatch({ type: "ADD_AUTO_POINT", trackId: t.id, laneId: lane.id, point: { id: uuid(), timeMs, value } })}
                        onMovePoint={(pointId, timeMs, value) => dispatch({ type: "MOVE_AUTO_POINT", trackId: t.id, laneId: lane.id, pointId, timeMs, value })}
                        onDeletePoint={(pointId) => dispatch({ type: "DELETE_AUTO_POINT", trackId: t.id, laneId: lane.id, pointId })}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* Loop range overlay on lanes */}
            {loopRange && tracks.length > 0 && (
              <div style={{
                position: "absolute", top: 0,
                left: msToX(loopRange.startMs),
                width: Math.max(2, msToX(loopRange.endMs - loopRange.startMs)),
                height: totalLanesHeight,
                background: loopEnabled ? "#fde04711" : "transparent",
                borderLeft:  `1px dashed ${loopEnabled ? "#fde047aa" : "#fde04755"}`,
                borderRight: `1px dashed ${loopEnabled ? "#fde047aa" : "#fde04755"}`,
                pointerEvents: "none", zIndex: 3,
              }} />
            )}

            {/* Marker lines on lanes */}
            {state.markers.map(m => (
              <div key={m.id} style={{
                position: "absolute", top: 0,
                left: msToX(m.timeMs),
                width: 1, height: totalLanesHeight,
                background: m.color, opacity: 0.25,
                pointerEvents: "none", zIndex: 3,
              }} />
            ))}

            {/* Snap indicator */}
            {snapMs !== null && (
              <div style={{
                position: "absolute", left: msToX(snapMs), top: 0,
                width: 2, height: totalLanesHeight,
                background: "#fde047",
                boxShadow: "var(--e-0)",
                pointerEvents: "none", zIndex: 4,
              }} />
            )}

            {/* Playhead */}
            <div style={{
              position: "absolute", left: msToX(playheadMs), top: 0,
              width: 1, height: totalLanesHeight,
              background: "#ef4444",
              boxShadow: "var(--e-0)",
              pointerEvents: "none", zIndex: 5,
            }} />
          </div>
        </div>

        {/* RIGHT PANE — Inspector now; Mixer strips land here in phase (b). */}
        <div style={{
          width: INSPECTOR_W, flex: `0 0 ${INSPECTOR_W}px`,
          background: "var(--bg-primary)", borderLeft: "1px solid var(--border-primary)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}>
          <PaneTabs tabs={["Inspector", "Mixer"]} active={rightPane}
            onPick={(t) => setRightPane(t as "Inspector" | "Mixer")} />
          {rightPane === "Mixer" ? (
            <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
              <MixerStrips
                tracks={coloredTracks}
                levels={meterLevelsRef.current.perTrack}
                masterLevel={meterLevelsRef.current.master}
                masterGainDb={masterGainDb}
                selectedId={selection?.trackId ?? null}
                onSelect={(id) => setSelection({ trackId: id, regionId: null })}
                onPatch={(id, patch) => dispatch({ type: "UPDATE_TRACK", id, patch })}
              />
            </div>
          ) : (
          <div style={{ flex: 1, padding: 12, overflowY: "auto", minHeight: 0 }}>
          <Inspector
            track={selectedTrack}
            region={selectedRegion}
            masterGainDb={masterGainDb}
            setMasterGainDb={setMasterGainDb}
            limiterEnabled={limiterEnabled}
            setLimiterEnabled={setLimiterEnabled}
            limiterThresh={limiterThresh}
            setLimiterThresh={setLimiterThresh}
            masterLevel={meterLevelsRef.current.master}
            masterAnalyser={masterAnalyserRef.current}
            loopRange={loopRange}
            onClearLoop={() => { setLoopRange(null); setLoopEnabled(false); }}
            onPatchTrack={(patch) => selectedTrack && dispatch({ type: "UPDATE_TRACK", id: selectedTrack.id, patch })}
            onPatchRegion={(patch) => selectedTrack && selectedRegion && dispatch({ type: "UPDATE_REGION", trackId: selectedTrack.id, regionId: selectedRegion.id, patch })}
            onClear={() => selectedTrack && dispatch({ type: "CLEAR_TRACK", id: selectedTrack.id })}
            onDeleteRegion={() => selectedTrack && selectedRegion && dispatch({
              type: "DELETE_REGION", trackId: selectedTrack.id, regionId: selectedRegion.id,
            })}
            onOpenEq={() => { if (selectedTrack) { setEditorMode("eq"); setEditorOpen(true); } }}
          />
          </div>
          )}
        </div>
      </div>

      {/* ══ RANK 1 — TRANSPORT BAR. Owns the bottom; nothing else lives here. (phase a) ══ */}
      <TransportBar
        playing={playing}
        recording={recording}
        recordArmed={recordArmed}
        playheadMs={playheadMs}
        selStartMs={loopRange?.startMs ?? null}
        selEndMs={loopRange?.endMs ?? null}
        sessionEndMs={Math.max(0, ...tracks.map(trackEndMs))}
        masterLevel={meterLevelsRef.current.master}
        lufsMomentary={lufsMomentaryRef.current}
        onPlay={() => (playing ? stop() : play())}
        onStop={stop}
        onRecord={toggleRecord}
        onArm={() => setRecordArmed(v => !v)}
        onReturnStart={returnToStart}
        onEnd={() => setPlayheadMs(Math.max(0, ...tracks.map(trackEndMs)))}
      />

      {/* MASTER FX WINDOW */}
      {masterFxOpen && (
        <MasterFxWindow
          ctx={getCtx()}
          position={masterFxPos}
          masterGainDb={masterGainDb} setMasterGainDb={setMasterGainDb}
          limiterEnabled={limiterEnabled} setLimiterEnabled={setLimiterEnabled}
          limiterThresh={limiterThresh} setLimiterThresh={setLimiterThresh}
          masterEq7={masterEq7} setMasterEq7={setMasterEq7}
          masterComp={masterComp} setMasterComp={setMasterComp}
          masterAnalyser={masterAnalyserRef.current}
          masterLAnalyser={masterLAnalyserRef.current}
          masterRAnalyser={masterRAnalyserRef.current}
          masterLevel={meterLevelsRef.current.master}
          lufsMomentary={lufsMomentaryRef.current}
          correlation={correlationRef.current}
          onClose={() => setMasterFxOpen(false)}
          onMove={(x, y) => setMasterFxPos(p => ({ ...p, x, y }))}
        />
      )}

      {/* FX WINDOWS — one per (track, type) */}
      {Array.from(openFxWindows.entries()).map(([k, win]) => {
        const t = tracks.find(x => x.id === win.trackId);
        if (!t) return null;
        return (
          <FxWindow
            key={k}
            track={t}
            allTracks={tracks}
            type={win.type}
            position={win}
            ctx={getCtx()}
            reductionDb={compReductionRef.current.get(win.trackId) || 0}
            onClose={() => toggleFxWindow(win.trackId, win.type)}
            onMove={(x, y) => moveFxWindow(k, x, y)}
            onBringToFront={() => bringFxToFront(k)}
            getAnalyser={() => trackAnalysersRef.current.get(win.trackId) ?? null}
            onPatch={(patch) => dispatch({ type: "UPDATE_TRACK", id: win.trackId, patch })}
          />
        );
      })}

      {/* EDITOR DRAWER — GarageBand-style push-up editor (waveform / EQ) */}
      <div style={{
        height: editorOpen ? (editorMode === "eq" ? 380 : 268) : 0,
        transition: "height 140ms ease",
        borderTop: editorOpen ? "1px solid var(--border-primary)" : "none",
        background: "var(--bg-primary)", overflow: "hidden", flex: "0 0 auto",
      }}>
        {editorOpen && (
          <RegionEditorDrawer
            track={selectedTrack}
            region={selectedRegion}
            playheadMs={playheadMs}
            mode={editorMode}
            onMode={setEditorMode}
            ctx={getCtx()}
            stationId={stationId}
            onClose={() => setEditorOpen(false)}
            onPatchRegion={(patch) => selectedTrack && selectedRegion && dispatch({
              type: "UPDATE_REGION", trackId: selectedTrack.id, regionId: selectedRegion.id, patch,
            })}
            onPatchTrack={(patch) => selectedTrack && dispatch({ type: "UPDATE_TRACK", id: selectedTrack.id, patch })}
            onSeek={(ms) => setPlayheadMs(ms)}
            getAnalyser={() => selectedTrack ? trackAnalysersRef.current.get(selectedTrack.id) ?? null : null}
          />
        )}
      </div>

      {/* VT DRAWER */}
      <div style={{
        height: vtOpen ? DRAWER_H : 0,
        transition: "height 140ms ease",
        borderTop: vtOpen ? "1px solid var(--border-primary)" : "none",
        background: "var(--bg-primary)", overflow: "hidden", flex: `0 0 auto`,
      }}>
        {vtOpen && (
          <div style={{ height: "100%", overflow: "auto" }}>
            <VoiceTracker />
          </div>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* Snapshots panel */}
      {snapshotsOpen && (
        <SnapshotsPanel
          snapshots={snapshots}
          onTake={takeSnapshot}
          onRecall={recallSnapshot}
          onDelete={deleteSnapshot}
          onClose={() => setSnapshotsOpen(false)}
        />
      )}

      {/* Version history panel */}
      {versionHistoryOpen && (
        <VersionHistoryPanel
          sessionName={sessionName}
          versions={versions}
          previewVersionId={previewVersionId}
          onPreview={id => setPreviewVersionId(id === previewVersionId ? null : id)}
          onRestore={restoreVersion}
          onSaveVersion={() => saveVersion()}
          onClose={() => setVersionHistoryOpen(false)}
        />
      )}

      {notesOpen && (
        <NotesDrawer
          notes={notes}
          onJump={(ms) => setPlayheadMs(ms)}
          onResolve={resolveNote}
          onDelete={deleteNote}
          onClose={() => setNotesOpen(false)}
        />
      )}

      {/* Keyboard help overlay */}
      {helpOpen && <KeyboardHelpOverlay onClose={() => setHelpOpen(false)} />}

      {exportWmDialog && (
        <ExportWatermarkDialog
          onConfirm={(v) => { setExportWmDialog(null); exportWmDialog.resolve(v); }}
        />
      )}

      {wmDialogPath && (
        <WatermarkVerifyDialog
          filePath={wmDialogPath}
          result={wmResult}
          verifying={wmVerifying}
          onClose={() => { setWmDialogPath(null); setWmResult(null); }}
        />
      )}

      <style>{`
        .studiopro-scroll::-webkit-scrollbar { width: 14px; height: 14px; }
        .studiopro-scroll::-webkit-scrollbar-track { background: #0d0d0f; }
        .studiopro-scroll::-webkit-scrollbar-thumb { background: #333340; border: 2px solid #0d0d0f; }
        .studiopro-scroll::-webkit-scrollbar-thumb:hover { background: #4a4a5a; }
      `}</style>
    </div>
  );
}

// ── Subcomponents ───────────────────────────────────────────────

function IBeamIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="9"  y1="3" x2="15" y2="3" />
      <line x1="9"  y1="21" x2="15" y2="21" />
    </svg>
  );
}

function TBtn({ children, onClick, title, active, danger }: {
  children: React.ReactNode; onClick: () => void; title?: string;
  active?: boolean; danger?: boolean;
}) {
  return (
    <button onClick={onClick} title={title}
      style={{
        height: 24, minWidth: 24, padding: "0 6px",
        background: danger ? "#7f1d1d" : active ? "#1e293b" : "var(--button-bg, var(--bg-tertiary))",
        color: danger ? "#fff" : "var(--button-text, var(--text-secondary))",
        border: danger ? "1px solid #ef4444" : active ? "1px solid #334155" : "var(--button-border, 1px solid var(--border-primary))",
        fontSize: "var(--t-micro)", cursor: "pointer", borderRadius: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        letterSpacing: 0, whiteSpace: "nowrap", flexShrink: 0,
      }}
    >{children}</button>
  );
}
const lbl: React.CSSProperties = { fontSize: "var(--t-micro)", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 0.5 };

// ── Shared toolbar/panel dropdown ───────────────────────────────
// ROOT FIX for clipped menus: the menu is PORTALED to <body> and positioned
// with position:fixed, so it escapes every ancestor overflow:hidden (e.g. the
// top toolbar) and stacking context. zIndex 4000 sits ABOVE all editor content
// but BELOW modals/dialogs (9999) and the right-click context menu (99999), so
// dialogs still cover it. Every toolbar menu uses this — none can be clipped by
// a parent container again. Closes on select, pointer-leave, outside-click, or
// scroll/resize (repositions while open).
function ToolbarMenu({ label, title, minWidth = 140, children }: {
  label: React.ReactNode;
  title?: string;
  minWidth?: number;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: Math.max(4, window.innerWidth - r.right) });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const reposition = () => place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);   // capture — catch scroll in any ancestor
    document.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [open, place]);

  const close = useCallback(() => setOpen(false), []);
  return (
    <div ref={anchorRef} style={{ position: "relative" }}>
      <TBtn onClick={() => setOpen(o => !o)} title={title} active={open}>{label}</TBtn>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          onMouseLeave={close}
          style={{
            position: "fixed", top: pos.top, right: pos.right,
            background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
            zIndex: 4000, minWidth,
          }}
        >
          {children(close)}
        </div>,
        document.body,
      )}
    </div>
  );
}

function MenuItem({ children, onClick, fontSize = 12 }: {
  children: React.ReactNode; onClick: () => void; fontSize?: number;
}) {
  return (
    <button onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left", padding: "6px 10px",
        background: "transparent", color: "var(--text-primary)", border: "none",
        fontSize, cursor: "pointer", borderRadius: 0, whiteSpace: "nowrap",
      }}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-tertiary)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >{children}</button>
  );
}

function DeckMenu({ onPick }: { onPick: (d: "A" | "B" | "C") => void }) {
  return (
    <ToolbarMenu label="To Deck ▾" title="Send to deck" minWidth={120}>
      {(close) => (["A", "B", "C"] as const).map(d => (
        <MenuItem key={d} onClick={() => { close(); onPick(d); }}>Deck {d}</MenuItem>
      ))}
    </ToolbarMenu>
  );
}

function SpectrumAnalyzer({ analyser, width, height }: { analyser: AnalyserNode | null; width: number; height: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(2, Math.floor(width * dpr));
    cv.height = Math.max(2, Math.floor(height * dpr));
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    let raf = 0;
    const N = analyser ? analyser.frequencyBinCount : 0;
    const buf = new Uint8Array(N);
    const draw = () => {
      g.clearRect(0, 0, width, height);
      if (analyser) {
        analyser.getByteFrequencyData(buf);
        const bars = 64;
        for (let i = 0; i < bars; i++) {
          const lo = Math.floor(Math.pow(i / bars, 2.2) * N);
          const hi = Math.floor(Math.pow((i + 1) / bars, 2.2) * N);
          let m = 0;
          for (let k = lo; k < hi && k < N; k++) if (buf[k] > m) m = buf[k];
          const v = m / 255;
          const bw = width / bars;
          const bh = v * (height - 2);
          const hue = 200 - v * 200;
          g.fillStyle = `hsl(${hue}, 90%, ${40 + v * 30}%)`;
          g.fillRect(i * bw + 0.5, height - bh, bw - 1, bh);
        }
      } else {
        g.fillStyle = "#222";
        g.fillRect(0, 0, width, height);
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser, width, height]);
  return <canvas ref={canvasRef} style={{ width, height, display: "block", marginTop: 4, background: "#050508" }} />;
}

function MeterBar({ level, color, height = 4, width = 120, vertical = false }: {
  level: number; color: string; height?: number; width?: number; vertical?: boolean;
}) {
  const v = Math.min(1, Math.max(0, level));
  const pct = v <= 0 ? 0 : Math.min(1, (linearToDb(v) + 60) / 60);
  const overshoot = v >= 0.99 ? "#ef4444" : v >= 0.7 ? "#f59e0b" : color;
  if (vertical) {
    return (
      <div style={{ width, height, background: "#1a1a1e", overflow: "hidden", position: "relative" }}>
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          height: pct * height, background: overshoot, transition: "height 50ms linear",
        }} />
      </div>
    );
  }
  const w = pct * width;
  return (
    <div style={{ width, height, background: "#1a1a1e", overflow: "hidden", position: "relative" }}>
      <div style={{ width: w, height: "100%", background: overshoot, transition: "width 50ms linear" }} />
      {v >= 0.99 && (
        <div style={{ position: "absolute", right: 0, top: 0, width: 2, height: "100%", background: "#ef4444", boxShadow: "var(--e-0)" }} />
      )}
    </div>
  );
}

function TrackHeaderRow({
  track, height, level, reductionDb, selected, fxOpenSet,
  onSelect, onPatch, onDelete,
  onColorPick, showPalette, onChooseColor, onClosePalette,
  onToggleFx, onToggleAutomation,
  onAddAutomationLane, onRemoveAutomationLane, onSetAutomationParam,
  onContext, onToggleOriginal, onResizeStart, onResizeReset,
}: {
  track: StudioTrack;
  height: number;
  level: number;
  reductionDb: number;
  onResizeStart: (e: React.MouseEvent) => void;
  onResizeReset: () => void;
  selected: boolean;
  fxOpenSet: Set<FxWindowType>;
  onSelect: () => void;
  onPatch: (p: TrackPatch) => void;
  onDelete: () => void;
  onColorPick: () => void;
  showPalette: boolean;
  onChooseColor: (c: string) => void;
  onClosePalette: () => void;
  onToggleFx: (type: FxWindowType) => void;
  onToggleAutomation: () => void;
  onAddAutomationLane: () => void;
  onRemoveAutomationLane: (laneId: string) => void;
  onSetAutomationParam: (laneId: string, param: AutomationParam) => void;
  onContext: (e: React.MouseEvent) => void;
  onToggleOriginal: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(track.name);
  useEffect(() => setName(track.name), [track.name]);
  const [showFxMenu, setShowFxMenu] = useState(false);
  const fxAnyOpen = fxOpenSet.size > 0;
  const [shieldWarned, setShieldWarned] = useState(() => localStorage.getItem("ether_shield_warned") === "1");
  const [shieldTooltip, setShieldTooltip] = useState(false);

  return (
    <div onClick={onSelect}
      onContextMenu={onContext}
      style={{
        height,
        borderBottom: "1px solid var(--border-primary)",
        background: selected ? "#141419" : "transparent",
        cursor: "pointer", position: "relative",
      }}
    >
      {/* Row resize handle (drag the bottom edge) */}
      <div
        onMouseDown={onResizeStart}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => { e.stopPropagation(); onResizeReset(); }}
        title="Drag to resize · double-click to reset height"
        style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 7, cursor: "row-resize", zIndex: 6 }}
      >
        <div style={{ position: "absolute", left: "50%", bottom: 2, transform: "translateX(-50%)", width: 28, height: 2, borderRadius: "var(--r-0)", background: "var(--border-primary)" }} />
      </div>
      {/* Top row (matches TRACK_H) */}
      <div style={{
        height: TRACK_H, padding: "var(--s-3) var(--s-4)",
        display: "flex", flexDirection: "column", gap: 4,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div onClick={(e) => { e.stopPropagation(); onColorPick(); }}
            style={{ width: 12, height: 12, flexShrink: 0, background: track.color, cursor: "pointer" }} />
          {editing ? (
            <input autoFocus value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => { setEditing(false); onPatch({ name: name || "Track" }); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              style={{ flex: 1, background: "var(--bg-secondary)", color: "#fff", border: "1px solid #333", fontSize: "var(--t-body)", padding: "2px 4px", borderRadius: 0 }}
            />
          ) : (
            <div onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
              style={{ flex: 1, fontSize: "var(--t-lead)", fontWeight: 500, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >{track.name}</div>
          )}
          {/* AUTOMATION DISCLOSURE. Was a borderless ▾ at #555 — a speck you had to know was
              there. It is now a labelled button the same size as M/S/FX, amber when lanes are
              open, so the control announces itself instead of being discovered by hovering. */}
          <MiniBtn active={track.automationOpen} activeColor="var(--accent-amber)"
            onClick={(e) => { e.stopPropagation(); onToggleAutomation(); }}
          >A</MiniBtn>
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete track"
            style={{ background: "transparent", border: "none", color: "var(--text-tertiary)", fontSize: "var(--t-lead)", cursor: "pointer", padding: "0 2px" }}
          >×</button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <MiniBtn active={track.muted} activeColor="#ef4444"
            onClick={(e) => { e.stopPropagation(); onPatch({ muted: !track.muted }); }}>M</MiniBtn>
          <MiniBtn active={track.solo} activeColor="#f59e0b"
            onClick={(e) => { e.stopPropagation(); onPatch({ solo: !track.solo }); }}>S</MiniBtn>
          <MiniBtn active={track.armed} activeColor="#ef4444"
            onClick={(e) => { e.stopPropagation(); onPatch({ armed: !track.armed }); }}>⏺</MiniBtn>
          <MiniBtn active={fxAnyOpen} activeColor="#22c55e"
            onClick={(e) => { e.stopPropagation(); setShowFxMenu(v => !v); }}>FX</MiniBtn>
          <div style={{ position: "relative" }}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!shieldWarned && !track.originalContent) {
                  setShieldTooltip(true);
                  setTimeout(() => setShieldTooltip(false), 5000);
                  localStorage.setItem("ether_shield_warned", "1");
                  setShieldWarned(true);
                }
                onToggleOriginal();
              }}
              title="Mark as original content you own"
              style={{ background: "transparent", border: "none", color: track.originalContent ? "#00c8a8" : "#555", fontSize: "var(--t-small)", cursor: "pointer", padding: "0 2px", lineHeight: 1 }}
            >🛡</button>
            {shieldTooltip && (
              <div style={{ position: "absolute", bottom: "100%", left: 0, zIndex: 50, width: 180, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", padding: "6px 8px", fontSize: "var(--t-micro)", color: "#c0c0d8", lineHeight: 1.4, marginBottom: 4 }}>
                Only enable for content <strong>you created or own</strong>. Do not mark commercial music or content owned by others.
              </div>
            )}
          </div>
          {/* PAN sits beside the level, so a rough balance is settable without opening the mixer —
              the mixer is for the considered pass. Writes through the same onPatch. */}
          <Fader min={-48} max={6} step={0.5} value={track.gainDb}
            onChange={(v) => onPatch({ gainDb: v })}
            style={{ flex: 1, minWidth: 40 }}
          />
        </div>

        {/* PAN — the control the header was missing. Same dispatch the mixer strip uses, so the
            two surfaces cannot disagree about where a track sits in the image. */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
          <span style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", width: 22 }}>PAN</span>
          <input type="range" min={-1} max={1} step={0.02} value={track.pan}
            onChange={(e) => onPatch({ pan: +e.target.value })}
            onDoubleClick={() => onPatch({ pan: 0 })}
            title="Pan — double-click to centre"
            style={{ flex: 1, minWidth: 40, accentColor: track.color, height: 14, cursor: "pointer" }} />
          <span style={{
            fontFamily: "ui-monospace, monospace", fontSize: "var(--t-micro)",
            color: "var(--text-tertiary)", width: 26, textAlign: "right",
          }}>{track.pan === 0 ? "C" : track.pan < 0 ? `L${Math.round(-track.pan * 100)}` : `R${Math.round(track.pan * 100)}`}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <MeterBar level={level} color={track.color} width={HEADER_W - 60} />
          {/* Per-track gain-reduction meter (only visible when comp is on) */}
          {track.compressor.on && (
            <div title={`GR: ${reductionDb.toFixed(1)} dB`}
              style={{ width: 30, height: 4, background: "#1a1a1e", overflow: "hidden", position: "relative" }}
            >
              <div style={{
                position: "absolute", right: 0, top: 0, bottom: 0,
                width: `${Math.min(100, Math.max(0, -reductionDb / 18 * 100))}%`,
                background: "#22c55e",
              }} />
            </div>
          )}
        </div>
      </div>

      {/* Automation header row (when open) */}
      {track.automationOpen && (
        <div style={{
          height: AUTOMATION_BAR_H,
          background: "var(--bg-primary)",
          borderTop: "1px solid var(--border-primary)",
          display: "flex", alignItems: "center", padding: "0 8px", gap: 4,
        }}>
          <span style={{ fontSize: "var(--t-micro)", color: "var(--text-secondary)", letterSpacing: 0.5, textTransform: "uppercase", flex: 1 }}>
            {track.automationLanes.length} lane{track.automationLanes.length === 1 ? "" : "s"}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onAddAutomationLane(); }}
            title="Add automation lane"
            style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: "var(--t-micro)", cursor: "pointer", padding: "2px 6px", borderRadius: 0 }}
          >+ Lane</button>
        </div>
      )}

      {/* Per-lane control rows */}
      {track.automationOpen && track.automationLanes.map(lane => (
        <div key={lane.id} style={{
          height: AUTOMATION_LANE_H,
          background: "var(--bg-primary)",
          borderTop: "1px solid var(--border-primary)",
          display: "flex", alignItems: "center", padding: "0 8px", gap: 4,
        }}>
          <select value={lane.param}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onSetAutomationParam(lane.id, e.target.value as AutomationParam)}
            style={{ flex: 1, background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", fontSize: "var(--t-micro)", padding: "2px 4px", borderRadius: 0 }}
          >
            {Object.entries(AUTOMATION_SPECS).map(([k, spec]) => (
              <option key={k} value={k}>{spec.label}</option>
            ))}
          </select>
          <button onClick={(e) => { e.stopPropagation(); onRemoveAutomationLane(lane.id); }}
            title="Remove lane"
            style={{ background: "transparent", border: "none", color: "var(--text-tertiary)", fontSize: "var(--t-lead)", cursor: "pointer", padding: "0 2px" }}
          >×</button>
        </div>
      ))}

      {showPalette && (
        <div onClick={(e) => e.stopPropagation()} onMouseLeave={onClosePalette}
          style={{
            position: "absolute", top: 24, left: 8, zIndex: 30,
            background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: 6,
            display: "grid", gridTemplateColumns: "repeat(6, 16px)", gap: 4,
          }}
        >
          {PALETTE.map(c => (
            <div key={c} onClick={() => onChooseColor(c)}
              style={{ width: 16, height: 16, background: c, cursor: "pointer" }} />
          ))}
        </div>
      )}

      {showFxMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          onMouseLeave={() => setShowFxMenu(false)}
          style={{
            position: "absolute", top: 50, left: 8, zIndex: 40,
            background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
            padding: 4, minWidth: 180,
            boxShadow: "var(--e-0)",
          }}
        >
          {(["eq", "comp", "reverb"] as const).map(type => {
            const open = fxOpenSet.has(type);
            return (
              <button
                key={type}
                onClick={(e) => { e.stopPropagation(); onToggleFx(type); }}
                style={{
                  display: "flex", alignItems: "center",
                  width: "100%", padding: "6px 8px",
                  background: open ? `${track.color}22` : "transparent",
                  color: open ? track.color : "#ccc",
                  border: "none",
                  fontSize: "var(--t-small)", fontWeight: 600, cursor: "pointer",
                  textAlign: "left" as const,
                  letterSpacing: 0.3,
                }}
              >
                <span style={{ width: 14, color: track.color }}>
                  {open ? "✓" : ""}
                </span>
                <span style={{ flex: 1 }}>{FX_WINDOW_LABELS[type]}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MiniBtn({ children, onClick, active, activeColor }: {
  children: React.ReactNode; onClick: (e: React.MouseEvent) => void;
  active?: boolean; activeColor?: string;
}) {
  return (
    <button onClick={onClick}
      style={{
        width: 26, height: 20, fontSize: "var(--t-small)", fontWeight: 700,
        background: active ? (activeColor || "#333") : "var(--button-bg, var(--bg-tertiary))",
        color: active ? "#fff" : "var(--button-text, var(--text-secondary))",
        border: active ? `1px solid ${activeColor || "#333"}` : "var(--button-border, 1px solid var(--border-primary))",
        cursor: "pointer", borderRadius: 0, padding: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >{children}</button>
  );
}

function Ruler({ totalMs, pps, bpm, showBeats }: { totalMs: number; pps: number; bpm: number; showBeats: boolean }) {
  const totalSec = Math.ceil(totalMs / 1000);
  const ticks: React.ReactNode[] = [];
  for (let s = 0; s <= totalSec; s++) {
    const x = s * pps;
    const isMajor = s % 5 === 0;
    ticks.push(<div key={`s${s}`} style={{
      position: "absolute", left: x, top: 0,
      height: isMajor ? RULER_H : RULER_H / 2,
      width: 1, background: isMajor ? "#444" : "#262630",
    }} />);
    if (isMajor) {
      ticks.push(<div key={`l${s}`} style={{
        position: "absolute", left: x + 3, top: 2,
        fontSize: "var(--t-micro)", color: "var(--text-tertiary)",
        fontFamily: "ui-monospace, monospace",
      }}>{fmtDuration(s * 1000)}</div>);
    }
  }
  if (showBeats) {
    const beatMs = 60000 / bpm;
    const totalBars = Math.ceil(totalMs / (beatMs * 4));
    for (let bar = 0; bar <= totalBars; bar++) {
      const x = (bar * beatMs * 4 / 1000) * pps;
      ticks.push(<div key={`bar${bar}`} style={{
        position: "absolute", left: x, top: 0,
        fontSize: "var(--t-micro)", color: "#fde04788",
        fontFamily: "ui-monospace, monospace",
        paddingLeft: 2,
      }}>{bar + 1}</div>);
    }
  }
  return <div style={{ position: "relative", height: RULER_H }}>{ticks}</div>;
}

function BeatGrid({ totalMs, bpm, pps, height }: { totalMs: number; bpm: number; pps: number; height: number }) {
  const beatMs = 60000 / bpm;
  const totalBeats = Math.ceil(totalMs / beatMs);
  const lines: React.ReactNode[] = [];
  for (let b = 0; b <= totalBeats; b++) {
    const x = (b * beatMs / 1000) * pps;
    const isBar = b % 4 === 0;
    lines.push(<div key={b} style={{
      position: "absolute", left: x, top: 0,
      width: 1, height,
      background: isBar ? "#fde04733" : "#fde04711",
      pointerEvents: "none",
    }} />);
  }
  return <>{lines}</>;
}

function TrackLane({
  track, pps, laneH, tool, selection, selectedRegionIds, bladeHover, liveRec,
  onSelectRegion, onSelectTrack, onDrop,
  onRegionDrag, onBladeHover, onBladeLeave, onBladeSplit, onFadeDrag, onCrossfadeDrag, viewport, playheadMs,
  onRegionContext, onOpenEditor, onSeek,
}: {
  track: StudioTrack;
  pps: number;
  laneH: number;
  tool: EditTool;
  selection: { trackId: string; regionId: string | null } | null;
  selectedRegionIds: string[];
  bladeHover: { trackId: string; regionId: string; ms: number } | null;
  liveRec: { startMs: number; peaks: number[]; samplePeriodMs: number } | null;
  onSelectRegion: (regionId: string, additive: boolean) => void;
  onSelectTrack: () => void;
  onDrop: (e: React.DragEvent) => void;
  onRegionDrag: (e: React.MouseEvent, regionId: string, mode: "move" | "trim-l" | "trim-r") => void;
  onBladeHover: (regionId: string, ms: number) => void;
  onBladeLeave: () => void;
  onBladeSplit: (regionId: string, ms: number) => void;
  onFadeDrag: (e: React.MouseEvent, regionId: string, side: "in" | "out") => void;
  onCrossfadeDrag: (e: React.MouseEvent, regionId: string, side: "left" | "right") => void;
  viewport: { left: number; width: number };
  playheadMs: number;
  onRegionContext: (e: React.MouseEvent, regionId: string) => void;
  onOpenEditor: (regionId: string) => void;
  onSeek: (ms: number) => void;
}) {
  // Explicit dark base with the track's 4% wash composited ON it, rather than a 4% wash over
  // whatever the theme happens to make the ancestor. The lane is never lighter than the surface.
  const laneBg = `linear-gradient(${track.color}0a, ${track.color}0a), ${SURFACE_DARK}`;
  const empty = track.regions.length === 0;
  return (
    <div data-track-id={track.id}
      onClick={onSelectTrack}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      style={{
        position: "relative", height: laneH,
        background: laneBg,
        borderBottom: "1px solid var(--border-primary)",
        animation: track.armed ? "sp-arm-pulse 1.2s ease-in-out infinite" : undefined,
      }}
    >
      {empty && (
        <div style={{
          position: "absolute", inset: 6,
          border: `1px dashed ${track.color}55`,
          color: track.color + "66", fontSize: "var(--t-small)",
          display: "flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "none",
        }}>Drop audio here</div>
      )}
      {track.regions.map(r => {
        // A crossfade zone only exists where a neighbour actually meets this clip.
        const rStart = r.offsetMs;
        const rEnd   = r.offsetMs + regionDurMs(r);
        let abutsLeft = false, abutsRight = false;
        for (const o of track.regions) {
          if (o.id === r.id || !o.buffer) continue;
          const oEnd = o.offsetMs + regionDurMs(o);
          if (Math.abs(rStart - oEnd) <= SMART_XFADE_GAP_MS) abutsLeft = true;
          if (Math.abs(o.offsetMs - rEnd) <= SMART_XFADE_GAP_MS) abutsRight = true;
        }
        return (
        <RegionBlock key={r.id}
          track={track} region={r} pps={pps} laneH={laneH} tool={tool}
          abutsLeft={abutsLeft} abutsRight={abutsRight} viewport={viewport} playheadMs={playheadMs}
          selected={(selection?.trackId === track.id && selection?.regionId === r.id) || selectedRegionIds.includes(r.id)}
          bladeHoverMs={bladeHover && bladeHover.regionId === r.id ? bladeHover.ms : null}
          onSelect={(additive) => onSelectRegion(r.id, additive)}
          onRegionDrag={(e, mode) => onRegionDrag(e, r.id, mode)}
          onBladeHover={(ms) => onBladeHover(r.id, ms)}
          onBladeLeave={onBladeLeave}
          onBladeSplit={(ms) => onBladeSplit(r.id, ms)}
          onFadeDrag={(e, side) => onFadeDrag(e, r.id, side)}
          onCrossfadeDrag={(e, side) => onCrossfadeDrag(e, r.id, side)}
          onContext={(e) => onRegionContext(e, r.id)}
          onOpenEditor={() => onOpenEditor(r.id)}
          onSeek={onSeek}
        />
        );
      })}
      {liveRec && (
        <LiveRecordingOverlay color={track.color} laneH={laneH}
          startMs={liveRec.startMs} peaks={liveRec.peaks}
          samplePeriodMs={liveRec.samplePeriodMs} pps={pps} />
      )}
      <style>{`
        @keyframes sp-arm-pulse {
          0%,100% { box-shadow: inset 0 0 0 0 rgba(239,68,68,0); }
          50%     { box-shadow: inset 0 0 0 2px rgba(239,68,68,0.5); }
        }
      `}</style>
    </div>
  );
}

// ── Region Editor Drawer ──────────────────────────────────────────
// GarageBand-style push-up editor: the selected region's full clip shown
// large, with draggable trim (left/right) and fade (in/out) handles plus
// click-to-seek. Editing dispatches the same UPDATE_REGION patches the
// timeline uses, so it stays in sync.
function EditorHeader({ title, subtitle, accent, mode, onMode, onClose }: {
  title: string; subtitle: string; accent: string;
  mode: "wave" | "eq"; onMode: (m: "wave" | "eq") => void;
  onClose: () => void;
}) {
  const tab = (m: "wave" | "eq", label: string) => (
    <button onClick={() => onMode(m)}
      style={{
        padding: "3px 11px", fontSize: "var(--t-micro)", fontWeight: 700, letterSpacing: "0.06em", cursor: "pointer", borderRadius: "var(--r-0)",
        border: `1px solid ${mode === m ? accent : "var(--border-primary)"}`,
        background: mode === m ? accent : "var(--bg-tertiary)",
        color: mode === m ? "#fff" : "var(--text-tertiary)",
      }}
    >{label}</button>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", flexShrink: 0 }}>
      <span style={{ width: 9, height: 9, borderRadius: "50%", background: accent, boxShadow: `0 0 8px ${accent}` }} />
      <span style={{ fontSize: "var(--t-body)", fontWeight: 700, color: "var(--text-primary)", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
      <div style={{ display: "flex", gap: 4, marginLeft: 2 }}>
        {tab("wave", "WAVEFORM")}
        {tab("eq", "EQ")}
      </div>
      <span style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", fontFamily: "ui-monospace, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subtitle}</span>
      <button onClick={onClose} title="Close editor"
        style={{ marginLeft: "auto", background: "transparent", border: "none", color: "var(--text-tertiary)", fontSize: "var(--t-head)", cursor: "pointer", lineHeight: 1 }}
      >×</button>
    </div>
  );
}

function RegionEditorDrawer({
  track, region, playheadMs, mode, onMode, ctx, stationId, onClose, onPatchRegion, onPatchTrack, onSeek, getAnalyser,
}: {
  track: StudioTrack | null;
  region: StudioRegion | null;
  playheadMs: number;
  mode: "wave" | "eq";
  onMode: (m: "wave" | "eq") => void;
  ctx: AudioContext;
  stationId: number;
  onClose: () => void;
  onPatchRegion: (p: RegionPatch) => void;
  onPatchTrack: (p: TrackPatch) => void;
  onSeek: (ms: number) => void;
  getAnalyser?: () => AnalyserNode | null;
}) {
  const waveRef = useRef<HTMLDivElement>(null);
  const accent = track?.color || "var(--accent-cyan)";

  // ── EQ mode — the 10-band rack for the selected track ──
  if (mode === "eq") {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <EditorHeader title={track ? track.name : "Editor"} subtitle={track ? "10-band EQ" : "no track selected"} accent={accent} mode={mode} onMode={onMode} onClose={onClose} />
        <div style={{ flex: 1, overflow: "auto", padding: "0 14px 14px" }}>
          {track
            ? <EqGraph track={track} ctx={ctx} onPatch={onPatchTrack} getAnalyser={getAnalyser} trackH={230} />
            : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)", fontSize: "var(--t-body)" }}>Select a track to edit its EQ.</div>}
        </div>
      </div>
    );
  }

  // ── Waveform mode ──
  if (!track || !region || !region.buffer) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <EditorHeader title="Editor" subtitle="no region selected" accent={accent} mode={mode} onMode={onMode} onClose={onClose} />
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)", fontSize: "var(--t-body)" }}>
          Double-click a region in the timeline to edit it here.
        </div>
      </div>
    );
  }

  const durMs     = region.buffer.duration * 1000;
  const trimStart = region.trimStartMs;
  const trimEnd   = durMs - region.trimEndMs;       // right trim edge, ms from clip start
  const visDur    = trimEnd - trimStart;
  const MIN_BODY  = 100;                             // keep ≥100ms of audio
  const pct = (ms: number) => `${Math.max(0, Math.min(100, (ms / durMs) * 100))}%`;
  const u   = (ms: number) => (ms / durMs) * 100;    // 0..100 user units for the svg

  // Drag a handle: convert clientX → clip ms and apply on every move.
  const dragHandle = (e: React.MouseEvent, apply: (ms: number) => void) => {
    e.stopPropagation(); e.preventDefault();
    const el = waveRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const toMs = (cx: number) => Math.max(0, Math.min(durMs, ((cx - rect.left) / rect.width) * durMs));
    apply(toMs(e.clientX));
    const mv = (ev: MouseEvent) => apply(toMs(ev.clientX));
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
  };

  const setTrimStart = (ms: number) => onPatchRegion({ trimStartMs: Math.max(0, Math.min(ms, trimEnd - MIN_BODY)) });
  const setTrimEnd   = (ms: number) => onPatchRegion({ trimEndMs:   Math.max(0, Math.min(durMs - ms, durMs - trimStart - MIN_BODY)) });
  const setFadeIn    = (ms: number) => onPatchRegion({ fadeInMs:    Math.max(0, Math.min(ms - trimStart, visDur)) });
  const setFadeOut   = (ms: number) => onPatchRegion({ fadeOutMs:   Math.max(0, Math.min(trimEnd - ms, visDur)) });

  const fadeInEdge  = trimStart + region.fadeInMs;
  const fadeOutEdge = trimEnd - region.fadeOutMs;

  // Global playhead → clip space (region occupies [offsetMs, offsetMs+visDur]).
  const headClipMs = trimStart + (playheadMs - region.offsetMs);
  const headVisible = headClipMs >= trimStart - 1 && headClipMs <= trimEnd + 1;

  const handleBar = (leftMs: number, onDown: (e: React.MouseEvent) => void, label: string) => (
    <div onMouseDown={onDown} title={label}
      style={{ position: "absolute", top: 0, bottom: 0, left: pct(leftMs), width: 12, transform: "translateX(-50%)", cursor: "ew-resize", zIndex: 4 }}>
      <div style={{ position: "absolute", top: 0, bottom: 0, left: "50%", width: 2, transform: "translateX(-50%)", background: track.color, boxShadow: `0 0 6px ${track.color}` }} />
      <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 10, height: 22, borderRadius: "var(--r-0)", background: track.color, boxShadow: "var(--e-0)" }} />
    </div>
  );

  const fadeHandle = (leftMs: number, onDown: (e: React.MouseEvent) => void, label: string) => (
    <div onMouseDown={onDown} title={label}
      style={{ position: "absolute", top: 2, left: pct(leftMs), width: 16, height: 16, transform: "translateX(-50%)", cursor: "ew-resize", zIndex: 5 }}>
      <div style={{ width: 11, height: 11, margin: "0 auto", borderRadius: "50%", background: "#efeaff", border: `2px solid ${track.color}`, boxShadow: "var(--e-0)" }} />
    </div>
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <EditorHeader
        title={region.filePath ? (region.filePath.split(/[\\/]/).pop() || track.name) : `${track.name} — recorded`}
        subtitle={`${fmtDuration(visDur)}  ·  trim ${fmtDuration(trimStart)} / ${fmtDuration(region.trimEndMs)}  ·  fade ${region.fadeInMs.toFixed(0)} / ${region.fadeOutMs.toFixed(0)} ms`}
        accent={track.color}
        mode={mode}
        onMode={onMode}
        onClose={onClose}
      />
      <div
        ref={waveRef}
        onMouseDown={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const ms = ((e.clientX - rect.left) / rect.width) * durMs;
          const clamped = Math.max(trimStart, Math.min(trimEnd, ms));
          onSeek(region.offsetMs + (clamped - trimStart));
        }}
        style={{ position: "relative", flex: 1, margin: "0 14px 14px", border: `1px solid ${track.color}55`, background: "#07070b", cursor: "text", overflow: "hidden" }}
      >
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <WaveformGL
            peaks={region.peaks}
            viewStart={0} viewEnd={1}
            cueIn={0} cueOut={1} introEnd={0} outroStart={1}
            playhead={-1} hoverPos={null} dragRegion={null}
            tint={track.color}
            label={`editor/${region.id.slice(0, 6)}`}
          />
        </div>

        {/* trimmed-out shading */}
        {trimStart > 0 && (
          <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: pct(trimStart), background: "rgba(0,0,0,0.62)", pointerEvents: "none" }} />
        )}
        {region.trimEndMs > 0 && (
          <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: pct(region.trimEndMs), background: "rgba(0,0,0,0.62)", pointerEvents: "none" }} />
        )}

        {/* fade ramps */}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
          {region.fadeInMs > 0 && (
            <polygon points={`${u(trimStart)},100 ${u(fadeInEdge)},0 ${u(fadeInEdge)},100`} fill={track.color} fillOpacity={0.22} />
          )}
          {region.fadeOutMs > 0 && (
            <polygon points={`${u(fadeOutEdge)},0 ${u(trimEnd)},100 ${u(fadeOutEdge)},100`} fill={track.color} fillOpacity={0.22} />
          )}
        </svg>

        {/* playhead */}
        {headVisible && (
          <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(headClipMs), width: 2, transform: "translateX(-50%)", background: "#fff", boxShadow: "var(--e-0)", pointerEvents: "none", zIndex: 3 }} />
        )}

        {/* handles */}
        {handleBar(trimStart, (e) => dragHandle(e, setTrimStart), "Trim start")}
        {handleBar(trimEnd,   (e) => dragHandle(e, setTrimEnd),   "Trim end")}
        {fadeHandle(fadeInEdge,  (e) => dragHandle(e, setFadeIn),  "Fade in")}
        {fadeHandle(fadeOutEdge, (e) => dragHandle(e, setFadeOut), "Fade out")}
      </div>

      {/* Chop & send — the selection is the region's trimmed span [trimStart,trimEnd] of region.buffer.
          Four real exits (Library / Jingle / Sweeper / Deck) via the shared imaging engine + real deck path. */}
      <StudioSendBar
        buffer={region.buffer}
        startSec={trimStart / 1000}
        endSec={trimEnd / 1000}
        defaultName={(region.filePath ? (region.filePath.split(/[\\/]/).pop() || track.name) : track.name).replace(/\.[^.]+$/, "")}
        stationId={stationId}
        ctx={ctx}
      />
    </div>
  );
}

function RegionBlock({
  track, region, pps, laneH, tool, selected, bladeHoverMs, abutsLeft, abutsRight, viewport, playheadMs,
  onSelect, onRegionDrag, onBladeHover, onBladeLeave, onBladeSplit, onFadeDrag, onCrossfadeDrag,
  onContext, onOpenEditor, onSeek,
}: {
  track: StudioTrack; region: StudioRegion; pps: number; laneH: number; tool: EditTool;
  selected: boolean; bladeHoverMs: number | null;
  abutsLeft: boolean; abutsRight: boolean;
  viewport: { left: number; width: number };
  playheadMs: number;
  onSelect: (additive: boolean) => void;
  onRegionDrag: (e: React.MouseEvent, mode: "move" | "trim-l" | "trim-r") => void;
  onBladeHover: (ms: number) => void;
  onBladeLeave: () => void;
  onBladeSplit: (ms: number) => void;
  onFadeDrag: (e: React.MouseEvent, side: "in" | "out") => void;
  onCrossfadeDrag: (e: React.MouseEvent, side: "left" | "right") => void;
  onContext: (e: React.MouseEvent) => void;
  onOpenEditor: () => void;
  onSeek: (ms: number) => void;
}) {
  // The zone under the pointer right now — set on hover, BEFORE any click, so the cursor
  // is the affordance. null when the pointer is elsewhere or an explicit tool is active.
  const [smartZone, setSmartZone] = useState<SmartZone | null>(null);
  const durMs   = regionDurMs(region);
  const regionX = (region.offsetMs / 1000) * pps;
  const regionW = (durMs / 1000) * pps;
  const fadeInX  = Math.min(regionW, (region.fadeInMs  / 1000) * pps);
  const fadeOutX = Math.min(regionW, (region.fadeOutMs / 1000) * pps);
  // Fade bounds handed to the renderer in ITS normalized space (fraction of the whole buffer),
  // so the waveform's amplitude tapers under the fade instead of the fade being a decal on top.
  const bufMs        = region.buffer ? region.buffer.duration * 1000 : 0;
  const vStart       = bufMs ? region.trimStartMs / bufMs : 0;
  const vEnd         = bufMs ? 1 - region.trimEndMs / bufMs : 1;
  const fadeInEndT   = bufMs && region.fadeInMs  > 0 ? vStart + region.fadeInMs  / bufMs : undefined;
  const fadeOutStartT= bufMs && region.fadeOutMs > 0 ? vEnd   - region.fadeOutMs / bufMs : undefined;

  // ── Viewport slice ──
  // The canvas covers only the part of this clip that is on screen (plus a margin). At full zoom a
  // whole-clip canvas is ~160,000px wide — past every driver's MAX_TEXTURE_SIZE, where the draw
  // fails silently and the clip paints nothing. Slicing bounds canvas width by the WINDOW rather
  // than by the song, so zoom depth no longer decides whether a clip can render at all.
  const visLeft  = Math.max(regionX, viewport.left - VIEWPORT_RENDER_MARGIN_PX);
  const visRight = Math.min(regionX + regionW, viewport.left + viewport.width + VIEWPORT_RENDER_MARGIN_PX);
  const sliceOn  = viewport.width > 0 && visRight > visLeft;
  // Offsets are relative to the clip's own box, which is what the canvas is positioned inside.
  const sliceX   = sliceOn ? visLeft - regionX : 0;
  const sliceW   = sliceOn ? visRight - visLeft : regionW;
  const fracA    = regionW > 0 ? sliceX / regionW : 0;
  const fracB    = regionW > 0 ? (sliceX + sliceW) / regionW : 1;
  const sliceVStart = vStart + fracA * (vEnd - vStart);
  const sliceVEnd   = vStart + fracB * (vEnd - vStart);

  // ── Render mode for the visible slice, chosen by samples per device pixel ──
  const { detail, spp } = useMemo(() => {
    const none = { detail: null as WaveDetail | null, spp: -1 };
    const buf = region.buffer;
    if (!sliceOn || !buf) return none;
    const dpr     = typeof window === "undefined" ? 1 : (window.devicePixelRatio || 1);
    const deviceW = Math.max(1, sliceW * dpr);
    const startSec = sliceVStart * buf.duration;
    const endSec   = sliceVEnd   * buf.duration;
    const samplesPerPx = ((endSec - startSec) * buf.sampleRate) / deviceW;
    if (samplesPerPx <= 0) return none;
    // Synchronous by construction — every extractor scans only the slice, so there is no "pending"
    // state in which the clip could blank. A refusal returns null and the coarse/mip path draws.
    if (samplesPerPx < SAMPLE_MODE_SPP) {
      const d = sliceDetailCached(region, sliceVStart, sliceVEnd, 0, "samples",
                                  () => extractSamplesRange(buf, startSec, endSec, SAMPLE_MAX_POINTS));
      if (d) return { detail: d, spp: samplesPerPx };
    }
    if (samplesPerPx < PEAKRMS_MODE_SPP) {
      const res = Math.max(256, Math.min(DETAIL_MAX_RESOLUTION,
                           Math.round(deviceW * DETAIL_BARS_PER_DEVICE_PX)));
      if ((endSec - startSec) * buf.sampleRate <= DETAIL_MAX_SAMPLES) {
        const d = sliceDetailCached(region, sliceVStart, sliceVEnd, res, "envelope",
                                    () => extractEnvelopeRange(buf, startSec, endSec, res));
        if (d) return { detail: d, spp: samplesPerPx };
      }
    }
    return { detail: null, spp: samplesPerPx };
  }, [sliceOn, region, region.buffer, region.trimStartMs, region.trimEndMs, sliceW, sliceVStart, sliceVEnd]);

  // ── Playback cursor, mapped from the timeline into this clip's own normalized space ──
  // Driven by the DAW's AudioContext clock via playheadMs (the rAF tick at :2138) — NOT the
  // daemon, which governs on-air state only. -1 keeps it off-screen when the playhead is elsewhere.
  const relPlay   = durMs > 0 ? (playheadMs - region.offsetMs) / durMs : -1;
  const playheadT = relPlay >= 0 && relPlay <= 1 ? vStart + relPlay * (vEnd - vStart) : -1;
  const regionMouseToMs = (ev: React.MouseEvent, el: HTMLElement): number => {
    const rect = el.getBoundingClientRect();
    const xWithinRegion = ev.clientX - rect.left;
    return region.offsetMs + (xWithinRegion / pps) * 1000;
  };
  const zoneAtEvent = (e: React.MouseEvent, el: HTMLElement): SmartZone => {
    const rect = el.getBoundingClientRect();
    return smartZoneAt(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, abutsLeft, abutsRight);
  };
  const onRegionMouseDown = (e: React.MouseEvent) => {
    if (!region.buffer) return;
    const el = e.currentTarget as HTMLElement;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    onSelect(additive);
    // Shift/ctrl/cmd-click is a multi-select toggle — don't start a move drag.
    if (additive) { e.stopPropagation(); e.preventDefault(); return; }
    // Smart tool: the zone under the pointer IS the gesture. No toolbar round-trip.
    if (tool === "smart") {
      const z = zoneAtEvent(e, el);
      if (z === "fade-in")  { onFadeDrag(e, "in");         return; }
      if (z === "fade-out") { onFadeDrag(e, "out");        return; }
      if (z === "xfade-l")  { onCrossfadeDrag(e, "left");  return; }
      if (z === "xfade-r")  { onCrossfadeDrag(e, "right"); return; }
      if (z === "trim-l")   { onRegionDrag(e, "trim-l");   return; }
      if (z === "trim-r")   { onRegionDrag(e, "trim-r");   return; }
      if (z === "move")     { onRegionDrag(e, "move");     return; }
      onSeek(regionMouseToMs(e, el));   // "ibeam" — drop the cursor for a precise cut
      return;
    }
    if (tool === "blade") {
      const ms = regionMouseToMs(e, el);
      onBladeHover(ms); onBladeSplit(ms);
      e.stopPropagation(); e.preventDefault();
      return;
    }
    if (tool === "fade") {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x <= FADE_ZONE) onFadeDrag(e, "in");
      else if (x >= rect.width - FADE_ZONE) onFadeDrag(e, "out");
      return;
    }
    if (tool === "trim") {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      onRegionDrag(e, x < rect.width / 2 ? "trim-l" : "trim-r");
      return;
    }
    // Grab tool moves clips; Select tool drops a precise cursor (playhead) at the click.
    if (tool === "grab") { onRegionDrag(e, "move"); return; }
    if (tool === "select") onSeek(regionMouseToMs(e, el));
  };
  const onRegionMouseMove = (e: React.MouseEvent) => {
    if (!region.buffer) return;
    const el = e.currentTarget as HTMLElement;
    if (tool === "smart") { setSmartZone(zoneAtEvent(e, el)); return; }
    if (tool !== "blade") return;
    onBladeHover(regionMouseToMs(e, el));
  };
  const onRegionMouseLeave = () => { setSmartZone(null); onBladeLeave(); };
  const regionCursor =
    tool === "smart"  ? (smartZone ? SMART_CURSOR[smartZone] : "default") :
    tool === "blade"  ? "text" :
    tool === "select" ? "text" :
    tool === "trim"   ? "ew-resize" :
    tool === "fade"   ? "cell" :
    tool === "grab"   ? "grab" :
                        "default";
  if (!region.buffer) return null;
  return (
    <div
      onMouseDown={onRegionMouseDown}
      onMouseMove={onRegionMouseMove}
      onMouseLeave={onRegionMouseLeave}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => { e.stopPropagation(); onSelect(false); onOpenEditor(); }}
      onContextMenu={onContext}
      style={{
        position: "absolute",
        left: regionX, top: 4, width: regionW, height: laneH - 8,
        // CONTRAST FLIP: the signal is the brightest thing in the lane, so the body it sits on has
        // to get out of the way. The tint drops from 1f (12%) to 0d (5%) — a near-dark wash — and
        // track identity moves to the border and the header strip below, which are chrome the
        // waveform never has to compete with.
        background: `linear-gradient(${track.color}0d, ${track.color}0d), ${SURFACE_DARK}`,
        // A 2px white selection border on a clip only a few pixels wide IS the clip — zoomed far
        // out, a selected region painted as a solid white block. Narrow clips keep a 1px, dimmer
        // edge so selection still reads without the border swallowing the body.
        border: regionW < OVERLAY_VISIBILITY_THRESHOLD_PX
          ? `1px solid ${selected ? "rgba(255,255,255,0.55)" : track.color + "99"}`
          : `${selected ? 2 : 1}px solid ${selected ? "#fff" : track.color + "99"}`,
        cursor: regionCursor, overflow: "hidden",
      }}
    >
      {/* Positioned over the visible slice only — never the full clip width. */}
      {sliceOn && (
        <div style={{ position: "absolute", left: sliceX, top: 0, width: sliceW, height: "100%", pointerEvents: "none" }}>
          <WaveformGL
            peaks={region.peaks}
            detail={detail}
            samplesPerPixel={spp}
            peaksStart={detail ? sliceVStart : 0}
            peaksEnd={detail ? sliceVEnd : 1}
            viewStart={sliceVStart}
            viewEnd={sliceVEnd}
            clipStart={vStart}
            clipEnd={vEnd}
            cueIn={0} cueOut={1} introEnd={0} outroStart={1}
            playhead={playheadT} hoverPos={null} dragRegion={null}
            tint={track.color}
            fadeInEnd={fadeInEndT}
            fadeOutStart={fadeOutStartT}
            label={`${track.name}/${region.id.slice(0, 6)}`}
            clipDurationMs={durMs}
            clipStartMs={region.offsetMs}
            zoom={pps / 80}
            fullClipPx={Math.round(regionW)}
          />
        </div>
      )}
      {(fadeInX > 0 || fadeOutX > 0) && (
        <svg width={regionW} height={laneH - 8} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          {fadeInX > 0 && (
            <>
              <polygon points={`0,${laneH - 8} ${fadeInX},0 ${fadeInX},${laneH - 8}`} fill={track.color} fillOpacity={0.18} />
              <line x1={0} y1={laneH - 8} x2={fadeInX} y2={0} stroke={track.color} strokeWidth={1.5} strokeOpacity={0.9} />
            </>
          )}
          {fadeOutX > 0 && (
            <>
              <polygon points={`${regionW - fadeOutX},0 ${regionW},${laneH - 8} ${regionW - fadeOutX},${laneH - 8}`} fill={track.color} fillOpacity={0.18} />
              <line x1={regionW - fadeOutX} y1={0} x2={regionW} y2={laneH - 8} stroke={track.color} strokeWidth={1.5} strokeOpacity={0.9} />
            </>
          )}
        </svg>
      )}
      {tool === "blade" && bladeHoverMs !== null && (() => {
        const regionStartMs = region.offsetMs;
        const regionEnd     = region.offsetMs + durMs;
        if (bladeHoverMs <= regionStartMs || bladeHoverMs >= regionEnd) return null;
        const bx = ((bladeHoverMs - regionStartMs) / 1000) * pps;
        return (
          <div style={{
            position: "absolute", left: bx, top: 0,
            width: 1, height: "100%",
            background: track.color, boxShadow: `0 0 4px ${track.color}`,
            pointerEvents: "none",
          }} />
        );
      })()}
      {/* Header strip — carries the track colour the clip body gave up in the contrast flip, so
          identity survives without competing with the signal. Suppressed on clips too narrow to
          read, via the same structural threshold as every other overlay. */}
      {regionW >= OVERLAY_VISIBILITY_THRESHOLD_PX && (
        <div style={{
          position: "absolute", left: 0, right: 0, top: 0, height: 3,
          background: track.color, opacity: 0.85, pointerEvents: "none",
        }} />
      )}
      <div style={{
        position: "absolute", left: 4, top: 5,
        fontSize: "var(--t-micro)", color: "#fff", opacity: 0.9,
        textShadow: "0 0 3px rgba(0,0,0,0.8)", pointerEvents: "none",
      }}>{track.name}</div>
      <div style={{
        position: "absolute", right: 4, bottom: 2,
        fontSize: "var(--t-micro)", color: "#fff", opacity: 0.7,
        fontFamily: "ui-monospace, monospace",
        textShadow: "0 0 3px rgba(0,0,0,0.8)", pointerEvents: "none",
      }}>{fmtDuration(durMs)}</div>
      {(tool === "grab" || tool === "trim") && (
        <>
          <div onMouseDown={(e) => onRegionDrag(e, "trim-l")}
            style={{ position: "absolute", left: 0, top: 0, width: HANDLE_W, height: "100%", cursor: "ew-resize", background: "transparent" }} />
          <div onMouseDown={(e) => onRegionDrag(e, "trim-r")}
            style={{ position: "absolute", right: 0, top: 0, width: HANDLE_W, height: "100%", cursor: "ew-resize", background: "transparent" }} />
        </>
      )}
      {tool === "fade" && (
        <>
          <div onMouseDown={(e) => onFadeDrag(e, "in")} title="Drag right for fade-in"
            style={{ position: "absolute", left: 0, top: 0, width: FADE_ZONE, height: "100%", cursor: "col-resize", background: "transparent" }} />
          <div onMouseDown={(e) => onFadeDrag(e, "out")} title="Drag left for fade-out"
            style={{ position: "absolute", right: 0, top: 0, width: FADE_ZONE, height: "100%", cursor: "col-resize", background: "transparent" }} />
        </>
      )}
      {/* Smart-tool affordance: the cursor says WHAT, this says WHERE. Paints only the hovered zone. */}
      {tool === "smart" && smartZone && regionW >= OVERLAY_VISIBILITY_THRESHOLD_PX && (() => {
        // Markers are sized from the SAME clamped bands the hit-test uses. Drawing the raw
        // constants would paint a 14px white wedge onto a clip only a few pixels wide — at far
        // zoom-out that is a white block, not an affordance. Below 24px there is no room for a
        // marker at all, so none is drawn; the cursor still carries the meaning.
        const corner = Math.min(SMART_CORNER_W, Math.max(3, regionW * 0.25));
        const bar: React.CSSProperties = { position: "absolute", background: "#fff", opacity: 0.75, pointerEvents: "none" };
        if (smartZone === "trim-l") return <div style={{ ...bar, left: 0, top: 0, width: 2, height: "100%" }} />;
        if (smartZone === "trim-r") return <div style={{ ...bar, right: 0, top: 0, width: 2, height: "100%" }} />;
        if (smartZone === "xfade-l") return <div style={{ ...bar, left: 0, bottom: 0, width: corner, height: 2 }} />;
        if (smartZone === "xfade-r") return <div style={{ ...bar, right: 0, bottom: 0, width: corner, height: 2 }} />;
        if (smartZone === "fade-in" || smartZone === "fade-out") {
          const left = smartZone === "fade-in";
          const cw = corner, ch = Math.min(SMART_CORNER_H, laneH - 8);
          return (
            <svg width={cw} height={ch}
              style={{ position: "absolute", top: 0, [left ? "left" : "right"]: 0, pointerEvents: "none" }}>
              <polygon
                points={left ? `0,0 ${cw},0 0,${ch}` : `${cw},0 0,0 ${cw},${ch}`}
                fill="#fff" fillOpacity={0.7} />
            </svg>
          );
        }
        return null;
      })()}
    </div>
  );
}

function LiveRecordingOverlay({ color, laneH, startMs, peaks, samplePeriodMs, pps }: {
  color: string; laneH: number; startMs: number; peaks: number[]; samplePeriodMs: number; pps: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const widthPerSample = (samplePeriodMs / 1000) * pps;
  const w = Math.max(2, Math.ceil(peaks.length * widthPerSample));
  const x = (startMs / 1000) * pps;
  const h = laneH - 8;
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(2, Math.floor(w * dpr));
    cv.height = Math.max(2, Math.floor(h * dpr));
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    g.fillStyle = color; g.globalAlpha = 0.85;
    const mid = h / 2;
    for (let i = 0; i < peaks.length; i++) {
      const px = i * widthPerSample;
      const amp = Math.min(1, peaks[i]) * (h / 2 - 2);
      g.fillRect(px, mid - amp, Math.max(1, widthPerSample - 0.5), amp * 2);
    }
  }, [peaks, peaks.length, w, h, color, widthPerSample]);
  return (
    <div style={{
      position: "absolute", left: x, top: 4, width: w, height: h,
      background: color + "1f", border: `1px solid ${color}`,
      boxShadow: `0 0 12px ${color}88`,
      pointerEvents: "none", overflow: "hidden",
    }}>
      <canvas ref={canvasRef} style={{ width: w, height: h, display: "block" }} />
      <div style={{
        position: "absolute", left: 4, top: 2,
        fontSize: "var(--t-micro)", color: "#fff", opacity: 0.95,
        textShadow: "0 0 3px rgba(0,0,0,0.8)",
        fontWeight: 700, letterSpacing: 0.5,
      }}>● REC</div>
    </div>
  );
}

// ── Automation lane subcomponent ────────────────────────────────

function AutomationLaneView({
  track, lane, pps, totalDurMs, topY,
  selectedPointId, onSelectPoint, onAddPoint, onMovePoint, onDeletePoint,
}: {
  track: StudioTrack;
  lane: AutomationLane;
  pps: number;
  totalDurMs: number;
  topY: number;
  selectedPointId: string | null;
  onSelectPoint: (pointId: string | null) => void;
  onAddPoint: (timeMs: number, value: number) => void;
  onMovePoint: (pointId: string, timeMs: number, value: number) => void;
  onDeletePoint: (pointId: string) => void;
}) {
  const spec = AUTOMATION_SPECS[lane.param];
  const w = (totalDurMs / 1000) * pps;
  const h = AUTOMATION_LANE_H;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const yToValue = (y: number) => {
    const pct = 1 - clamp(y / h, 0, 1);
    return spec.min + pct * (spec.max - spec.min);
  };
  const valueToY = (v: number) => {
    const pct = (v - spec.min) / (spec.max - spec.min);
    return (1 - clamp(pct, 0, 1)) * h;
  };
  const xToTime = (x: number) => Math.max(0, (x / pps) * 1000);
  const timeToX = (t: number) => (t / 1000) * pps;

  const findPointAt = (x: number, y: number): AutomationPoint | null => {
    const HIT = 7;
    for (const p of lane.points) {
      const px = timeToX(p.timeMs), py = valueToY(p.value);
      if (Math.abs(px - x) < HIT && Math.abs(py - y) < HIT) return p;
    }
    return null;
  };

  // Redraw on any change
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(2, Math.floor(w * dpr));
    cv.height = Math.max(2, Math.floor(h * dpr));
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    // background grid
    g.strokeStyle = "#15151a";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, h / 2); g.lineTo(w, h / 2);
    g.stroke();
    // automation curve
    if (lane.points.length > 0) {
      const sorted = [...lane.points].sort((a, b) => a.timeMs - b.timeMs);
      g.strokeStyle = track.color;
      g.lineWidth = 1.5;
      g.beginPath();
      const firstY = valueToY(sorted[0].value);
      g.moveTo(0, firstY);
      g.lineTo(timeToX(sorted[0].timeMs), firstY);
      for (let i = 1; i < sorted.length; i++) {
        g.lineTo(timeToX(sorted[i].timeMs), valueToY(sorted[i].value));
      }
      g.lineTo(w, valueToY(sorted[sorted.length - 1].value));
      g.stroke();
      // Fill area
      g.fillStyle = track.color + "22";
      g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fill();
      // Points
      for (const p of sorted) {
        const px = timeToX(p.timeMs), py = valueToY(p.value);
        g.fillStyle = track.color;
        g.beginPath(); g.arc(px, py, 3.5, 0, Math.PI * 2); g.fill();
        if (p.id === selectedPointId) {
          g.strokeStyle = "#fff"; g.lineWidth = 1.5;
          g.beginPath(); g.arc(px, py, 5.5, 0, Math.PI * 2); g.stroke();
        }
      }
    }
  }, [lane.points, lane.param, w, h, track.color, selectedPointId, pps]);

  const onMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (e.button === 2) {
      // Right-click: delete point if hit
      const p = findPointAt(x, y);
      if (p) onDeletePoint(p.id);
      return;
    }

    const hit = findPointAt(x, y);
    if (hit) {
      onSelectPoint(hit.id);
      // Begin drag
      const startX = e.clientX, startY = e.clientY;
      const orig = { time: hit.timeMs, value: hit.value };
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        const newTime = Math.max(0, orig.time + xToTime(dx));
        const newVal  = clamp(orig.value - (dy / h) * (spec.max - spec.min), spec.min, spec.max);
        onMovePoint(hit.id, newTime, newVal);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return;
    }

    // Click empty area = add point
    onAddPoint(xToTime(x), yToValue(y));
  };

  return (
    <div
      onMouseDown={onMouseDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "absolute", top: topY,
        left: 0, width: w, height: h,
        background: "var(--bg-primary)",
        borderTop: "1px solid var(--border-primary)",
        cursor: "crosshair",
      }}
    >
      <canvas ref={canvasRef} style={{ width: w, height: h, display: "block" }} />
      <div style={{
        position: "absolute", left: 4, top: 2,
        fontSize: "var(--t-micro)", color: "var(--text-tertiary)", letterSpacing: 0.5, textTransform: "uppercase",
        pointerEvents: "none",
      }}>{spec.label}</div>
    </div>
  );
}

// ── MixerStrips (phase b, 2026-08-16) ───────────────────────────────────────────────────────
// A real channel strip per track: pan, fader, VU, dB readout, M/S. It is a VIEW — every write goes
// through the same UPDATE_TRACK dispatch the track header uses, and every level comes from the
// meter ref the RAF tick already repaints. Nothing here touches the audio graph.
function MixerStrips({ tracks, levels, masterLevel, masterGainDb, onPatch, onSelect, selectedId }: {
  tracks: StudioTrack[];
  levels: Map<string, number>;
  masterLevel: number;
  masterGainDb: number;
  onPatch: (id: string, patch: Partial<StudioTrack>) => void;
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const VU_H = 104;
  const vu = (lvl: number, color?: string) => (
    <span style={{ display: "flex", gap: 2, alignItems: "flex-end", height: VU_H }}>
      {[0, 1].map(ch => (
        <span key={ch} style={{
          width: 5, alignSelf: "flex-end",
          height: Math.max(2, Math.min(VU_H, lvl * VU_H * (ch ? 0.94 : 1))),
          background: color
            ? color
            : "linear-gradient(to top, var(--accent-green) 0 62%, var(--accent-amber) 62% 86%, var(--accent-red) 86%)",
        }} />
      ))}
    </span>
  );
  const strip: React.CSSProperties = {
    flex: "1 1 0", minWidth: 0, borderRight: "1px solid var(--border-primary)",
    padding: "var(--s-3)", display: "flex", flexDirection: "column",
    alignItems: "center", gap: "var(--s-2)",
  };
  const name: React.CSSProperties = {
    fontSize: "var(--t-micro)", textTransform: "uppercase", letterSpacing: "0.06em",
    color: "var(--text-tertiary)", whiteSpace: "nowrap", overflow: "hidden",
    textOverflow: "ellipsis", maxWidth: "100%",
  };
  const dbTxt: React.CSSProperties = {
    fontFamily: "ui-monospace, monospace", fontSize: "var(--t-micro)", color: "var(--text-tertiary)",
  };

  return (
    <div style={{ display: "flex", height: "100%", overflowX: "auto" }}>
      {tracks.map(t => {
        const lvl = levels.get(t.id) || 0;
        const sel = t.id === selectedId;
        return (
          <div key={t.id} style={{
            ...strip,
            background: sel ? "var(--bg-tertiary)" : "transparent",
            borderTop: `2px solid ${sel ? t.color : "transparent"}`,
          }} onClick={() => onSelect(t.id)}>
            <span style={{ ...name, color: sel ? "var(--text-primary)" : "var(--text-tertiary)" }}>{t.name}</span>
            {/* PAN — the control the header never had */}
            <span style={dbTxt}>{t.pan === 0 ? "C" : t.pan < 0 ? `L${Math.round(-t.pan * 100)}` : `R${Math.round(t.pan * 100)}`}</span>
            <input type="range" min={-1} max={1} step={0.02} value={t.pan}
              onChange={e => onPatch(t.id, { pan: +e.target.value })}
              title="Pan"
              style={{ width: "100%", accentColor: t.color, height: 14 }} />
            <div style={{ display: "flex", gap: "var(--s-2)", flex: 1, alignItems: "stretch", minHeight: VU_H }}>
              <input type="range" min={-48} max={6} step={0.5} value={t.gainDb}
                onChange={e => onPatch(t.id, { gainDb: +e.target.value })}
                title="Level"
                style={{
                  writingMode: "vertical-lr" as any, direction: "rtl",
                  width: 22, accentColor: t.color, cursor: "pointer",
                }} />
              {vu(lvl)}
            </div>
            <span style={dbTxt}>{t.gainDb.toFixed(1)}</span>
            <span style={{ display: "flex", gap: 2 }}>
              <MiniBtn active={t.muted} activeColor="#ef4444"
                onClick={(e) => { e.stopPropagation(); onPatch(t.id, { muted: !t.muted }); }}>M</MiniBtn>
              <MiniBtn active={t.solo} activeColor="#fbbf24"
                onClick={(e) => { e.stopPropagation(); onPatch(t.id, { solo: !t.solo }); }}>S</MiniBtn>
            </span>
          </div>
        );
      })}
      {/* MASTER — read-only here; its fader lives in Master FX, which owns the master chain. */}
      <div style={{ ...strip, background: "var(--bg-secondary)", flex: "0 0 74px" }}>
        <span style={{ ...name, color: "var(--accent-cyan)" }}>Master</span>
        <span style={dbTxt}>—</span>
        <div style={{ height: 14 }} />
        <div style={{ display: "flex", gap: "var(--s-2)", flex: 1, alignItems: "flex-end", minHeight: VU_H }}>
          {vu(masterLevel)}
        </div>
        <span style={dbTxt}>{masterGainDb.toFixed(1)}</span>
      </div>
    </div>
  );
}

// ── PaneTabs (phase a) ──────────────────────────────────────────────────────────────────────
// The pane chrome the Schedule Manager already wears: uppercase 11px tabs, 2px active underline,
// hairline separation. Static in phase (a) — dockview hosting is phase (b). This exists so the
// three columns read as PANES rather than as three regions of one screen.
function PaneTabs({ tabs, active, onPick }: { tabs: string[]; active: string; onPick?: (t: string) => void }) {
  return (
    <div style={{
      display: "flex", flex: "0 0 auto", background: "var(--bg-secondary)",
      borderBottom: "1px solid var(--border-primary)",
    }}>
      {tabs.map(t => {
        const on = t === active;
        return (
          <div key={t} onClick={() => onPick?.(t)} style={{
            padding: "var(--s-3) var(--s-5)", fontSize: "var(--t-small)", fontWeight: 700,
            letterSpacing: "0.08em", textTransform: "uppercase",
            color: on ? "var(--text-primary)" : "var(--text-tertiary)",
            background: on ? "var(--bg-primary)" : "transparent",
            borderRight: "1px solid var(--border-primary)",
            boxShadow: on ? "inset 0 -2px 0 0 var(--accent-cyan)" : "none",
            cursor: onPick ? "pointer" : "default", whiteSpace: "nowrap", userSelect: "none",
          }}>{t}</div>
        );
      })}
    </div>
  );
}

// ── TransportBar (phase a, 2026-08-16) ──────────────────────────────────────────────────────
// RANK 1 — the controls a producer touches every few seconds, on their own full-width bar at the
// bottom, sized so the eye finds play / timecode / meters without searching. Nothing else lives
// here: BPM, zoom, import, export, notes and history stayed on the utility row above.
//
// SHELL ONLY. Every handler below is the one that already existed on the top strip — play, stop,
// toggleRecord, setRecordArmed, returnToStart. No audio behaviour changed in this phase.
function TransportBar({
  playing, recording, recordArmed, playheadMs, selStartMs, selEndMs, sessionEndMs,
  masterLevel, lufsMomentary, onPlay, onStop, onRecord, onArm, onReturnStart, onEnd,
}: {
  playing: boolean; recording: boolean; recordArmed: boolean;
  playheadMs: number; selStartMs: number | null; selEndMs: number | null; sessionEndMs: number;
  masterLevel: number; lufsMomentary: number;
  onPlay: () => void; onStop: () => void; onRecord: () => void; onArm: () => void;
  onReturnStart: () => void; onEnd: () => void;
}) {
  const lbl: React.CSSProperties = {
    fontSize: "var(--t-micro)", textTransform: "uppercase", letterSpacing: "0.1em",
    color: "var(--text-tertiary)",
  };
  const btn = (size: number, extra?: React.CSSProperties): React.CSSProperties => ({
    width: size, height: size, borderRadius: "var(--r-0)", border: "1px solid var(--border-secondary)",
    background: "var(--bg-tertiary)", color: "var(--text-secondary)", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: Math.round(size * 0.42), ...extra,
  });
  // True peak from the linear master level. -Infinity reads as "—", never as a misleading 0.
  const peakDb = masterLevel > 0 ? 20 * Math.log10(masterLevel) : -Infinity;
  const fmtDb = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "—");
  const selDur = selStartMs != null && selEndMs != null ? Math.abs(selEndMs - selStartMs) : null;

  return (
    <div style={{
      flex: "0 0 92px", height: 92, background: "var(--bg-secondary)",
      borderTop: "1px solid var(--border-secondary)",
      display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center",
      padding: "0 var(--s-6)", gap: "var(--s-6)",
    }}>
      {/* LEFT — metering. Always visible; never behind a panel. */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-6)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={lbl}>Peak</span>
          <span style={{
            fontFamily: "ui-monospace, monospace", fontSize: 20, fontVariantNumeric: "tabular-nums",
            color: peakDb > -1 ? "var(--accent-red)" : peakDb > -6 ? "var(--accent-amber)" : "var(--accent-green)",
          }}>{fmtDb(peakDb)}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={lbl}>LUFS-M</span>
          <span style={{
            fontFamily: "ui-monospace, monospace", fontSize: 20, fontVariantNumeric: "tabular-nums",
            color: "var(--accent-green)",
          }}>{fmtDb(lufsMomentary)}</span>
        </div>
        <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 46 }}>
          {[0, 1].map(ch => (
            <span key={ch} style={{
              width: 9, height: Math.max(2, Math.min(46, masterLevel * 46 * (ch ? 0.94 : 1))),
              background: "linear-gradient(to top, var(--accent-green) 0 62%, var(--accent-amber) 62% 86%, var(--accent-red) 86%)",
            }} />
          ))}
        </div>
      </div>

      {/* CENTRE — transport. The largest thing on the bar. */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-6)", justifySelf: "center" }}>
        <button onClick={onReturnStart} title="Return to start (Home)" style={btn(40)}>⏮</button>
        <button onClick={onStop} title="Stop" style={btn(40)}>⏹</button>
        <button onClick={onPlay} title={playing ? "Pause (Space)" : "Play (Space)"}
          style={btn(58, {
            background: "rgb(52 211 153 / 0.14)", borderColor: "var(--accent-green)",
            color: "var(--accent-green)", fontSize: 24,
          })}>{playing ? "⏸" : "▶"}</button>
        <button onClick={onArm} title="Record arm"
          style={btn(40, recordArmed
            ? { color: "var(--accent-red)", borderColor: "var(--accent-red)", background: "rgb(248 113 113 / 0.14)" }
            : { color: "var(--accent-red)", borderColor: "#3a2030" })}>⏺</button>
        <button onClick={onRecord} title="Record" style={btn(40, recording
          ? { color: "var(--accent-red)", borderColor: "var(--accent-red)", background: "rgb(248 113 113 / 0.2)" }
          : {})}>{recording ? "◼" : "●"}</button>
        <button onClick={onEnd} title="Go to end (End)" style={btn(40)}>⏭</button>

        <div style={{ marginLeft: "var(--s-4)" }}>
          <div style={{
            fontFamily: "ui-monospace, monospace", fontSize: 46, lineHeight: 1,
            fontVariantNumeric: "tabular-nums", color: "var(--text-primary)", letterSpacing: "0.01em",
          }}>{fmtTimecode(playheadMs)}</div>
          <div style={{
            fontFamily: "ui-monospace, monospace", fontSize: "var(--t-body)",
            color: "var(--text-tertiary)", marginTop: 3,
          }}>
            sel {selStartMs != null ? fmtDuration(selStartMs) : "—"}
            {" → "}{selEndMs != null ? fmtDuration(selEndMs) : "—"}
            {selDur != null ? `  ·  ${fmtDuration(selDur)}` : ""}
          </div>
        </div>
      </div>

      {/* RIGHT — readouts only. No controls: this bar belongs to transport. */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-6)", justifySelf: "end" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={lbl}>Session</span>
          <span style={{
            fontFamily: "ui-monospace, monospace", fontSize: 15,
            fontVariantNumeric: "tabular-nums", color: "var(--text-secondary)",
          }}>{fmtDuration(sessionEndMs)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Inspector (slimmed) ─────────────────────────────────────────

function Inspector({
  track, region,
  masterGainDb, setMasterGainDb,
  limiterEnabled, setLimiterEnabled,
  limiterThresh, setLimiterThresh,
  masterLevel, masterAnalyser,
  loopRange, onClearLoop,
  onPatchTrack, onPatchRegion, onClear, onDeleteRegion, onOpenEq,
}: {
  track: StudioTrack | null;
  region: StudioRegion | null;
  masterGainDb: number; setMasterGainDb: (v: number) => void;
  limiterEnabled: boolean; setLimiterEnabled: (v: boolean) => void;
  limiterThresh: number; setLimiterThresh: (v: number) => void;
  masterLevel: number; masterAnalyser: AnalyserNode | null;
  loopRange: { startMs: number; endMs: number } | null;
  onClearLoop: () => void;
  onPatchTrack: (p: TrackPatch) => void;
  onPatchRegion: (p: RegionPatch) => void;
  onClear: () => void;
  onDeleteRegion: () => void;
  onOpenEq: () => void;
}) {
  const knob = (label: string, min: number, max: number, val: number, step: number,
    onChange: (v: number) => void, unit = "", accent = "var(--accent-blue)") => (
    <Fader label={label} min={min} max={max} step={step} value={val}
      onChange={onChange} unit={unit}
      variant={accent === "#22c55e" ? "green" : "purple"}
    />
  );

  const masterSection = (
    <div style={{ padding: 8, marginBottom: 10, background: "var(--bg-primary)", border: "1px solid var(--border-primary)" }}>
      <div style={{ fontSize: "var(--t-micro)", color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: 6, letterSpacing: 0.5 }}>Master</div>
      <MeterBar level={masterLevel} color="var(--accent-blue)" width={INSPECTOR_W - 32} height={6} />
      <SpectrumAnalyzer analyser={masterAnalyser} width={INSPECTOR_W - 32} height={50} />
      <div style={{ height: 6 }} />
      {knob("Master gain", -24, 6, masterGainDb, 0.5, setMasterGainDb, " dB")}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <button onClick={() => setLimiterEnabled(!limiterEnabled)}
          style={insBtn(limiterEnabled, "#22c55e")}
        >Limiter {limiterEnabled ? "on" : "off"}</button>
      </div>
      {limiterEnabled && knob("Threshold", -24, 0, limiterThresh, 0.5, setLimiterThresh, " dB", "#22c55e")}
      {loopRange && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border-primary)", fontSize: "var(--t-micro)", color: "var(--text-secondary)" }}>
          Loop: {fmtDuration(loopRange.startMs)} → {fmtDuration(loopRange.endMs)}
          <button onClick={onClearLoop}
            style={{ marginLeft: 8, padding: "2px 6px", background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", fontSize: "var(--t-micro)", cursor: "pointer", borderRadius: 0 }}
          >Clear</button>
        </div>
      )}
    </div>
  );

  if (!track) {
    return (
      <div>
        {masterSection}
        <div style={{ color: "var(--text-tertiary)", fontSize: "var(--t-body)", textAlign: "center", marginTop: 20 }}>
          Select a track
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontSize: "var(--t-body)" }}>
      {masterSection}

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <div style={{ width: 12, height: 12, background: track.color }} />
        <input value={track.name}
          onChange={(e) => onPatchTrack({ name: e.target.value })}
          style={{ flex: 1, background: "var(--bg-secondary)", color: "#fff", border: "1px solid var(--border-primary)", padding: "4px 6px", fontSize: "var(--t-body)", borderRadius: 0 }}
        />
      </div>

      <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", marginBottom: 8 }}>
        {track.regions.length} region{track.regions.length !== 1 ? "s" : ""}
      </div>

      <button onClick={onOpenEq}
        style={{
          width: "100%", marginBottom: 10, padding: "7px",
          background: "rgb(from var(--accent-cyan) r g b / 0.12)", color: "var(--accent-cyan)",
          border: "1px solid rgb(from var(--accent-cyan) r g b / 0.4)", fontSize: "var(--t-small)", fontWeight: 700, cursor: "pointer", borderRadius: "var(--r-0)", letterSpacing: 0.5,
        }}
      >⤒ Open 7-Band EQ</button>

      {knob("Gain", -18, 6, track.gainDb, 0.5, (v) => onPatchTrack({ gainDb: v }), " dB", track.color)}
      <div style={{ display: "flex", justifyContent: "center", margin: "4px 0 8px" }}>
        <Knob label="Pan" min={-1} max={1} step={0.05} value={track.pan}
          onChange={(v) => onPatchTrack({ pan: v })}
          format={(v) => Math.abs(v) < 0.025 ? "C" : (v < 0 ? "L" : "R") + Math.round(Math.abs(v) * 100)}
        />
      </div>

      <div style={{ display: "flex", gap: 4, marginTop: 10 }}>
        <button onClick={() => onPatchTrack({ muted: !track.muted })} style={insBtn(track.muted, "#ef4444")}>
          M {track.muted ? "on" : ""}
        </button>
        <button onClick={() => onPatchTrack({ solo: !track.solo })} style={insBtn(track.solo, "#f59e0b")}>
          S {track.solo ? "on" : ""}
        </button>
        <button onClick={() => onPatchTrack({ armed: !track.armed })} style={insBtn(track.armed, "#ef4444")}>
          ⏺ {track.armed ? "on" : ""}
        </button>
      </div>

      {region && (
        <div style={{ marginTop: 14, padding: 8, background: "var(--bg-primary)", border: "1px solid var(--border-primary)" }}>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6, letterSpacing: 0.5 }}>
            Selected region
          </div>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-secondary)", marginBottom: 3 }}>
            Offset: <span style={{ color: "var(--text-secondary)", fontFamily: "ui-monospace, monospace" }}>{fmtDuration(region.offsetMs)}</span>
          </div>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-secondary)", marginBottom: 3 }}>
            Length: <span style={{ color: "var(--text-secondary)", fontFamily: "ui-monospace, monospace" }}>{fmtDuration(regionDurMs(region))}</span>
          </div>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-secondary)", marginBottom: 3 }}>
            Fade in: <span style={{ color: "var(--text-secondary)", fontFamily: "ui-monospace, monospace" }}>{region.fadeInMs.toFixed(0)}ms</span>
            {"  "}out: <span style={{ color: "var(--text-secondary)", fontFamily: "ui-monospace, monospace" }}>{region.fadeOutMs.toFixed(0)}ms</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <Fader label="Clip gain" min={-24} max={12} step={0.5} value={region.clipGainDb || 0}
              onChange={(v) => onPatchRegion({ clipGainDb: v })} unit=" dB"
            />
          </div>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", marginTop: 6, wordBreak: "break-all" }}>
            {region.filePath || "(recorded)"}
          </div>
          <button onClick={onDeleteRegion}
            style={{ width: "100%", marginTop: 8, padding: "4px", background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", fontSize: "var(--t-micro)", cursor: "pointer", borderRadius: 0 }}
          >Delete region</button>
        </div>
      )}

      <button onClick={onClear}
        style={{ width: "100%", marginTop: 10, padding: "6px", background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", fontSize: "var(--t-small)", cursor: "pointer", borderRadius: 0 }}
      >Clear all regions</button>
    </div>
  );
}

function insBtn(active: boolean, color: string): React.CSSProperties {
  return {
    flex: 1, padding: "5px",
    background: active ? color : "var(--button-bg, var(--bg-tertiary))",
    color: active ? "#fff" : "var(--button-text, var(--text-secondary))",
    border: active ? `1px solid ${color}` : "var(--button-border, 1px solid var(--border-primary))",
    fontSize: "var(--t-micro)", cursor: "pointer", borderRadius: 0,
  };
}

// ── Fader ─────────────────────────────────────────────────────────
// Custom horizontal fader replacing raw <input type=range>. Recessed rail +
// purple (or green) gradient fill with glow + a slim capped handle. Drag the
// bar anywhere to set the value. Pass `label` to render the label/value row.
function Fader({
  min, max, step, value, onChange,
  label, unit = "", variant = "purple", style,
}: {
  min: number; max: number; step: number; value: number;
  onChange: (v: number) => void;
  label?: string; unit?: string; variant?: "purple" | "green";
  style?: React.CSSProperties;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));

  const setFromX = (clientX: number) => {
    const el = railRef.current; if (!el) return;
    const b = el.getBoundingClientRect();
    let p = (clientX - b.left) / b.width;
    p = Math.max(0, Math.min(1, p));
    let v = min + p * (max - min);
    v = Math.round(v / step) * step;
    onChange(Math.max(min, Math.min(max, v)));
  };
  const onDown = (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    setFromX(e.clientX);
    const mv = (ev: MouseEvent) => setFromX(ev.clientX);
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  };

  const green = variant === "green";
  const fillBg   = green ? "linear-gradient(90deg,#1f7a44,#27a35a)" : "linear-gradient(90deg,var(--accent-blue),var(--accent-cyan))";
  const fillGlow = green ? "0 0 8px rgba(39,163,90,.4)" : "0 0 8px rgba(136,104,216,.45)";
  const capBg    = green ? "linear-gradient(180deg,#d7ffe6,#9be0b4)" : "linear-gradient(180deg,#efeaff,#bcaef0)";
  const capBor   = green ? "#27a35a" : "#7a68c0";

  const bar = (
    <div ref={railRef} onMouseDown={onDown} onClick={(e) => e.stopPropagation()}
      style={{ position: "relative", height: 24, cursor: "pointer", flex: 1, minWidth: 56, ...style }}
    >
      <div style={{ position: "absolute", top: 9, left: 0, right: 0, height: 6, borderRadius: "var(--r-0)", background: "#07070b", boxShadow: "inset 0 1px 1px rgba(0,0,0,.6)" }} />
      <div style={{ position: "absolute", top: 9, left: 0, width: `${pct * 100}%`, height: 6, borderRadius: "var(--r-0)", background: fillBg, boxShadow: fillGlow }} />
      <div style={{ position: "absolute", top: 2, left: `${pct * 100}%`, transform: "translateX(-50%)", width: 11, height: 20, borderRadius: "var(--r-0)", background: capBg, border: `1px solid ${capBor}`, boxShadow: "var(--e-0)" }} />
    </div>
  );

  if (!label) return bar;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--t-small)", color: "var(--text-secondary)", marginBottom: 3 }}>
        <span>{label}</span>
        <span style={{ fontFamily: "ui-monospace, monospace" }}>{value.toFixed(step < 1 ? 2 : 1)}{unit}</span>
      </div>
      {bar}
    </div>
  );
}

// ── Knob ──────────────────────────────────────────────────────────
// Rotary knob (drag up/down) for bipolar params like Pan. Indicator sweeps
// −135°→+135° with a purple glow.
function Knob({
  min, max, step, value, onChange, label, format,
}: {
  min: number; max: number; step: number; value: number;
  onChange: (v: number) => void; label?: string; format?: (v: number) => string;
}) {
  const onDown = (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const startY = e.clientY, startV = value;
    const mv = (ev: MouseEvent) => {
      let v = startV + (startY - ev.clientY) * (max - min) * 0.005;
      v = Math.round(v / step) * step;
      onChange(Math.max(min, Math.min(max, v)));
    };
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  };
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const deg = -135 + pct * 270;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
      <div onMouseDown={onDown} onClick={(e) => e.stopPropagation()}
        style={{ width: 54, height: 54, position: "relative", cursor: "ns-resize" }}>
        <div style={{ position: "absolute", inset: 9, borderRadius: "50%", background: "radial-gradient(circle at 38% 32%,#26203a,#15111f 70%)", border: "1px solid #2a2440", boxShadow: "0 2px 5px rgba(0,0,0,.55), inset 0 1px 1px rgba(255,255,255,.05)" }} />
        <div style={{ position: "absolute", inset: 0, transform: `rotate(${deg}deg)` }}>
          <div style={{ position: "absolute", left: "50%", top: 6, marginLeft: -1, width: 2, height: 13, borderRadius: "var(--r-0)", background: "var(--accent-cyan)", boxShadow: "var(--e-0)" }} />
        </div>
        <div style={{ position: "absolute", inset: 0, top: "50%", transform: "translateY(-50%)", textAlign: "center", fontSize: "var(--t-small)", fontWeight: 700, color: "var(--text-primary)", pointerEvents: "none" }}>
          {format ? format(value) : value.toFixed(2)}
        </div>
      </div>
      {label && <span style={{ fontSize: "var(--t-micro)", color: "var(--text-secondary)", fontWeight: 600 }}>{label}</span>}
    </div>
  );
}

// ── FX Window ───────────────────────────────────────────────────

function FxWindow({
  track, allTracks, type, position, ctx, reductionDb,
  onClose, onMove, onBringToFront, onPatch, getAnalyser,
}: {
  track: StudioTrack;
  allTracks: StudioTrack[];
  type: FxWindowType;
  position: { x: number; y: number; z: number };
  ctx: AudioContext;
  reductionDb: number;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
  onBringToFront: () => void;
  onPatch: (p: TrackPatch) => void;
  getAnalyser?: () => AnalyserNode | null;
}) {
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    onBringToFront();
    const startX = e.clientX, startY = e.clientY;
    const startPos = { x: position.x, y: position.y };
    const onMouseMove = (ev: MouseEvent) => {
      onMove(startPos.x + (ev.clientX - startX), Math.max(0, startPos.y + (ev.clientY - startY)));
    };
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  return (
    <div onMouseDown={onBringToFront}
      style={{
        position: "absolute",
        left: position.x, top: position.y, width: type === "eq" ? 880 : 320,
        zIndex: 1000 + position.z,
        background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
        boxShadow: "var(--e-float)",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <div onMouseDown={startDrag}
        style={{
          height: 42, background: "linear-gradient(180deg,#262632 0%,#1a1a22 100%)",
          borderBottom: "1px solid #0a0a0f",
          display: "flex", alignItems: "center", padding: "0 14px", gap: 10,
          cursor: "grab", userSelect: "none",
        }}
      >
        <div style={{ width: 9, height: 9, borderRadius: "50%", background: track.color, boxShadow: `0 0 8px ${track.color}` }} />
        <span style={{ fontSize: "var(--t-body)", fontWeight: 800, letterSpacing: "0.16em", color: "#ececf2", textTransform: "uppercase" as const }}>ETHER</span>
        <span style={{
          fontSize: "var(--t-micro)", fontWeight: 600, letterSpacing: "0.1em", color: "var(--accent-cyan)",
          textTransform: "uppercase" as const, padding: "2px 8px",
          border: "1px solid rgb(from var(--accent-cyan) r g b / 0.3)", borderRadius: "var(--r-0)",
          whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis", maxWidth: type === "eq" ? 600 : 220,
        }}>{track.name} · {FX_WINDOW_LABELS[type]}</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} title="Close" data-no-drag
          style={{ width: 28, height: 28, borderRadius: "var(--r-0)", background: "#1a1a22", border: "1px solid #3a3a48", color: "#a8a8b4", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}
          onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = "#ef4444"; el.style.borderColor = "#ef4444"; el.style.color = "#fff"; }}
          onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "#1a1a22"; el.style.borderColor = "#3a3a48"; el.style.color = "#a8a8b4"; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
        </button>
      </div>

      <div style={{ padding: 10, maxHeight: "70vh", overflowY: "auto" }}>
        {type === "eq"     && <FxEqSection     track={track} ctx={ctx} onPatch={onPatch} getAnalyser={getAnalyser} />}
        {type === "comp"   && <FxCompSection   track={track} reductionDb={reductionDb} onPatch={onPatch} />}
        {type === "reverb" && (
          <>
            <FxReverbSection    track={track} ctx={ctx} onPatch={onPatch} />
            <FxSatSection       track={track} onPatch={onPatch} />
            <FxSidechainSection track={track} allTracks={allTracks} onPatch={onPatch} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Export Watermark Confirmation Dialog ──────────────────────

function ExportWatermarkDialog({ onConfirm }: { onConfirm: (embed: boolean) => void }) {
  const [checked, setChecked] = useState(true);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 420, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: "var(--t-lead)", fontWeight: 800, color: "#e8e8f0" }}>Export Mix</div>
        <div style={{ fontSize: "var(--t-body)", color: "#8080b0", lineHeight: 1.5 }}>
          One or more tracks are marked as <span style={{ color: "#00c8a8" }}>original content</span>. You can embed an invisible content provenance watermark into this export.
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "10px 12px", background: "var(--bg-primary)", border: "1px solid var(--border-primary)" }}>
          <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} style={{ width: 14, height: 14, accentColor: "#00c8a8" }} />
          <div>
            <div style={{ fontSize: "var(--t-body)", color: "#e8e8f0", fontWeight: 600 }}>🛡 Embed content provenance watermark</div>
            <div style={{ fontSize: "var(--t-micro)", color: "#6060a0", marginTop: 2 }}>Invisibly encodes station ID, timestamp, and content hash into the audio.</div>
          </div>
        </label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => onConfirm(false)} style={{ padding: "6px 16px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "#8080b0", fontSize: "var(--t-body)", cursor: "pointer" }}>Export without watermark</button>
          <button onClick={() => onConfirm(checked)} style={{ padding: "6px 16px", background: "#00c8a8", border: "none", color: "#000", fontSize: "var(--t-body)", fontWeight: 700, cursor: "pointer" }}>Export</button>
        </div>
      </div>
    </div>
  );
}

// ── Watermark Verify Dialog ────────────────────────────────────

function WatermarkVerifyDialog({ filePath, result, verifying, onClose }: {
  filePath: string;
  result: any;
  verifying: boolean;
  onClose: () => void;
}) {
  const fname = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  const valid   = result?.valid === true;
  const found   = result?.found === true;
  const hash    = result?.contentHash ?? "";
  const hashPreview = hash ? hash.slice(0, 16) + "…" : "—";

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ width: 440, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: "var(--t-lead)", fontWeight: 800, color: "#e8e8f0", letterSpacing: "-0.01em" }}>🛡 Watermark Verification</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#606080", fontSize: "var(--t-head)", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ fontSize: "var(--t-small)", color: "#6060a0", padding: "5px 8px", background: "var(--bg-primary)", border: "1px solid #1e1e28", wordBreak: "break-all" as const }}>
          {fname}
        </div>

        {verifying && (
          <div style={{ fontSize: "var(--t-body)", color: "#6060a0", textAlign: "center" as const, padding: "10px 0" }}>Verifying…</div>
        )}

        {!verifying && result && (
          <>
            {!found ? (
              <div style={{ fontSize: "var(--t-body)", color: "#ef4444", padding: "8px 10px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)" }}>
                {result.error ?? "No Ether watermark found in this file."}
              </div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "130px 1fr", rowGap: 8, fontSize: "var(--t-body)" }}>
                  {[
                    ["Station ID",      result.stationId    ?? "—"],
                    ["Timestamp",       result.timestamp    ?? "—"],
                    ["Ether Version",   result.etherVersion ?? "—"],
                    ["SHA-256 Hash",    hashPreview],
                  ].map(([label, value]) => (
                    <React.Fragment key={label}>
                      <span style={{ color: "#6060a0", paddingRight: 8 }}>{label}</span>
                      <span style={{ color: "#c0c0d8", fontFamily: "ui-monospace, monospace", fontSize: "var(--t-small)" }}>{value}</span>
                    </React.Fragment>
                  ))}
                </div>

                <div style={{
                  marginTop: 4, padding: "9px 12px",
                  background: valid ? "rgba(0,200,168,0.08)" : "rgba(239,68,68,0.08)",
                  border: `1px solid ${valid ? "rgba(0,200,168,0.3)" : "rgba(239,68,68,0.3)"}`,
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  <span style={{ fontSize: "var(--t-lead)" }}>{valid ? "✓" : "✗"}</span>
                  <span style={{ fontSize: "var(--t-body)", fontWeight: 700, color: valid ? "#00c8a8" : "#ef4444" }}>
                    {valid ? "Content is authentic and unmodified" : "Content has been modified"}
                  </span>
                </div>
              </>
            )}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
          <button onClick={onClose} style={{ padding: "6px 18px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "#c0c0d8", fontSize: "var(--t-body)", cursor: "pointer" }}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Export menu (Mix / Stems) ──────────────────────────────────

function ExportMenu({ onExportMix, onExportStems }: { onExportMix: () => void; onExportStems: () => void }) {
  return (
    <ToolbarMenu label="Export ▾" title="Export options" minWidth={160}>
      {(close) => (
        <>
          <MenuItem onClick={() => { close(); onExportMix(); }}>Export Mix (one WAV)</MenuItem>
          <MenuItem onClick={() => { close(); onExportStems(); }}>Export Stems (one WAV per track)</MenuItem>
        </>
      )}
    </ToolbarMenu>
  );
}

// ── Per-FX presets (localStorage) ──────────────────────────────

interface PresetStore<T> {
  list: () => { name: string; value: T; builtin?: boolean }[];
  save: (name: string, value: T) => void;
  delete: (name: string) => void;
}

function usePresets<T>(key: string, builtins: { name: string; value: T }[]): PresetStore<T> {
  const lsKey = `studiopro_presets_${key}`;
  const [tick, setTick] = useState(0);
  const list = () => {
    let user: { name: string; value: T }[] = [];
    try { user = JSON.parse(localStorage.getItem(lsKey) || "[]"); } catch {}
    void tick;
    return [
      ...builtins.map(b => ({ ...b, builtin: true })),
      ...user.map(u => ({ ...u, builtin: false })),
    ];
  };
  const save = (name: string, value: T) => {
    let user: { name: string; value: T }[] = [];
    try { user = JSON.parse(localStorage.getItem(lsKey) || "[]"); } catch {}
    const idx = user.findIndex(u => u.name === name);
    if (idx >= 0) user[idx] = { name, value };
    else user.push({ name, value });
    localStorage.setItem(lsKey, JSON.stringify(user));
    setTick(n => n + 1);
  };
  const del = (name: string) => {
    let user: { name: string; value: T }[] = [];
    try { user = JSON.parse(localStorage.getItem(lsKey) || "[]"); } catch {}
    user = user.filter(u => u.name !== name);
    localStorage.setItem(lsKey, JSON.stringify(user));
    setTick(n => n + 1);
  };
  return { list, save, delete: del };
}

// 10-band presets — freqs [31,63,125,250,500,1k,2k,4k,8k,16k]
const EQ_PRESETS: { name: string; value: number[] }[] = [
  { name: "Flat",            value: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Vocal — clarity", value: [-4, -3, -2, -1, 0, 1, 2, 3, 2, 1] },
  { name: "Vocal — warm",    value: [0, 1, 2, 1, 0, 0, -1, -1, 0, 1] },
  { name: "Music — radio",   value: [2, 2, 1, 0, -1, 0, 1, 2, 2, 3] },
  { name: "Loudness smile",  value: [4, 4, 2, 0, -1, -2, -1, 0, 3, 4] },
  { name: "Telephone",       value: [-12, -12, -6, 2, 4, 4, 2, -6, -12, -12] },
];

const COMP_PRESETS: { name: string; value: TrackCompressor }[] = [
  { name: "Off",            value: { on: false, threshold: -18, ratio: 3,   attack: 20, release: 200, makeup: 0 } },
  { name: "Vocal — gentle", value: { on: true,  threshold: -18, ratio: 3,   attack: 15, release: 200, makeup: 3 } },
  { name: "Vocal — assertive", value: { on: true, threshold: -16, ratio: 5,  attack: 5,  release: 150, makeup: 5 } },
  { name: "Drums — punch",  value: { on: true,  threshold: -12, ratio: 6,   attack: 2,  release: 80,  makeup: 4 } },
  { name: "Limiter-ish",    value: { on: true,  threshold: -6,  ratio: 12,  attack: 0.5, release: 100, makeup: 2 } },
];

const REVERB_PRESETS: { name: string; value: TrackReverb }[] = [
  { name: "Off",          value: { on: false, type: "plate", wet: 0,    size: 0.5 } },
  { name: "Vocal plate",  value: { on: true,  type: "plate", wet: 0.22, size: 0.55 } },
  { name: "Small room",   value: { on: true,  type: "room",  wet: 0.18, size: 0.35 } },
  { name: "Big hall",     value: { on: true,  type: "hall",  wet: 0.30, size: 0.85 } },
  { name: "Surf spring",  value: { on: true,  type: "spring", wet: 0.4, size: 0.5 } },
];

function PresetMenu<T>({ store, current, onApply, label }: {
  store: PresetStore<T>;
  current: T;
  onApply: (v: T) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const items = store.list();
  return (
    <div style={{ position: "relative", marginBottom: 6 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", padding: "4px 8px", textAlign: "left" as const,
          background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)",
          fontSize: "var(--t-micro)", cursor: "pointer", borderRadius: 0,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}
      >
        <span>{label || "Presets"}</span>
        <span style={{ color: "var(--text-tertiary)" }}>▾</span>
      </button>
      {open && (
        <div onMouseLeave={() => setOpen(false)}
          style={{
            position: "absolute", top: "100%", left: 0, right: 0,
            background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
            zIndex: 50, maxHeight: 240, overflowY: "auto",
            boxShadow: "var(--e-0)",
          }}
        >
          {items.map(it => (
            <div key={(it.builtin ? "b:" : "u:") + it.name}
              style={{ display: "flex", alignItems: "center" }}
            >
              <button onClick={() => { setOpen(false); onApply(it.value); }}
                style={{
                  flex: 1, padding: "5px 8px", textAlign: "left" as const,
                  background: "transparent", color: it.builtin ? "#bbb" : "#fde047",
                  border: "none", fontSize: "var(--t-small)", cursor: "pointer",
                }}
              >{it.builtin ? it.name : "★ " + it.name}</button>
              {!it.builtin && (
                <button onClick={(e) => { e.stopPropagation(); store.delete(it.name); }}
                  title="Delete preset"
                  style={{ background: "transparent", border: "none", color: "var(--text-tertiary)", fontSize: "var(--t-body)", cursor: "pointer", padding: "0 6px" }}
                >×</button>
              )}
            </div>
          ))}
          <div style={{ borderTop: "1px solid var(--border-primary)", padding: 4 }}>
            <button onClick={() => {
              const name = prompt("Save current settings as preset:");
              if (name && name.trim()) { store.save(name.trim(), current); setOpen(false); }
            }}
              style={{ width: "100%", padding: "4px", background: "#1e293b", color: "var(--accent-blue)", border: "1px solid #334155", fontSize: "var(--t-micro)", cursor: "pointer", borderRadius: 0 }}
            >+ Save current as preset</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Master FX window ───────────────────────────────────────────

function MasterFxWindow({
  ctx, position,
  masterGainDb, setMasterGainDb,
  limiterEnabled, setLimiterEnabled,
  limiterThresh, setLimiterThresh,
  masterEq7, setMasterEq7,
  masterComp, setMasterComp,
  masterAnalyser, masterLAnalyser, masterRAnalyser,
  masterLevel, lufsMomentary, correlation,
  onClose, onMove,
}: {
  ctx: AudioContext;
  position: { x: number; y: number };
  masterGainDb: number; setMasterGainDb: (v: number) => void;
  limiterEnabled: boolean; setLimiterEnabled: (v: boolean) => void;
  limiterThresh: number; setLimiterThresh: (v: number) => void;
  masterEq7: number[]; setMasterEq7: (v: number[]) => void;
  masterComp: TrackCompressor; setMasterComp: (v: TrackCompressor) => void;
  masterAnalyser: AnalyserNode | null;
  masterLAnalyser: AnalyserNode | null;
  masterRAnalyser: AnalyserNode | null;
  masterLevel: number; lufsMomentary: number; correlation: number;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
}) {
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startPos = { x: position.x, y: position.y };
    const onMouseMove = (ev: MouseEvent) => onMove(startPos.x + (ev.clientX - startX), Math.max(0, startPos.y + (ev.clientY - startY)));
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  // Inline EQ canvas using getFrequencyResponse on temp BiquadFilters
  const eqCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const W = 300, H = 90;
  useEffect(() => {
    const cv = eqCanvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#050508"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "#1a1a22";
    g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    const POINTS = 200;
    const freqArr = new Float32Array(POINTS);
    for (let i = 0; i < POINTS; i++) freqArr[i] = 20 * Math.pow(1000, i / (POINTS - 1));
    const totalDb = new Float32Array(POINTS);
    const mag = new Float32Array(POINTS);
    const phase = new Float32Array(POINTS);
    for (let b = 0; b < 7; b++) {
      const f = ctx.createBiquadFilter();
      f.type = b === 0 ? "lowshelf" : b === 6 ? "highshelf" : "peaking";
      f.frequency.value = EQ_FREQS[b];
      if (f.type === "peaking") f.Q.value = 1;
      f.gain.value = clamp(masterEq7[b] || 0, -EQ_DB_RANGE, EQ_DB_RANGE);
      f.getFrequencyResponse(freqArr, mag, phase);
      for (let i = 0; i < POINTS; i++) totalDb[i] += 20 * Math.log10(Math.max(1e-6, mag[i]));
    }
    g.strokeStyle = "var(--accent-blue)"; g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < POINTS; i++) {
      const x = i / (POINTS - 1) * W;
      const y = H / 2 - (totalDb[i] / EQ_DB_RANGE) * (H / 2 - 4);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = "var(--accent-blue)22";
    g.lineTo(W, H / 2); g.lineTo(0, H / 2); g.closePath(); g.fill();
  }, [masterEq7, ctx, W, H]);

  const compStore = usePresets<TrackCompressor>("master_comp", COMP_PRESETS);

  return (
    <div style={{
      position: "absolute",
      left: position.x, top: position.y, width: 340,
      zIndex: 1500,
      background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
      boxShadow: "var(--e-float)",
      fontFamily: "Inter, system-ui, sans-serif",
    }}>
      <div onMouseDown={startDrag}
        style={{
          height: 28, background: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border-primary)",
          display: "flex", alignItems: "center", padding: "0 8px", gap: 8,
          cursor: "grab", userSelect: "none",
        }}
      >
        <div style={{ width: 8, height: 8, background: "var(--accent-blue)" }} />
        <div style={{ flex: 1, fontSize: "var(--t-small)", color: "var(--text-primary)", fontWeight: 600 }}>Master Bus FX</div>
        <button onClick={onClose}
          style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: "var(--t-lead)", cursor: "pointer", padding: "0 4px" }}
        >×</button>
      </div>

      <div style={{ padding: 10, maxHeight: "75vh", overflowY: "auto" }}>
        {/* Master meter + spectrum + broadcast meters */}
        <FxBlock title="Output">
          <MeterBar level={masterLevel} color="var(--accent-blue)" width={W} height={6} />
          <SpectrumAnalyzer analyser={masterAnalyser} width={W} height={50} />
          {compKnob("Master gain", -24, 6, masterGainDb, 0.5, setMasterGainDb, " dB")}
        </FxBlock>
        <FxBlock title="Broadcast Meters">
          <LUFSMeter lufsMomentary={lufsMomentary} width={W} />
          <div style={{ height: 8 }} />
          <CorrelationMeter correlation={correlation} width={W} />
          <div style={{ height: 8 }} />
          <Goniometer lAnalyser={masterLAnalyser} rAnalyser={masterRAnalyser} size={Math.min(W, 200)} />
        </FxBlock>

        {/* Master EQ */}
        <FxBlock title="Master 10-Band EQ">
          <EQRack bands={masterEq7} onChange={setMasterEq7} ctx={ctx}
            getAnalyser={() => masterAnalyser} presetKey="master_eq" accent="var(--accent-blue)" />
        </FxBlock>

        {/* Master compressor */}
        <FxBlock title="Master Compressor" right={
          <button onClick={() => setMasterComp({ ...masterComp, on: !masterComp.on })}
            style={miniToggle(masterComp.on, "#22c55e")}>{masterComp.on ? "ON" : "OFF"}</button>
        }>
          <PresetMenu store={compStore} current={masterComp} onApply={setMasterComp} label="Comp Presets" />
          <CompressorCurve
            threshold={masterComp.threshold} ratio={masterComp.ratio}
            makeup={masterComp.makeup} kneeDb={6} accent="#22c55e"
            liveReductionDb={0}
          />
          {compKnob("Threshold", -60, 0,    masterComp.threshold, 0.5, (v) => setMasterComp({ ...masterComp, threshold: v }), " dB")}
          {compKnob("Ratio",      1, 20,    masterComp.ratio,     0.1, (v) => setMasterComp({ ...masterComp, ratio: v }),     ":1")}
          {compKnob("Attack",     0.1, 200, masterComp.attack,    0.5, (v) => setMasterComp({ ...masterComp, attack: v }),    " ms")}
          {compKnob("Release",    10, 2000, masterComp.release,   5,   (v) => setMasterComp({ ...masterComp, release: v }),   " ms")}
          {compKnob("Makeup",     0,  24,   masterComp.makeup,    0.5, (v) => setMasterComp({ ...masterComp, makeup: v }),    " dB")}
        </FxBlock>

        {/* Limiter */}
        <FxBlock title="Master Limiter" right={
          <button onClick={() => setLimiterEnabled(!limiterEnabled)}
            style={miniToggle(limiterEnabled, "#ef4444")}>{limiterEnabled ? "ON" : "OFF"}</button>
        }>
          {compKnob("Threshold", -24, 0, limiterThresh, 0.5, setLimiterThresh, " dB")}
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", marginTop: 4 }}>
            Brick-wall ceiling: ratio 20:1 · attack 3ms · release 250ms · knee 0
          </div>
        </FxBlock>
      </div>
    </div>
  );
}

// EQ section with vertical band sliders + response curve
// ── EQRack — 10-band MODEL-10-R rack (faders + live spectrum) ─────
// Immersive graphic-EQ rack: 10 vertical faders riding a live FFT spectrum,
// peak-hold, dB scale, presets. Shared by the per-track EQ and the master EQ.
function EQRack({ bands, onChange, ctx, getAnalyser, presetKey, accent = "var(--accent-cyan)", trackH = 160 }: {
  bands: number[];
  onChange: (b: number[]) => void;
  ctx: AudioContext;
  getAnalyser?: () => AnalyserNode | null;
  presetKey: string;
  accent?: string;
  trackH?: number;
}) {
  const MAX = EQ_DB_RANGE;
  const [spectrum, setSpectrum] = useState<number[]>(() => Array(EQ_BANDS).fill(0));
  const [peaks, setPeaks]       = useState<number[]>(() => Array(EQ_BANDS).fill(0));
  const peakRef   = useRef<number[]>(Array(EQ_BANDS).fill(0));
  const bandsRef  = useRef(bands); bandsRef.current = bands;
  const getAnRef  = useRef(getAnalyser); getAnRef.current = getAnalyser;
  const eqStore   = usePresets<number[]>(presetKey, EQ_PRESETS);

  // Poll the (per-track or master) analyser ~30fps for the live spectrum.
  useEffect(() => {
    const id = setInterval(() => {
      const an = getAnRef.current?.();
      if (!an) { setSpectrum(Array(EQ_BANDS).fill(0)); return; }
      const bins = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(bins);
      const nyq = an.context.sampleRate / 2;
      const levels = EQ_FREQS.map(f => {
        const bin = Math.min(bins.length - 1, Math.max(0, Math.round((f / nyq) * bins.length)));
        return bins[bin] / 255;
      });
      setSpectrum(levels);
      const np = peakRef.current.map((p, i) => Math.max(levels[i], p * 0.985));
      peakRef.current = np;
      setPeaks(np);
    }, 33);
    return () => clearInterval(id);
  }, []);

  const dragBand = (idx: number, trackH: number) => (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const startGain = bandsRef.current[idx] ?? 0;
    const onMove = (me: MouseEvent) => {
      const dy = startY - me.clientY;
      const gain = Math.max(-MAX, Math.min(MAX, startGain + (dy / trackH) * MAX * 2));
      const next = [...bandsRef.current];
      next[idx] = Math.round(gain * 10) / 10;
      onChange(next);
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
  };

  const isActive = bands.some(g => Math.abs(g) > 0.05);
  const TRACK_H  = trackH;

  return (
    <div style={{ width: "100%" }}>
      {/* Presets row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PresetMenu store={eqStore} current={bands} onApply={onChange} label="EQ Presets" />
        </div>
        <button onClick={() => onChange(Array(EQ_BANDS).fill(0))}
          style={{ padding: "5px 12px", background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", fontSize: "var(--t-micro)", fontWeight: 700, cursor: "pointer", borderRadius: "var(--r-0)" }}
        >FLAT</button>
      </div>

      {/* Rack body */}
      <div style={{ display: "flex", gap: 6 }}>
        {/* dB scale */}
        <div style={{ width: 26, height: TRACK_H, display: "flex", flexDirection: "column", justifyContent: "space-between", fontFamily: "ui-monospace, monospace", fontSize: "var(--t-micro)", color: "#5a5a72", textAlign: "right" as const, paddingTop: 2, paddingBottom: 16 }}>
          <span>+{MAX}</span><span>0</span><span>−{MAX}</span>
        </div>
        {/* 10 bands over a dark inset */}
        <div style={{
          flex: 1, display: "grid", gridTemplateColumns: `repeat(${EQ_BANDS}, 1fr)`, gap: 3,
          background: "linear-gradient(180deg,#06060a,#0a0a0f)", border: "1px solid #1d1d28",
          borderRadius: "var(--r-0)", padding: "10px 8px 6px", boxShadow: "inset 0 2px 8px rgba(0,0,0,0.5)",
        }}>
          {EQ_FREQS.map((_, idx) => {
            const gain = bands[idx] ?? 0;
            const gainPct = gain / MAX;
            const specPct = Math.min(1, spectrum[idx] ?? 0);
            const peakPct = Math.min(1, peaks[idx] ?? 0);
            const barColor = specPct > 0.9 ? "#ef4444" : specPct > 0.75 ? "#f59e0b" : specPct > 0.5 ? "#22c55e" : accent;
            return (
              <div key={idx} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ position: "relative", width: "100%", height: TRACK_H }}>
                  {/* center line */}
                  <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "rgb(from var(--accent-cyan) r g b / 0.25)", pointerEvents: "none" }} />
                  {/* live spectrum */}
                  <div style={{ position: "absolute", bottom: 0, left: "24%", right: "24%", height: `${specPct * 100}%`, background: `linear-gradient(180deg, ${barColor} 0%, ${barColor}40 100%)`, boxShadow: `0 0 8px ${barColor}80`, borderRadius: "var(--r-0)", transition: "height 0.05s linear, background 0.2s", pointerEvents: "none" }} />
                  {peakPct > 0.02 && (
                    <div style={{ position: "absolute", bottom: `${peakPct * 100}%`, left: "24%", right: "24%", height: 2, background: "#fff", opacity: 0.8, pointerEvents: "none" }} />
                  )}
                  {/* fader */}
                  <div onMouseDown={dragBand(idx, TRACK_H)}
                    onDoubleClick={() => { const next = [...bands]; next[idx] = 0; onChange(next); }}
                    style={{ position: "absolute", inset: 0, cursor: "ns-resize" }}>
                    <div style={{
                      position: "absolute", top: `${50 - gainPct * 50}%`, left: "50%",
                      transform: "translate(-50%,-50%)", width: 26, height: 12,
                      background: "linear-gradient(180deg,#5a5a72,#2a2a36)", border: "1px solid #1a1a22", borderRadius: "var(--r-0)",
                      boxShadow: Math.abs(gain) > 0.05 ? "0 0 10px rgb(from var(--accent-cyan) r g b / 0.6)" : "0 1px 0 rgba(255,255,255,0.08) inset",
                    }}>
                      <div style={{ position: "absolute", top: "50%", left: 2, right: 2, height: 1, transform: "translateY(-50%)", background: Math.abs(gain) > 0.05 ? accent : "#5a5a72", boxShadow: Math.abs(gain) > 0.05 ? `0 0 4px ${accent}` : "none" }} />
                    </div>
                  </div>
                </div>
                <div style={{ marginTop: 5, fontSize: "var(--t-micro)", fontFamily: "ui-monospace, monospace", color: Math.abs(gain) > 0.05 ? accent : "#5a5a72", fontWeight: 700, minHeight: 12 }}>
                  {gain > 0.05 ? "+" : ""}{Math.abs(gain) > 0.05 ? gain.toFixed(1) : ""}
                </div>
                <div style={{ fontSize: "var(--t-micro)", fontWeight: 700, color: "#a8a8b4", fontFamily: "ui-monospace, monospace" }}>{EQ_LABELS[idx]}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer strip */}
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 14, fontSize: "var(--t-micro)", fontFamily: "ui-monospace, monospace", color: "#5a5a72", letterSpacing: "0.06em" }}>
        <span>FFT · HANN</span><span>·</span><span>BIQUAD · Q=1.0</span>
        <span style={{ marginLeft: "auto", color: isActive ? "#ef4444" : "#5a5a72" }}>{isActive ? "● EQ ENGAGED" : "○ BYPASS"}</span>
      </div>
    </div>
  );
}

// ── Per-track EQ — renders the shared 10-band EQRack ──────────────
function EqGraph({ track, ctx, onPatch, getAnalyser, trackH }: { track: StudioTrack; ctx: AudioContext; onPatch: (p: TrackPatch) => void; getAnalyser?: () => AnalyserNode | null; trackH?: number }) {
  return (
    <EQRack
      bands={track.eq7}
      onChange={(b) => onPatch({ eq7: b })}
      ctx={ctx}
      getAnalyser={getAnalyser}
      presetKey="track_eq"
      accent={track.color}
      trackH={trackH}
    />
  );
}

// EqGraphLegacy — REMOVED (Phase 1, 2026-08-16). 121 lines, replaced by EQRack, rendered nowhere:
// a grep for "<EqGraphLegacy" across the file returned 0 while every other component returned >=1.
// Dead code in a 7,000-line file is not free — it is read, searched and reasoned about by everyone
// who comes after.
function FxEqSection({ track, ctx, onPatch, getAnalyser }: { track: StudioTrack; ctx: AudioContext; onPatch: (p: TrackPatch) => void; getAnalyser?: () => AnalyserNode | null }) {
  return (
    <FxBlock title="10-Band EQ">
      <EqGraph track={track} ctx={ctx} onPatch={onPatch} getAnalyser={getAnalyser} trackH={260} />
    </FxBlock>
  );
}

function FxCompSection({ track, reductionDb, onPatch }: { track: StudioTrack; reductionDb: number; onPatch: (p: TrackPatch) => void }) {
  const c = track.compressor;
  const reductionPct = Math.min(1, Math.max(0, -reductionDb / 18));
  const compStore = usePresets<TrackCompressor>("track_comp", COMP_PRESETS);
  return (
    <FxBlock title="Compressor" right={
      <button onClick={() => onPatch({ compressor: { ...c, on: !c.on } })}
        style={miniToggle(c.on, "#22c55e")}>{c.on ? "ON" : "OFF"}</button>
    }>
      <PresetMenu store={compStore} current={c} onApply={(v) => onPatch({ compressor: v })} label="Comp Presets" />
      <CompressorCurve
        threshold={c.threshold}
        ratio={c.ratio}
        makeup={c.makeup}
        kneeDb={6}
        accent="#22c55e"
        liveReductionDb={reductionDb}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0" }}>
        <span style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", letterSpacing: 0.5, textTransform: "uppercase" }}>GR</span>
        <div style={{ flex: 1, height: 6, background: "#1a1a1e", position: "relative", overflow: "hidden" }}>
          <div style={{
            position: "absolute", right: 0, top: 0, bottom: 0,
            width: `${reductionPct * 100}%`, background: "#22c55e",
            transition: "width 50ms linear",
          }} />
        </div>
        <span style={{ fontSize: "var(--t-micro)", color: "var(--text-secondary)", fontFamily: "ui-monospace, monospace", minWidth: 36, textAlign: "right" }}>
          {reductionDb.toFixed(1)} dB
        </span>
      </div>
      {compKnob("Threshold", -60, 0,    c.threshold, 0.5, (v) => onPatch({ compressor: { ...c, threshold: v } }), " dB")}
      {compKnob("Ratio",      1,  20,    c.ratio,     0.1, (v) => onPatch({ compressor: { ...c, ratio: v } }),     ":1")}
      {compKnob("Attack",     0.1, 200, c.attack,    0.5, (v) => onPatch({ compressor: { ...c, attack: v } }),    " ms")}
      {compKnob("Release",    10, 2000, c.release,   5,   (v) => onPatch({ compressor: { ...c, release: v } }),   " ms")}
      {compKnob("Makeup",     0,  24,    c.makeup,    0.5, (v) => onPatch({ compressor: { ...c, makeup: v } }),    " dB")}
    </FxBlock>
  );
}

function CompressorCurve({
  threshold, ratio, makeup, kneeDb, accent, liveReductionDb,
}: {
  threshold: number;       // dB (≤ 0)
  ratio: number;           // n:1
  makeup: number;          // dB
  kneeDb: number;          // dB
  accent: string;
  liveReductionDb: number; // ≤ 0, current GR
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const w = 300, h = 120;

  // Standard soft-knee compression transfer function (input dB → output dB)
  const transfer = (inputDb: number): number => {
    const k = kneeDb;
    let out: number;
    if (inputDb <= threshold - k / 2) {
      out = inputDb;
    } else if (inputDb >= threshold + k / 2) {
      out = threshold + (inputDb - threshold) / ratio;
    } else {
      // Quadratic knee: smooth blend between 1:1 and ratio slope
      const x = inputDb - (threshold - k / 2);
      const slopeAdjust = (1 / ratio - 1) * (x * x) / (2 * k);
      out = inputDb + slopeAdjust;
    }
    return out + makeup;
  };

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr);
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#050508"; g.fillRect(0, 0, w, h);

    // Coordinate space: -60..+6 dB on both axes (input X, output Y, Y inverted)
    const minDb = -60, maxDb = 6;
    const span  = maxDb - minDb;
    const xFor  = (db: number) => ((db - minDb) / span) * w;
    const yFor  = (db: number) => h - ((db - minDb) / span) * h;

    // Grid every 12 dB
    g.strokeStyle = "#15151a"; g.lineWidth = 1;
    for (let db = minDb; db <= maxDb; db += 12) {
      const x = xFor(db), y = yFor(db);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    }
    // 0 dB lines slightly brighter
    g.strokeStyle = "#22222a";
    g.beginPath(); g.moveTo(xFor(0), 0); g.lineTo(xFor(0), h); g.stroke();
    g.beginPath(); g.moveTo(0, yFor(0)); g.lineTo(w, yFor(0)); g.stroke();

    // 1:1 reference (dotted)
    g.strokeStyle = "#33333a"; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(xFor(minDb), yFor(minDb)); g.lineTo(xFor(maxDb), yFor(maxDb)); g.stroke();
    g.setLineDash([]);

    // Threshold vertical
    g.strokeStyle = accent + "55";
    g.beginPath(); g.moveTo(xFor(threshold), 0); g.lineTo(xFor(threshold), h); g.stroke();

    // Transfer curve
    g.strokeStyle = accent; g.lineWidth = 2;
    g.beginPath();
    const POINTS = 200;
    for (let i = 0; i < POINTS; i++) {
      const inputDb = minDb + (i / (POINTS - 1)) * span;
      const outDb = clamp(transfer(inputDb), minDb, maxDb);
      const x = xFor(inputDb), y = yFor(outDb);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    // Soft fill under the curve
    g.fillStyle = accent + "18";
    g.lineTo(xFor(maxDb), h); g.lineTo(xFor(minDb), h); g.closePath(); g.fill();

    // Live GR indicator: a horizontal arrow from the diagonal down to the curve at "0 dB input"
    // (Approximation — shows current reduction visually as a vertical bar at right edge.)
    if (liveReductionDb < -0.1) {
      const inputProbe = 0;          // probe at 0 dB
      const yDiag = yFor(inputProbe);
      const yCurve = yFor(transfer(inputProbe));
      g.strokeStyle = accent; g.lineWidth = 1.5;
      const x = xFor(inputProbe);
      g.beginPath(); g.moveTo(x - 6, yDiag); g.lineTo(x + 6, yDiag); g.stroke();
      g.beginPath(); g.moveTo(x - 6, yCurve); g.lineTo(x + 6, yCurve); g.stroke();
      g.strokeStyle = "#ef4444"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, yDiag); g.lineTo(x, yCurve); g.stroke();
    }

    // Threshold label
    g.fillStyle = accent;
    g.font = "9px ui-monospace, monospace";
    g.fillText(`thr ${threshold.toFixed(0)} dB`, xFor(threshold) + 3, 10);
  }, [threshold, ratio, makeup, kneeDb, accent, liveReductionDb, w, h]);

  return <canvas ref={canvasRef} style={{ width: w, height: h, display: "block", marginBottom: 8, borderRadius: "var(--r-0)", border: "1px solid #1d1d28" }} />;
}

function FxReverbSection({ track, onPatch, ctx }: { track: StudioTrack; onPatch: (p: TrackPatch) => void; ctx: AudioContext }) {
  const r = track.reverb;
  const reverbStore = usePresets<TrackReverb>("track_reverb", REVERB_PRESETS);
  return (
    <FxBlock title="Reverb" right={
      <button onClick={() => onPatch({ reverb: { ...r, on: !r.on } })}
        style={miniToggle(r.on, "#8b5cf6")}>{r.on ? "ON" : "OFF"}</button>
    }>
      <PresetMenu store={reverbStore} current={r} onApply={(v) => onPatch({ reverb: v })} label="Reverb Presets" />
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {(["room", "hall", "plate", "spring"] as const).map(t => (
          <button key={t} onClick={() => onPatch({ reverb: { ...r, type: t } })}
            style={{
              flex: 1, padding: "6px 0",
              background: r.type === t ? "rgb(from var(--accent-cyan) r g b / 0.18)" : "var(--bg-tertiary)",
              color:      r.type === t ? "var(--accent-cyan)" : "var(--text-tertiary)",
              border:     `1px solid ${r.type === t ? "var(--accent-cyan)" : "var(--border-primary)"}`,
              boxShadow:  r.type === t ? "0 0 8px rgb(from var(--accent-cyan) r g b / 0.3)" : "none",
              fontSize: "var(--t-micro)", fontWeight: 800, cursor: "pointer", borderRadius: "var(--r-0)",
              textTransform: "uppercase", letterSpacing: 0.5, transition: "all 0.15s",
            }}>{t}</button>
        ))}
      </div>
      <ReverbIRDisplay ctx={ctx} type={r.type} size={r.size} wet={r.on ? r.wet : 0} accent="#8b5cf6" />
      {compKnob("Wet/Dry", 0, 1, r.wet,  0.01, (v) => onPatch({ reverb: { ...r, wet: v } }))}
      {compKnob("Size",    0, 1, r.size, 0.01, (v) => onPatch({ reverb: { ...r, size: v } }))}
    </FxBlock>
  );
}

function ReverbIRDisplay({ ctx, type, size, wet, accent }: {
  ctx: AudioContext; type: ReverbType; size: number; wet: number; accent: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const w = 300, h = 80;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr);
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#050508"; g.fillRect(0, 0, w, h);

    // Generate the IR for the current settings (one channel is enough for display)
    const ir = makeReverbIR(ctx, type, size);
    const data = ir.getChannelData(0);
    const len = data.length;
    const sr = ir.sampleRate;
    const seconds = len / sr;

    // Time axis ticks every 0.5 sec
    g.strokeStyle = "#15151a"; g.lineWidth = 1;
    for (let s = 0.5; s < seconds; s += 0.5) {
      const x = (s / seconds) * w;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
    // Mid axis
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();

    // Waveform: peak per pixel column (top + bottom mirror)
    const samplesPerPx = Math.max(1, Math.floor(len / w));
    g.fillStyle = accent;
    g.globalAlpha = 0.9;
    for (let x = 0; x < w; x++) {
      let max = 0;
      const start = x * samplesPerPx;
      const end = Math.min(len, start + samplesPerPx);
      for (let i = start; i < end; i++) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
      // Boost very small tails so the visualization isn't entirely silent for small rooms
      const amp = Math.min(1, max * 1.5) * (h / 2 - 2);
      g.fillRect(x, h / 2 - amp, 1, amp * 2);
    }
    g.globalAlpha = 1;

    // Decay envelope overlay (smoothed peak follower for a cleaner shape)
    g.strokeStyle = accent; g.lineWidth = 1.2;
    g.beginPath();
    let env = 0;
    for (let x = 0; x < w; x++) {
      let max = 0;
      const start = x * samplesPerPx;
      const end = Math.min(len, start + samplesPerPx);
      for (let i = start; i < end; i++) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
      env = Math.max(max, env * 0.985);
      const y = h / 2 - env * (h / 2 - 2);
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();

    // Wet level shaded band on right edge, indicates send amount
    if (wet > 0) {
      g.fillStyle = accent;
      g.globalAlpha = 0.18;
      g.fillRect(w - 4, h - wet * h, 3, wet * h);
      g.globalAlpha = 1;
    }

    // Labels
    g.fillStyle = "#666";
    g.font = "9px ui-monospace, monospace";
    g.fillText(`${type.toUpperCase()} · ${seconds.toFixed(2)}s`, 4, 10);
    g.fillText("0", 2, h - 2);
    g.fillText(`${seconds.toFixed(1)}s`, w - 24, h - 2);
  }, [ctx, type, size, wet, accent, w, h]);

  return <canvas ref={canvasRef} style={{ width: w, height: h, display: "block", marginBottom: 8, borderRadius: "var(--r-0)", border: "1px solid #1d1d28" }} />;
}

function FxSatSection({ track, onPatch }: { track: StudioTrack; onPatch: (p: TrackPatch) => void }) {
  const s = track.saturation;
  return (
    <FxBlock title="Saturation" right={
      <button onClick={() => onPatch({ saturation: { ...s, on: !s.on } })}
        style={miniToggle(s.on, "#f97316")}>{s.on ? "ON" : "OFF"}</button>
    }>
      {compKnob("Drive", 0, 24, s.drive, 0.5, (v) => onPatch({ saturation: { ...s, drive: v } }), " dB")}
    </FxBlock>
  );
}

function FxSidechainSection({ track, allTracks, onPatch }: { track: StudioTrack; allTracks: StudioTrack[]; onPatch: (p: TrackPatch) => void }) {
  return (
    <FxBlock title="Sidechain (duck from)">
      <select value={track.sidechainSourceId || ""}
        onChange={(e) => onPatch({ sidechainSourceId: e.target.value || null })}
        style={{
          width: "100%", background: "var(--bg-tertiary)", color: "var(--text-primary)",
          border: "1px solid var(--border-primary)", padding: "6px 8px",
          fontSize: "var(--t-small)", borderRadius: "var(--r-0)", marginBottom: 6,
        }}
      >
        <option value="">— off —</option>
        {allTracks.filter(t => t.id !== track.id).map(t => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      {track.sidechainSourceId && compKnob("Reduction", 0, 30, track.sidechainAmountDb, 0.5,
        (v) => onPatch({ sidechainAmountDb: v }), " dB")}
    </FxBlock>
  );
}

function FxBlock({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 12, borderRadius: "var(--r-0)", overflow: "hidden",
      border: "1px solid #1d1d28",
      background: "linear-gradient(180deg,#0c0c12 0%,#08080d 100%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "7px 11px",
        background: "linear-gradient(180deg,#1a1a22 0%,#141420 100%)",
        borderBottom: "1px solid #0a0a0f",
      }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-cyan)", boxShadow: "var(--e-0)" }} />
        <div style={{ flex: 1, fontSize: "var(--t-micro)", color: "#c8c8d4", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 800 }}>
          {title}
        </div>
        {right}
      </div>
      <div style={{ padding: 11 }}>{children}</div>
    </div>
  );
}

function compKnob(label: string, min: number, max: number, val: number, step: number, onChange: (v: number) => void, unit = "") {
  return (
    <Fader label={label} min={min} max={max} step={step} value={val} onChange={onChange} unit={unit} />
  );
}

function miniToggle(active: boolean, color: string): React.CSSProperties {
  return {
    padding: "4px 13px", borderRadius: "var(--r-0)",
    background: active ? color : "var(--bg-tertiary)",
    color: active ? "#fff" : "var(--text-tertiary)",
    border: active ? `1px solid ${color}` : "1px solid var(--border-primary)",
    boxShadow: active ? `0 0 8px ${color}88` : "none",
    fontSize: "var(--t-micro)", fontWeight: 800, letterSpacing: "0.08em", cursor: "pointer",
    transition: "all 0.15s",
  };
}

// ── Context menu ────────────────────────────────────────────────

function ContextMenu({ x, y, items, onClose }: {
  x: number; y: number;
  items: { label: string; onClick: () => void; danger?: boolean; separator?: boolean }[];
  onClose: () => void;
}) {
  // Close on outside click
  useEffect(() => {
    const onDown = () => onClose();
    setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);
  // Reposition if would clip viewport
  const adjX = Math.min(x, window.innerWidth - 220);
  const adjY = Math.min(y, window.innerHeight - items.length * 28 - 8);
  return (
    <div onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed", left: adjX, top: adjY, minWidth: 200,
        background: "var(--bg-primary)", border: "1px solid var(--border-primary)", padding: 4,
        zIndex: 5000, fontFamily: "Inter, system-ui, sans-serif",
        boxShadow: "var(--e-float)",
      }}
    >
      {items.map((it, i) => it.separator ? (
        <div key={i} style={{ height: 1, background: "#1a1a1e", margin: "3px 4px" }} />
      ) : (
        <button key={i}
          onClick={() => { it.onClick(); onClose(); }}
          style={{
            display: "block", width: "100%", textAlign: "left" as const,
            padding: "5px 10px",
            background: "transparent",
            color: it.danger ? "#ef4444" : "#ddd",
            border: "none", fontSize: "var(--t-small)", cursor: "pointer", borderRadius: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#1a1a22"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
        >{it.label}</button>
      ))}
    </div>
  );
}

// ── Snapshots panel (floating) ──────────────────────────────────

function SnapshotsPanel({ snapshots, onTake, onRecall, onDelete, onClose }: {
  snapshots: MixerSnapshot[];
  onTake: () => void;
  onRecall: (s: MixerSnapshot) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div style={{
      position: "fixed", right: 16, top: 110,
      width: 280, maxHeight: "60vh",
      background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
      boxShadow: "var(--e-float)",
      zIndex: 1500, fontFamily: "Inter, system-ui, sans-serif",
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        height: 28, padding: "0 10px", background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border-primary)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <div style={{ flex: 1, fontSize: "var(--t-small)", color: "var(--text-primary)", fontWeight: 600 }}>Snapshots</div>
        <button onClick={onClose}
          style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: "var(--t-lead)", cursor: "pointer", padding: "0 4px" }}
        >×</button>
      </div>
      <div style={{ padding: 8, overflowY: "auto", flex: 1 }}>
        <button onClick={onTake}
          style={{
            width: "100%", padding: "6px",
            background: "#1e293b", color: "var(--accent-blue)",
            border: "1px solid #334155",
            fontSize: "var(--t-small)", fontWeight: 700, cursor: "pointer", borderRadius: 0,
            marginBottom: 8, letterSpacing: 0.5,
          }}
        >+ TAKE SNAPSHOT</button>
        {snapshots.length === 0 && (
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", textAlign: "center" as const, padding: "20px 8px" }}>
            No snapshots yet. Capture the current mixer state to recall it later.
          </div>
        )}
        {snapshots.map(s => (
          <div key={s.id}
            style={{
              padding: 8, marginBottom: 6,
              background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <div style={{ flex: 1, fontSize: "var(--t-small)", color: "#fff", fontWeight: 600 }}>{s.name}</div>
              <button onClick={() => onDelete(s.id)}
                title="Delete snapshot"
                style={{ background: "transparent", border: "none", color: "var(--text-tertiary)", fontSize: "var(--t-lead)", cursor: "pointer", padding: "0 4px" }}
              >×</button>
            </div>
            <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", marginBottom: 6, fontFamily: "ui-monospace, monospace" }}>
              {new Date(s.takenAt).toLocaleTimeString()} · {s.tracksJson.length} tracks
            </div>
            <button onClick={() => onRecall(s)}
              style={{
                width: "100%", padding: "4px",
                background: "var(--bg-secondary)", color: "#22c55e",
                border: "1px solid #22c55e44",
                fontSize: "var(--t-micro)", fontWeight: 700, cursor: "pointer", borderRadius: 0,
                letterSpacing: 0.5,
              }}
            >↺ RECALL</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Keyboard help overlay ───────────────────────────────────────

function KeyboardHelpOverlay({ onClose }: { onClose: () => void }) {
  const groups: { name: string; rows: [string, string][] }[] = [
    {
      name: "Transport",
      rows: [
        ["Space",         "Play / Stop"],
        ["M",             "Drop marker at playhead"],
      ],
    },
    {
      name: "Tools",
      rows: [
        ["V",             "Select tool"],
        ["C",             "Blade tool — click region to cut, or press C while hovering"],
        ["T",             "Trim tool — drag region edges or body half"],
        ["F",             "Fade tool — drag corners for fade-in/out"],
      ],
    },
    {
      name: "Edit",
      rows: [
        ["Ctrl/Cmd + Z",  "Undo"],
        ["Ctrl/Cmd + Shift + Z", "Redo"],
        ["Ctrl/Cmd + C",  "Copy selected region"],
        ["Ctrl/Cmd + V",  "Paste at playhead"],
        ["Ctrl/Cmd + D",  "Duplicate region (placed after current)"],
        ["Backspace / Delete", "Delete selected region or automation point"],
      ],
    },
    {
      name: "Timeline",
      rows: [
        ["Click ruler",   "Set playhead"],
        ["Drag ruler",    "Define loop range (auto-enables loop)"],
        ["Ctrl/Cmd + scroll on timeline", "Zoom around cursor"],
      ],
    },
    {
      name: "Other",
      rows: [
        ["?",             "Toggle this help overlay"],
        ["Esc",           "Close overlays / context menus"],
        ["Right-click region",  "Region context menu (split / duplicate / delete...)"],
        ["Right-click track header", "Track context menu"],
      ],
    },
  ];
  return (
    <div onMouseDown={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(8,8,12,0.85)",
        zIndex: 9999, display: "flex",
        alignItems: "center", justifyContent: "center",
        backdropFilter: "blur(4px)",
      }}
    >
      <div onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 720, maxHeight: "80vh", overflowY: "auto",
          background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
          padding: 24, fontFamily: "Inter, system-ui, sans-serif",
          boxShadow: "var(--e-float)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <div style={{ flex: 1, fontSize: "var(--t-head)", color: "#fff", fontWeight: 700, letterSpacing: 0.5 }}>
            Keyboard Shortcuts
          </div>
          <button onClick={onClose}
            style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: "var(--t-head)", cursor: "pointer" }}
          >×</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          {groups.map(g => (
            <div key={g.name}>
              <div style={{ fontSize: "var(--t-micro)", color: "var(--accent-blue)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>
                {g.name}
              </div>
              {g.rows.map(([k, d]) => (
                <div key={k} style={{ display: "flex", marginBottom: 6, fontSize: "var(--t-small)" }}>
                  <div style={{
                    minWidth: 130, padding: "2px 6px",
                    background: "#1a1a22", color: "#fde047",
                    border: "1px solid var(--border-primary)",
                    fontFamily: "ui-monospace, monospace",
                    marginRight: 10,
                  }}>{k}</div>
                  <div style={{ flex: 1, color: "var(--text-secondary)", paddingTop: 2 }}>{d}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16, fontSize: "var(--t-micro)", color: "var(--text-tertiary)", textAlign: "center" as const }}>
          Press <span style={{ color: "#fde047" }}>?</span> or <span style={{ color: "#fde047" }}>Esc</span> to close
        </div>
      </div>
    </div>
  );
}

// ── Auto-normalize dropdown ─────────────────────────────────────

function NormalizeMenu({ onPick }: { onPick: (target: number) => void }) {
  return (
    <ToolbarMenu label="▮▮ Norm ▾" title="Auto-normalize mix to broadcast loudness" minWidth={200}>
      {(close) => [
        { name: "Broadcast (-23 LUFS, EBU R128)",  v: -23 },
        { name: "Streaming (-16 LUFS)",             v: -16 },
        { name: "Spotify / Apple (-14 LUFS)",       v: -14 },
        { name: "Loud (-9 LUFS)",                   v: -9  },
      ].map(o => (
        <MenuItem key={o.v} fontSize={11} onClick={() => { close(); onPick(o.v); }}>{o.name}</MenuItem>
      ))}
    </ToolbarMenu>
  );
}

// ── Add Track menu (with templates) ─────────────────────────────

function AddTrackMenu({ onAdd }: { onAdd: (template: "vocal" | "music" | "drum" | "plain") => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", height: 36, background: "transparent",
          border: "1px dashed var(--border-primary)", color: "var(--text-secondary)",
          fontSize: "var(--t-small)", cursor: "pointer", borderRadius: 0,
        }}
      >+ Add Track ▾</button>
      {open && (
        <div onMouseLeave={() => setOpen(false)}
          style={{
            position: "absolute", top: "100%", left: 0, right: 0,
            background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
            zIndex: 50, padding: 4,
          }}
        >
          {([
            { id: "plain", label: "Plain Track",     desc: "" },
            { id: "vocal", label: "Vocal Track",     desc: "EQ + Comp + Plate reverb" },
            { id: "music", label: "Music Bed",       desc: "EQ tilted for bed mix" },
            { id: "drum",  label: "Drum Track",      desc: "Punchy comp + drive" },
          ] as const).map(t => (
            <button key={t.id} onClick={() => { setOpen(false); onAdd(t.id); }}
              style={{
                display: "block", width: "100%", textAlign: "left" as const,
                padding: "6px 8px",
                background: "transparent", color: "var(--text-primary)",
                border: "none", fontSize: "var(--t-small)", cursor: "pointer", borderRadius: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#1a1a22"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              <div style={{ fontWeight: 600 }}>{t.label}</div>
              {t.desc && <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>{t.desc}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── LUFS meter ──────────────────────────────────────────────────

function LUFSMeter({ lufsMomentary, width }: { lufsMomentary: number; width: number }) {
  // Map -50..0 LUFS to bar width, with broadcast target zones marked.
  const v = isFinite(lufsMomentary) ? lufsMomentary : -50;
  const minDb = -50, maxDb = 0;
  const pct = Math.min(1, Math.max(0, (v - minDb) / (maxDb - minDb)));
  const targetMark = (db: number, color: string) => ({
    left: `${((db - minDb) / (maxDb - minDb)) * 100}%`, color,
  });
  const broadcast = targetMark(-23, "#22c55e");
  const streaming = targetMark(-16, "#fde047");
  const loud      = targetMark(-9,  "#ef4444");
  // Color depends on zone
  const color = v <= -23 ? "#3b82f6" : v <= -16 ? "#22c55e" : v <= -9 ? "#fde047" : "#ef4444";
  return (
    <div style={{ width }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--t-micro)", color: "var(--text-secondary)", marginBottom: 3 }}>
        <span>LUFS (momentary, K-weighted)</span>
        <span style={{ color: "var(--text-secondary)", fontFamily: "ui-monospace, monospace" }}>
          {isFinite(v) ? v.toFixed(1) : "—"}
        </span>
      </div>
      <div style={{ position: "relative", width: "100%", height: 10, background: "#1a1a1e", overflow: "hidden" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: color, transition: "width 80ms linear" }} />
        {/* Target markers */}
        {[{ ...broadcast, lbl: "-23" }, { ...streaming, lbl: "-16" }, { ...loud, lbl: "-9" }].map((m, i) => (
          <React.Fragment key={i}>
            <div style={{ position: "absolute", top: 0, left: m.left, width: 1, height: "100%", background: m.color, opacity: 0.7 }} />
          </React.Fragment>
        ))}
      </div>
      <div style={{ display: "flex", fontSize: "var(--t-micro)", color: "var(--text-tertiary)", marginTop: 2, fontFamily: "ui-monospace, monospace" }}>
        <span style={{ flex: 1, textAlign: "left" }}>-50</span>
        <span style={{ flex: 1, textAlign: "center", color: "#22c55e" }}>-23 broadcast</span>
        <span style={{ flex: 1, textAlign: "center", color: "#fde047" }}>-16 stream</span>
        <span style={{ flex: 1, textAlign: "right" }}>0</span>
      </div>
    </div>
  );
}

// ── Stereo correlation meter ────────────────────────────────────

function CorrelationMeter({ correlation, width }: { correlation: number; width: number }) {
  const v = Math.max(-1, Math.min(1, correlation));
  const pctFromCenter = v * 0.5;   // -0.5..+0.5 range relative to center
  // Color: green = mono-compatible, yellow = wide, red = phase-cancel
  const color = v >= 0.5 ? "#3b82f6" : v >= 0 ? "#22c55e" : v >= -0.5 ? "#fde047" : "#ef4444";
  return (
    <div style={{ width }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--t-micro)", color: "var(--text-secondary)", marginBottom: 3 }}>
        <span>Stereo correlation</span>
        <span style={{ color: "var(--text-secondary)", fontFamily: "ui-monospace, monospace" }}>{v.toFixed(2)}</span>
      </div>
      <div style={{ position: "relative", width: "100%", height: 10, background: "#1a1a1e", overflow: "hidden" }}>
        <div style={{ position: "absolute", left: "50%", top: 0, width: 1, height: "100%", background: "#444" }} />
        <div style={{
          position: "absolute", top: 0, height: "100%",
          left: v >= 0 ? "50%" : `${50 + pctFromCenter * 100}%`,
          width: `${Math.abs(pctFromCenter) * 100}%`,
          background: color, transition: "all 80ms linear",
        }} />
      </div>
      <div style={{ display: "flex", fontSize: "var(--t-micro)", color: "var(--text-tertiary)", marginTop: 2, fontFamily: "ui-monospace, monospace" }}>
        <span style={{ flex: 1, textAlign: "left", color: "#ef4444" }}>-1 phase</span>
        <span style={{ flex: 1, textAlign: "center" }}>0 wide</span>
        <span style={{ flex: 1, textAlign: "right", color: "#3b82f6" }}>+1 mono</span>
      </div>
    </div>
  );
}

// ── Goniometer / vectorscope ────────────────────────────────────

function Goniometer({ lAnalyser, rAnalyser, size }: {
  lAnalyser: AnalyserNode | null; rAnalyser: AnalyserNode | null; size: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.floor(size * dpr);
    cv.height = Math.floor(size * dpr);
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    let raf = 0;
    const lBuf = lAnalyser ? new Float32Array(lAnalyser.fftSize) : null;
    const rBuf = rAnalyser ? new Float32Array(rAnalyser.fftSize) : null;
    const draw = () => {
      // Persistence: fade the previous frame slightly instead of full clear
      g.fillStyle = "rgba(5,5,8,0.18)";
      g.fillRect(0, 0, size, size);
      // Diamond outline + L/R axes
      g.strokeStyle = "#1a1a22"; g.lineWidth = 1;
      g.beginPath();
      g.moveTo(size / 2, 0); g.lineTo(size, size / 2);
      g.lineTo(size / 2, size); g.lineTo(0, size / 2); g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(0, size / 2); g.lineTo(size, size / 2);
      g.moveTo(size / 2, 0); g.lineTo(size / 2, size);
      g.stroke();
      if (lAnalyser && rAnalyser && lBuf && rBuf) {
        lAnalyser.getFloatTimeDomainData(lBuf);
        rAnalyser.getFloatTimeDomainData(rBuf);
        const cx = size / 2, cy = size / 2;
        const scale = size * 0.45;
        g.fillStyle = "#22c55e";
        // Sub-sample for performance (every 4th sample)
        for (let i = 0; i < lBuf.length; i += 4) {
          // Rotate L/R by 45° to get classic vectorscope diamond
          const L = lBuf[i], R = rBuf[i];
          const x = cx + (L - R) * scale;
          const y = cy - (L + R) * scale;
          g.fillRect(x, y, 1, 1);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [lAnalyser, rAnalyser, size]);
  return (
    <div>
      <div style={{ fontSize: "var(--t-micro)", color: "var(--text-secondary)", marginBottom: 3 }}>Goniometer</div>
      <canvas ref={canvasRef}
        style={{ width: size, height: size, display: "block", background: "#050508", margin: "0 auto" }}
      />
    </div>
  );
}

// ── Version History Panel ────────────────────────────────────────

function VersionHistoryPanel({
  sessionName, versions, previewVersionId,
  onPreview, onRestore, onSaveVersion, onClose,
}: {
  sessionName: string;
  versions: SessionVersion[];
  previewVersionId: string | null;
  onPreview: (id: string) => void;
  onRestore: (v: SessionVersion) => void;
  onSaveVersion: () => void;
  onClose: () => void;
}) {
  const fmtDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
           d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };

  const safeVersions = versions ?? [];
  const autoSaves   = safeVersions.filter(v => v.label === "Auto-save");
  const manualSaves = safeVersions.filter(v => v.label !== "Auto-save");

  const VersionRow = ({ v }: { v: SessionVersion }) => {
    const isPreview = previewVersionId === v.id;
    const isAuto    = v.label === "Auto-save";
    return (
      <div
        onClick={() => onPreview(v.id)}
        style={{
          padding: "10px 14px", cursor: "pointer",
          background: isPreview ? "rgba(99,102,241,0.12)" : "transparent",
          borderLeft: `3px solid ${isPreview ? "#6366f1" : "transparent"}`,
          borderBottom: "1px solid var(--border-primary)",
          transition: "background 0.12s",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{
              fontSize: "var(--t-micro)", fontWeight: 700, letterSpacing: "0.1em",
              color: isAuto ? "#555" : "#6366f1",
              background: isAuto ? "rgba(255,255,255,0.04)" : "rgba(99,102,241,0.15)",
              padding: "2px 6px", flexShrink: 0,
            }}>
              v{v.version_number}
            </span>
            <span style={{
              fontSize: "var(--t-body)", color: isAuto ? "#666" : "#ccc",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              fontStyle: isAuto ? "italic" : "normal",
            }}>
              {v.label || `Version ${v.version_number}`}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {typeof v.track_count === "number" && (
              <span style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>{v.track_count}t</span>
            )}
            <span style={{ fontSize: "var(--t-micro)", color: "#444" }}>{fmtDate(v.created_at)}</span>
          </div>
        </div>

        {isPreview && (
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button
              onClick={e => { e.stopPropagation(); onRestore(v); }}
              style={{
                flex: 1, padding: "7px 0", background: "#6366f1", border: "none",
                color: "#fff", fontSize: "var(--t-small)", fontWeight: 700, cursor: "pointer",
                fontFamily: "Inter, system-ui, sans-serif",
              }}
            >
              Restore this version
            </button>
            <button
              onClick={e => { e.stopPropagation(); onPreview(v.id); }}
              style={{
                padding: "7px 12px", background: "#1a1a1e", border: "1px solid #333",
                color: "var(--text-secondary)", fontSize: "var(--t-small)", cursor: "pointer",
              }}
            >
              Collapse
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{
      position: "absolute", top: 0, right: 0, bottom: 0,
      width: 320, background: "var(--bg-primary)", borderLeft: "1px solid var(--border-primary)",
      display: "flex", flexDirection: "column", zIndex: 60,
      boxShadow: "var(--e-float)",
    }}>
      {/* Header */}
      <div style={{
        padding: "14px 16px 12px", borderBottom: "1px solid var(--border-primary)",
        display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: "var(--t-lead)", fontWeight: 700, color: "var(--text-primary)", marginBottom: 2 }}>Version History</div>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
            {sessionName}
          </div>
        </div>
        <button onClick={onClose}
          style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: "var(--t-head)", cursor: "pointer", lineHeight: 1 }}>
          ✕
        </button>
      </div>

      {/* Save Version button */}
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <button
          onClick={onSaveVersion}
          style={{
            width: "100%", padding: "8px 0",
            background: "rgba(99,102,241,0.15)", border: "1px solid rgba(99,102,241,0.35)",
            color: "#a5b4fc", fontSize: "var(--t-body)", fontWeight: 700, cursor: "pointer",
            fontFamily: "Inter, system-ui, sans-serif", letterSpacing: "0.02em",
          }}
        >
          + Save Version Now
        </button>
      </div>

      {/* Version list */}
      <div className="studiopro-scroll" style={{ flex: 1, overflowY: "auto" }}>
        {safeVersions.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-tertiary)", fontSize: "var(--t-body)" }}>
            No versions saved yet.<br />
            <span style={{ fontSize: "var(--t-small)" }}>Click "+ Save Version Now" or use Ctrl+Shift+S.</span>
          </div>
        ) : (
          <>
            {manualSaves.length > 0 && (
              <>
                <div style={{ padding: "8px 14px 4px", fontSize: "var(--t-micro)", color: "var(--text-tertiary)", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" as const }}>
                  Manual saves ({manualSaves.length})
                </div>
                {manualSaves.map(v => <VersionRow key={v.id} v={v} />)}
              </>
            )}
            {autoSaves.length > 0 && (
              <>
                <div style={{ padding: "8px 14px 4px", fontSize: "var(--t-micro)", color: "var(--text-tertiary)", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" as const }}>
                  Auto-saves ({autoSaves.length}/{10})
                </div>
                {autoSaves.map(v => <VersionRow key={v.id} v={v} />)}
              </>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ fontSize: "var(--t-micro)", color: "#444", lineHeight: 1.6 }}>
          Auto-saves every 5 min · Max {10} auto-saves kept · Restoring auto-saves current state first
        </div>
      </div>
    </div>
  );
}

// ── Notes Drawer ─────────────────────────────────────────────────

function NotesDrawer({
  notes, onJump, onResolve, onDelete, onClose,
}: {
  notes: StudioNote[];
  onJump: (ms: number) => void;
  onResolve: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const active   = notes.filter(n => !n.resolved);
  const resolved = notes.filter(n =>  n.resolved);

  const NoteRow = ({ n }: { n: StudioNote }) => (
    <div style={{
      padding: "10px 14px", borderBottom: "1px solid #111",
      opacity: n.resolved ? 0.45 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: n.color, flexShrink: 0 }} />
        <span style={{ fontSize: "var(--t-micro)", fontWeight: 700, color: n.color }}>{n.author}</span>
        <span style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", fontFamily: "ui-monospace, monospace", marginLeft: "auto" }}>
          {fmtTimecode(n.position_ms)}
        </span>
      </div>
      <div style={{
        fontSize: "var(--t-body)", color: n.resolved ? "#555" : "#ccc", lineHeight: 1.5,
        textDecoration: n.resolved ? "line-through" : "none",
      }}>{n.text}</div>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button onClick={() => onJump(n.position_ms)}
          style={{ padding: "2px 8px", fontSize: "var(--t-micro)", background: "rgba(255,255,255,0.04)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
          Jump to
        </button>
        {!n.resolved && (
          <button onClick={() => onResolve(n.id)}
            style={{ padding: "2px 8px", fontSize: "var(--t-micro)", background: "rgba(16,185,129,0.08)", color: "#10b981", border: "1px solid rgba(16,185,129,0.25)", cursor: "pointer" }}>
            Resolve
          </button>
        )}
        <button onClick={() => onDelete(n.id)}
          style={{ padding: "2px 8px", fontSize: "var(--t-micro)", background: "transparent", color: "#444", border: "none", cursor: "pointer", marginLeft: "auto" }}>
          ✕
        </button>
      </div>
    </div>
  );

  return (
    <div style={{
      position: "absolute", right: 0, top: 0, bottom: 0, width: 300,
      background: "var(--bg-primary)", borderLeft: "1px solid var(--border-primary)",
      display: "flex", flexDirection: "column", zIndex: 15,
      fontFamily: "Inter, system-ui, sans-serif",
    }}>
      <div style={{
        padding: "10px 14px", borderBottom: "1px solid var(--border-primary)",
        display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
      }}>
        <span style={{ fontSize: "var(--t-body)", fontWeight: 700, color: "var(--text-secondary)" }}>
          Notes {active.length > 0 && <span style={{ color: "#f59e0b" }}>({active.length})</span>}
        </span>
        <button onClick={onClose}
          style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: "var(--t-lead)", padding: 0 }}>
          ✕
        </button>
      </div>
      <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", padding: "6px 14px", borderBottom: "1px solid #111", flexShrink: 0 }}>
        RIGHT-CLICK RULER TO ADD A NOTE
      </div>
      <div className="studiopro-scroll" style={{ flex: 1, overflowY: "auto" }}>
        {notes.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "#444", fontSize: "var(--t-body)" }}>
            No notes yet.<br />
            <span style={{ fontSize: "var(--t-small)" }}>Right-click the timeline ruler to add one.</span>
          </div>
        ) : (
          <>
            {active.map(n => <NoteRow key={n.id} n={n} />)}
            {resolved.length > 0 && (
              <>
                <div style={{ padding: "8px 14px 4px", fontSize: "var(--t-micro)", color: "#444", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const }}>
                  Resolved ({resolved.length})
                </div>
                {resolved.map(n => <NoteRow key={n.id} n={n} />)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
