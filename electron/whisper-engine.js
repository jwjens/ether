// whisper-engine.js — local Whisper transcription via @xenova/transformers
//
// Runs whisper-tiny.en (quantized, ~40 MB) entirely in Node.js via ONNX Runtime.
// No Python, no API key, no internet after the first model download.
//
// Model is cached in <userData>/whisper-models on first use and reused thereafter.
// Typical inference: ~1–2 s for a 5-second chunk on a mid-range CPU.

'use strict';

const { EventEmitter } = require('events');
const path             = require('path');

const SAMPLE_RATE   = 16000;            // Whisper expects 16 kHz mono
const CHUNK_SECONDS = 5;
const CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_SECONDS;

// Rolling 60-second transcript retention
const RETAIN_MS = 60_000;

class WhisperEngine extends EventEmitter {
  constructor() {
    super();
    this._pipeline     = null;
    this._loading      = false;
    this._loadError    = null;
    this._buffer       = new Float32Array(0);
    this._transcript   = [];             // { text, timestamp, speaker }[]
    this._running      = false;
    this._pending      = Promise.resolve(); // serialise async transcribe calls
  }

  // ── lazy model load ───────────────────────────────────────────

  async _ensureLoaded() {
    if (this._pipeline)   return this._pipeline;
    if (this._loadError)  throw this._loadError;
    if (this._loading) {
      return new Promise((res, rej) => {
        this.once('ready', () => res(this._pipeline));
        this.once('load-error', (e) => rej(e));
      });
    }

    this._loading = true;
    console.log('[whisper] Loading whisper-tiny.en (first run downloads ~40 MB)…');
    this.emit('status', { state: 'loading', message: 'Downloading Whisper model (~40 MB)…' });

    try {
      // Dynamic import — @xenova/transformers is ESM-compatible CJS
      const { pipeline, env } = require('@xenova/transformers');

      // Cache models in userData, not node_modules
      const { app } = require('electron');
      env.cacheDir  = path.join(app.getPath('userData'), 'whisper-models');
      env.localModelPath = env.cacheDir;

      this._pipeline = await pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-tiny.en',
        { quantized: true, progress_callback: (p) => {
          if (p.status === 'downloading' && p.total) {
            const pct = Math.round((p.loaded / p.total) * 100);
            this.emit('status', { state: 'loading', message: `Downloading Whisper model… ${pct}%` });
          }
        }}
      );

      this._loading = false;
      console.log('[whisper] Model ready.');
      this.emit('status', { state: 'ready', message: 'Whisper ready' });
      this.emit('ready');
      return this._pipeline;
    } catch (e) {
      this._loading   = false;
      this._loadError = e;
      console.error('[whisper] Failed to load model:', e.message);
      this.emit('status', { state: 'error', message: e.message });
      this.emit('load-error', e);
      throw e;
    }
  }

  // ── public API ────────────────────────────────────────────────

  start() {
    this._running = true;
    this._buffer  = new Float32Array(0);
    this._ensureLoaded().catch(() => {}); // warm up in background
    console.log('[whisper] Started (capturing audio)');
  }

  stop() {
    this._running = false;
    // Flush partial buffer
    if (this._buffer.length > SAMPLE_RATE * 0.5) {
      this._scheduleTranscribe(this._buffer.slice(), 'air');
    }
    this._buffer = new Float32Array(0);
    console.log('[whisper] Stopped');
  }

  // Feed Float32 mono 16 kHz samples from renderer loopback tap.
  // Called for every ScriptProcessor chunk (~4 096 samples).
  feedSamples(samples) {
    if (!this._running) return;

    // Append
    const merged = new Float32Array(this._buffer.length + samples.length);
    merged.set(this._buffer);
    merged.set(samples, this._buffer.length);
    this._buffer = merged;

    // Drain complete 5-second chunks
    while (this._buffer.length >= CHUNK_SAMPLES) {
      const chunk   = this._buffer.slice(0, CHUNK_SAMPLES);
      this._buffer  = this._buffer.slice(CHUNK_SAMPLES);
      this._scheduleTranscribe(chunk, 'air');
    }
  }

  // Inject Iris speech directly — no transcription needed, text is already known.
  addIrisLine(text) {
    const line = this._makeLine(text.trim(), 'iris');
    if (!line.text) return;
    this._addToRollingBuffer(line);
    this.emit('line', line);
  }

  getTranscript() {
    return [...this._transcript];
  }

  // ── internals ─────────────────────────────────────────────────

  _makeLine(text, speaker) {
    return { text, timestamp: new Date().toISOString(), speaker };
  }

  _addToRollingBuffer(line) {
    this._transcript.push(line);
    const cutoff = Date.now() - RETAIN_MS;
    this._transcript = this._transcript.filter(
      l => new Date(l.timestamp).getTime() > cutoff
    );
  }

  // Serialise inference — Whisper is single-threaded, queue chunks rather than
  // running them concurrently.
  _scheduleTranscribe(samples, speaker) {
    this._pending = this._pending.then(() => this._transcribe(samples, speaker)).catch(() => {});
  }

  async _transcribe(samples, speaker) {
    try {
      const pipe = await this._ensureLoaded();

      // VAD-lite: skip if all samples are near-silence (saves inference time)
      const rms = Math.sqrt(samples.reduce((s, x) => s + x * x, 0) / samples.length);
      if (rms < 0.003) return; // ~-50 dBFS threshold

      const result = await pipe(samples, {
        language: 'english',
        task:     'transcribe',
        return_timestamps: false,
        chunk_length_s: CHUNK_SECONDS,
      });

      const text = (result.text || '').trim();
      if (!text) return;

      const line = this._makeLine(text, speaker);
      this._addToRollingBuffer(line);
      this.emit('line', line);
    } catch (e) {
      console.error('[whisper] transcription error:', e.message);
    }
  }
}

module.exports = new WhisperEngine();
