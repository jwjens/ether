#!/usr/bin/env node
// Piece 2 verification: connect to station N's named pipe and report byte flow.
// Usage:  node scripts/diag-pipe-output.js [stationId=1] [durationSec=5]
//
// What it checks:
//   1. Can connect to \\.\pipe\ether-program-N
//   2. Bytes arrive continuously (> 0 bytes/sec)
//   3. At least one sample has |value| > 0.001 (not silence) when audio is playing
//
// Format expected: raw f32le stereo 44100 Hz (882 bytes per 10 ms batch from Rust)

'use strict';

const net     = require('net');
const stationId  = parseInt(process.argv[2] ?? '1', 10);
const duration   = parseFloat(process.argv[3] ?? '5');
const pipeName   = `\\\\.\\pipe\\ether-program-${stationId}`;

console.log(`Connecting to ${pipeName} ...`);

const client = net.createConnection(pipeName);

let totalBytes  = 0;
let totalFrames = 0;
let maxAbs      = 0;
let chunks      = 0;

client.on('connect', () => {
  console.log('Connected.\n');
  setTimeout(() => {
    client.destroy();
    const bytesPerSec = (totalBytes / duration).toFixed(0);
    const framesPerSec = (totalFrames / duration).toFixed(0);
    console.log('\n── Results ──────────────────────────────────────');
    console.log(`  Duration:        ${duration}s`);
    console.log(`  Total bytes:     ${totalBytes}`);
    console.log(`  Bytes/sec:       ${bytesPerSec}  (expected ~352800 for 44.1kHz stereo f32)`);
    console.log(`  Stereo frames:   ${totalFrames}`);
    console.log(`  Frames/sec:      ${framesPerSec}  (expected ~44100)`);
    console.log(`  Chunks received: ${chunks}`);
    console.log(`  Peak |sample|:   ${maxAbs.toFixed(6)}  (> 0 = audio is flowing, not silence)`);
    console.log('─────────────────────────────────────────────────');
    if (totalBytes === 0) {
      console.log('FAIL: no data received — pipe connected but engine not writing');
    } else if (maxAbs < 1e-6) {
      console.log('WARN: pipe flowing but all samples are silence (no deck playing?)');
    } else {
      console.log('PASS: audio data flowing on named pipe');
    }
  }, duration * 1000);
});

client.on('data', (buf) => {
  totalBytes += buf.length;
  chunks++;
  const nSamples = Math.floor(buf.length / 4);
  totalFrames += Math.floor(nSamples / 2); // stereo
  for (let i = 0; i < nSamples; i++) {
    const v = Math.abs(buf.readFloatLE(i * 4));
    if (v > maxAbs) maxAbs = v;
  }
});

client.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(`FAIL: pipe not found — is the app running? (${pipeName})`);
  } else {
    console.error(`FAIL: ${err.message}`);
  }
  process.exit(1);
});
