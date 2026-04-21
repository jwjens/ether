'use strict';

// ether-playout — cloud continuous playout engine
//
// Receives schedule pushes from the local Ether app, fetches audio
// from Cloudflare R2, and streams continuously to Icecast via ffmpeg.
// Runs as a systemd service on the cloud server.
//
// API endpoints:
//   GET  /api/playout/status      — current state + now-playing
//   POST /api/playout/schedule    — receive full schedule from local Ether
//   POST /api/playout/r2config    — receive R2 credentials
//   POST /api/playout/control     — play/pause/skip
//   GET  /api/playout/log         — recent playout log (last 100 entries)

const express    = require('express');
const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const http       = require('http');
const https      = require('https');
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PORT        = process.env.PORT        || 3500;
const ICECAST_URL = process.env.ICECAST_URL || 'icecast://source:hackme@localhost:8000/live';
const CACHE_DIR   = process.env.CACHE_DIR   || '/tmp/ether-playout-cache';
const CONFIG_FILE = path.join(__dirname, 'playout-config.json');
const LOG_FILE    = path.join(__dirname, 'playout.log');

fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── State ─────────────────────────────────────────────────────

let r2Config   = loadConfig('r2', {});
let schedule   = loadConfig('schedule', []);  // [{ title, artist, file_key, duration_s, scheduled_at }]
let playIndex  = 0;
let ffmpegProc = null;
let currentTrack = null;
let status     = 'idle';   // idle | playing | downloading | error
let startedAt  = null;
let playLog    = [];

// ── Logging ───────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  playLog.unshift(line);
  if (playLog.length > 200) playLog.length = 200;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ── Config persistence ────────────────────────────────────────

function loadConfig(key, def) {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw)[key] ?? def;
  } catch { return def; }
}

function saveConfig(key, value) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  all[key] = value;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(all, null, 2));
}

// ── R2 client ─────────────────────────────────────────────────

function makeS3() {
  if (!r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey) return null;
  return new S3Client({
    region: 'auto',
    endpoint: r2Config.endpoint || `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     r2Config.accessKeyId,
      secretAccessKey: r2Config.secretAccessKey,
    },
  });
}

async function downloadTrack(fileKey) {
  const s3 = makeS3();
  if (!s3) throw new Error('R2 not configured');

  const cachePath = path.join(CACHE_DIR, path.basename(fileKey).replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (fs.existsSync(cachePath)) return cachePath;

  log(`Downloading ${fileKey} from R2…`);
  const cmd = new GetObjectCommand({ Bucket: r2Config.bucket || 'ether-audio', Key: fileKey });
  const url  = await getSignedUrl(s3, cmd, { expiresIn: 300 });

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(cachePath);
    const get  = url.startsWith('https') ? https : http;
    get.get(url, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => {
      fs.unlink(cachePath, () => {});
      reject(err);
    });
  });

  log(`Downloaded: ${path.basename(fileKey)} (${(fs.statSync(cachePath).size / 1e6).toFixed(1)} MB)`);
  return cachePath;
}

// ── Playout engine ────────────────────────────────────────────

function killFfmpeg() {
  if (ffmpegProc) {
    try { ffmpegProc.kill('SIGTERM'); } catch {}
    ffmpegProc = null;
  }
}

async function playNext() {
  if (!schedule.length) {
    status = 'idle';
    currentTrack = null;
    log('Schedule empty — waiting for tracks');
    setTimeout(playNext, 10_000);
    return;
  }

  const track = schedule[playIndex % schedule.length];
  playIndex++;

  log(`▶ ${track.title || track.file_key} — ${track.artist || ''}`);
  status = 'downloading';
  currentTrack = { ...track, startedAt: new Date().toISOString() };
  startedAt = Date.now();

  let localPath;
  try {
    localPath = await downloadTrack(track.file_key);
  } catch (e) {
    log(`Download failed for ${track.file_key}: ${e.message} — skipping`);
    status = 'error';
    setTimeout(playNext, 2_000);
    return;
  }

  status = 'playing';

  // ffmpeg: read local file → encode as MP3 128k → push to Icecast
  ffmpegProc = spawn('ffmpeg', [
    '-re',                        // read at native rate (real-time)
    '-i', localPath,
    '-vn',                        // strip any video/artwork
    '-af', 'loudnorm=I=-16:LRA=7:TP=-1.5',  // ITU-R BS.1770-4 loudness normalize
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'mp3',
    '-content_type', 'audio/mpeg',
    ICECAST_URL,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpegProc.stderr.on('data', d => {
    const line = d.toString();
    // Only log errors, not progress noise
    if (/error|failed|invalid/i.test(line)) log('[ffmpeg] ' + line.trim());
  });

  ffmpegProc.on('close', code => {
    ffmpegProc = null;
    if (code !== 0 && code !== null) {
      log(`ffmpeg exited with code ${code}`);
    }
    // Small gap between tracks, then auto-advance
    setTimeout(playNext, 500);
  });
}

function startPlayout() {
  if (status === 'playing' || status === 'downloading') return;
  playIndex = 0;
  playNext();
}

function skipTrack() {
  log('Skip requested');
  killFfmpeg();
  // playNext() will be called by the 'close' handler
}

// ── Express API ───────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS — allow local Ether app
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Ether-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/playout/status', (req, res) => {
  res.json({
    status,
    currentTrack,
    scheduleLength: schedule.length,
    playIndex: playIndex % Math.max(schedule.length, 1),
    icecastUrl: ICECAST_URL.replace(/:\/\/.*?@/, '://***@'),  // mask password
    uptime: Math.floor(process.uptime()),
    r2Ready: !!(r2Config.accountId && r2Config.accessKeyId && r2Config.secretAccessKey),
    streamUrl: `http://${getPublicIp()}:8000/live`,
  });
});

