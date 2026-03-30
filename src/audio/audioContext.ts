// src/audio/audioContext.ts
// Global AudioContext singleton — Chrome limits to 6 concurrent contexts.
// All components must use this instead of creating their own.

let _ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!_ctx || _ctx.state === "closed") {
    _ctx = new AudioContext({ sampleRate: 44100 });
  }
  if (_ctx.state === "suspended") {
    _ctx.resume().catch(() => {});
  }
  return _ctx;
}

export function closeAudioContext() {
  if (_ctx && _ctx.state !== "closed") {
    _ctx.close().catch(() => {});
    _ctx = null;
  }
}
