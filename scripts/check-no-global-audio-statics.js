#!/usr/bin/env node
'use strict';
// DESIGN-TRUTH §2 guard — "each station is its own sound card; stations do not know each other exists."
// Fails CI if a GLOBAL scalar audio-state static (one clock/flag shared by all stations) reappears in
// the native audio path, or if the renderer liveness clock regresses from per-station to a scalar.
// These are the exact shapes that caused the 2026-07-10 cross-station wedge (one global lastCallbackMs
// + one global STREAM_CLIENT_CONNECTED masked/killed sibling stations). Per-station state (keyed maps,
// Arc<Atomic> fields on BusState/engine) is allowed — only module-level shared SCALARS are forbidden.

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const violations = [];

function read(rel) { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } }

// 1) No module-level scalar Atomic statics in the native audio engine.
const audio = read('native/src/audio.rs');
audio.split(/\r?\n/).forEach((line, i) => {
  // column-0 `static NAME: AtomicXXX` = process-global scalar shared across all stations.
  const m = /^static\s+([A-Z0-9_]+)\s*:\s*Atomic(Bool|U8|U16|U32|U64|I32|I64|Usize)\b/.exec(line);
  if (m) violations.push(`native/src/audio.rs:${i + 1}  global scalar audio static "${m[1]}" — must be per-station (keyed map or Arc<Atomic> on BusState/engine)`);
});

// 2) Retired offenders must never come back (by name), anywhere in the audio path.
const RETIRED = ['LAST_AUDIO_CALLBACK_MS', 'STREAM_CLIENT_CONNECTED', 'SAMPLES_PUSHED',
  'LAST_REPORT_NS', 'CB_COUNT', 'CB_REPORT_NS', 'LAST_CB_NS', 'PEAK_REPORT_NS',
  'DRAIN_BYTES_TOTAL', 'DRAIN_ZERO_FILL_BYTES', 'note_audio_callback'];
for (const rel of ['native/src/audio.rs', 'native/src/lib.rs']) {
  const src = read(rel);
  for (const name of RETIRED) {
    if (new RegExp(`\\b${name}\\b`).test(src)) violations.push(`${rel}  retired global "${name}" reappeared — it was removed for cross-station masking; keep it gone`);
  }
}

// 3) Renderer liveness clock must stay per-station (a Map), not a scalar.
const main = read('electron/main.js');
if (/\blet\s+_lastDaemonAudioAt\s*=\s*0\b/.test(main)) {
  violations.push('electron/main.js  _lastDaemonAudioAt regressed to a scalar — must be a per-station Map (DESIGN-TRUTH §2)');
}

if (violations.length) {
  console.error('✗ DESIGN-TRUTH §2 (station isolation) guard FAILED:\n');
  for (const v of violations) console.error('  - ' + v);
  console.error('\nSee docs/DESIGN-TRUTH.md §2. Per-station only; no shared global audio state.');
  process.exit(1);
}
console.log('✓ station-isolation guard passed — no global scalar audio state.');