app.post('/api/playout/schedule', (req, res) => {
  const { tracks } = req.body;
  if (!Array.isArray(tracks)) return res.status(400).json({ error: 'tracks must be array' });
  schedule = tracks;
  playIndex = 0;
  saveConfig('schedule', schedule);
  log(`Schedule updated: ${tracks.length} tracks`);
  if (status === 'idle') startPlayout();
  res.json({ ok: true, count: tracks.length });
});

app.post('/api/playout/r2config', (req, res) => {
  const { accountId, accessKeyId, secretAccessKey, bucket, endpoint } = req.body;
  if (accountId)      r2Config.accountId      = accountId;
  if (accessKeyId)    r2Config.accessKeyId    = accessKeyId;
  if (secretAccessKey)r2Config.secretAccessKey = secretAccessKey;
  if (bucket)         r2Config.bucket          = bucket;
  if (endpoint)       r2Config.endpoint        = endpoint;
  saveConfig('r2', r2Config);
  log('R2 config updated');
  res.json({ ok: true });
});

app.post('/api/playout/control', (req, res) => {
  const { action } = req.body;
  if (action === 'play')  { startPlayout(); res.json({ ok: true, status }); }
  else if (action === 'skip')  { skipTrack();  res.json({ ok: true }); }
  else if (action === 'stop')  { killFfmpeg(); status = 'idle'; res.json({ ok: true }); }
  else res.status(400).json({ error: 'unknown action' });
});

app.get('/api/playout/log', (req, res) => {
  res.json({ lines: playLog.slice(0, 100) });
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Public IP helper ──────────────────────────────────────────

let _publicIp = '44.244.52.207';
function getPublicIp() { return _publicIp; }
// Try to detect actual IP on startup
http.get('http://checkip.amazonaws.com', res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => { if (d.trim()) _publicIp = d.trim(); });
}).on('error', () => {});

// ── Boot ──────────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`Ether Playout API listening on :${PORT}`);
  log(`Icecast target: ${ICECAST_URL.replace(/:\/\/.*?@/, '://***@')}`);
  log(`R2 ready: ${!!(r2Config.accountId && r2Config.accessKeyId)}`);
  log(`Schedule: ${schedule.length} tracks`);

  // Auto-start if we have a schedule
  if (schedule.length > 0) {
    log('Auto-starting playout from saved schedule');
    setTimeout(startPlayout, 3_000);
  }
});

process.on('SIGTERM', () => { killFfmpeg(); process.exit(0); });
process.on('SIGINT',  () => { killFfmpeg(); process.exit(0); });
