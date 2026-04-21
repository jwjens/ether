#!/usr/bin/env bash
# server-setup.sh — Self-contained Ether Playout setup for Ubuntu
#
# Run on the server:
#   bash server-setup.sh
#
# Everything is written inline via heredoc — no external file downloads.

set -euo pipefail

PLAYOUT_DIR="/home/ubuntu/playout"
SERVICE_NAME="ether-playout"

echo "╔══════════════════════════════════════════╗"
echo "║     Ether Playout — Server Setup         ║"
echo "╚══════════════════════════════════════════╝"

# ── 1. System packages ────────────────────────────────────────
echo ""
echo "▶ Installing system packages…"

sudo apt-get update -qq

# Node.js 20 LTS
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(String(parseInt(process.versions.node)))')" -lt 20 ]]; then
  echo "  Installing Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>&1 | grep -E 'Adding|Done|error' || true
  sudo apt-get install -y nodejs 2>&1 | tail -3
fi
echo "  Node $(node --version)  npm $(npm --version)"

# ffmpeg
if ! command -v ffmpeg &>/dev/null; then
  echo "  Installing ffmpeg…"
  sudo apt-get install -y ffmpeg 2>&1 | tail -3
fi
echo "  ffmpeg $(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f3)"

# icecast2 (non-interactive)
if ! dpkg -l icecast2 &>/dev/null; then
  echo "  Installing icecast2…"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y icecast2 2>&1 | tail -3
fi
echo "  icecast2 installed"

# ── 2. Create playout directory ───────────────────────────────
echo ""
echo "▶ Creating /home/ubuntu/playout…"
mkdir -p "$PLAYOUT_DIR"
mkdir -p "$PLAYOUT_DIR/cache"

# ── 3. Write package.json ─────────────────────────────────────
cat > "$PLAYOUT_DIR/package.json" << 'EOF'
{
  "name": "ether-playout",
  "version": "1.0.0",
  "main": "playout.js",
  "dependencies": {
    "express": "^4.18.2",
    "@aws-sdk/client-s3": "^3.400.0",
    "@aws-sdk/s3-request-presigner": "^3.400.0",
    "node-fetch": "^2.7.0"
  }
}
EOF
echo "  package.json written"

# ── 4. Write playout.js ───────────────────────────────────────
cat > "$PLAYOUT_DIR/playout.js" << 'PLAYOUT_EOF'
'use strict';

// ether-playout — cloud continuous playout engine
// Express API on :3500  |  Icecast stream on :8000/live

const express  = require('express');
const { spawn }  = require('child_process');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const http     = require('http');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PORT        = parseInt(process.env.PORT || '3500', 10);
const ICECAST_URL = process.env.ICECAST_URL || 'icecast://source:hackme@localhost:8000/live';
const CACHE_DIR   = process.env.CACHE_DIR   || path.join(__dirname, 'cache');
const CONFIG_FILE = path.join(__dirname, 'config.json');

fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── Persistent config ─────────────────────────────────────────

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function writeConfig(patch) {
  const c = readConfig();
  Object.assign(c, patch);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
  return c;
}

let cfg      = readConfig();
let r2       = cfg.r2       || {};
let schedule = cfg.schedule || [];   // [{ title, artist, file_key, duration_s }]

// ── State ─────────────────────────────────────────────────────

let playIndex    = 0;
let ffmpegProc   = null;
let currentTrack = null;
let engineStatus = 'idle';   // idle | downloading | playing | error
let playLog      = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  playLog.unshift(line);
  if (playLog.length > 300) playLog.length = 300;
}

// ── R2 download ───────────────────────────────────────────────

function makeS3Client() {
  if (!r2.accountId || !r2.accessKeyId || !r2.secretAccessKey) return null;
  return new S3Client({
    region: 'auto',
    endpoint: r2.endpoint || `https://${r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
  });
}

function safeCacheName(key) {
  return path.basename(key).replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function downloadFromR2(fileKey) {
  const cachePath = path.join(CACHE_DIR, safeCacheName(fileKey));
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 10240) {
    log(`Cache hit: ${path.basename(fileKey)}`);
    return cachePath;
  }

  const s3 = makeS3Client();
  if (!s3) throw new Error('R2 not configured — send POST /api/playout/r2config first');

  log(`Downloading from R2: ${fileKey}`);
  const cmd = new GetObjectCommand({ Bucket: r2.bucket || 'ether-audio', Key: fileKey });
  const url  = await getSignedUrl(s3, cmd, { expiresIn: 600 });

  await new Promise((resolve, reject) => {
    const tmp    = cachePath + '.part';
    const file   = fs.createWriteStream(tmp);
    const client = url.startsWith('https://') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.destroy();
        fs.unlink(tmp, () => {});
        return reject(new Error(`HTTP ${res.statusCode} for ${fileKey}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.rename(tmp, cachePath, (err) => err ? reject(err) : resolve());
        });
      });
    }).on('error', (err) => {
      file.destroy();
      fs.unlink(tmp, () => {});
      reject(err);
    });
  });

  const size = (fs.statSync(cachePath).size / 1e6).toFixed(1);
  log(`Downloaded: ${path.basename(fileKey)} (${size} MB)`);
  return cachePath;
}

// ── Playout engine ────────────────────────────────────────────

function killFfmpeg() {
  if (!ffmpegProc) return;
  try { ffmpegProc.kill('SIGTERM'); } catch {}
  ffmpegProc = null;
}

async function playNext() {
  if (schedule.length === 0) {
    engineStatus = 'idle';
    currentTrack = null;
    log('Queue empty — will retry in 30s');
    setTimeout(playNext, 30_000);
    return;
  }

  const idx   = playIndex % schedule.length;
  const track = schedule[idx];
  playIndex++;

  log(`▶ [${idx + 1}/${schedule.length}] ${track.title || track.file_key} — ${track.artist || ''}`);
  engineStatus = 'downloading';
  currentTrack = { ...track, queuePosition: idx + 1, queueLength: schedule.length, startedAt: new Date().toISOString() };

  let localPath;
  try {
    localPath = await downloadFromR2(track.file_key);
  } catch (err) {
    log(`Download failed (${track.file_key}): ${err.message} — skipping track`);
    engineStatus = 'error';
    setTimeout(playNext, 2_000);
    return;
  }

  engineStatus = 'playing';

  // ffmpeg: file → loudnorm → mp3 128k → icecast
  const args = [
    '-re',
    '-i', localPath,
    '-vn',
    '-af', 'loudnorm=I=-16:LRA=7:TP=-1.5',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'mp3',
    '-content_type', 'audio/mpeg',
    ICECAST_URL,
  ];

  ffmpegProc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpegProc.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    if (/error|failed|invalid|cannot/i.test(line) && !/past duration/i.test(line)) {
      log('[ffmpeg] ' + line.trim().slice(0, 120));
    }
  });

  ffmpegProc.on('close', (code) => {
    ffmpegProc = null;
    if (code !== 0 && code !== null) log(`ffmpeg exited ${code}`);
    // 300ms gap between tracks, then auto-advance
    setTimeout(playNext, 300);
  });
}

function startPlayout() {
  if (engineStatus === 'playing' || engineStatus === 'downloading') {
    log('Already playing — ignoring start request');
    return;
  }
  playIndex = 0;
  log(`Starting playout — ${schedule.length} tracks in queue`);
  playNext();
}

// ── Express API ───────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// GET /api/playout/status
app.get('/api/playout/status', (req, res) => {
  res.json({
    status:         engineStatus,
    currentTrack,
    scheduleLength: schedule.length,
    playIndex:      schedule.length ? playIndex % schedule.length : 0,
    r2Ready:        !!(r2.accountId && r2.accessKeyId && r2.secretAccessKey),
    uptime:         Math.floor(process.uptime()),
  });
});

// POST /api/playout/schedule   { tracks: [...] }
app.post('/api/playout/schedule', (req, res) => {
  const { tracks } = req.body || {};
  if (!Array.isArray(tracks)) return res.status(400).json({ error: 'tracks must be an array' });
  schedule = tracks;
  playIndex = 0;
  writeConfig({ schedule });
  log(`Schedule updated: ${tracks.length} tracks`);
  if (engineStatus === 'idle') startPlayout();
  res.json({ ok: true, count: tracks.length });
});

// POST /api/playout/r2config   { accountId, accessKeyId, secretAccessKey, bucket }
app.post('/api/playout/r2config', (req, res) => {
  const { accountId, accessKeyId, secretAccessKey, bucket, endpoint } = req.body || {};
  if (accountId)       r2.accountId       = accountId;
  if (accessKeyId)     r2.accessKeyId     = accessKeyId;
  if (secretAccessKey) r2.secretAccessKey = secretAccessKey;
  if (bucket)          r2.bucket          = bucket;
  if (endpoint)        r2.endpoint        = endpoint;
  writeConfig({ r2 });
  log('R2 config updated');
  res.json({ ok: true });
});

// POST /api/playout/control   { action: play|stop|skip }
app.post('/api/playout/control', (req, res) => {
  const { action } = req.body || {};
  if (action === 'play') {
    startPlayout();
    return res.json({ ok: true, status: engineStatus });
  }
  if (action === 'skip') {
    log('Skip requested');
    killFfmpeg();
    return res.json({ ok: true });
  }
  if (action === 'stop') {
    killFfmpeg();
    engineStatus = 'idle';
    currentTrack = null;
    log('Stopped');
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'unknown action — use play, skip, or stop' });
});

// GET /api/playout/log
app.get('/api/playout/log', (req, res) => {
  res.json({ lines: playLog.slice(0, 100) });
});

// GET /health
app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

// ── Boot ──────────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`Ether Playout API listening on :${PORT}`);
  log(`Icecast target: ${ICECAST_URL.replace(/:\/\/[^@]+@/, '://***@')}`);
  log(`Schedule: ${schedule.length} tracks  |  R2 ready: ${!!(r2.accountId && r2.accessKeyId && r2.secretAccessKey)}`);
  if (schedule.length > 0) {
    log('Auto-starting from saved schedule');
    setTimeout(startPlayout, 3_000);
  }
});

process.on('SIGTERM', () => { killFfmpeg(); process.exit(0); });
process.on('SIGINT',  () => { killFfmpeg(); process.exit(0); });
PLAYOUT_EOF
echo "  playout.js written ($(wc -l < "$PLAYOUT_DIR/playout.js") lines)"

# ── 5. Configure icecast2 ─────────────────────────────────────
echo ""
echo "▶ Configuring icecast2…"
sudo tee /etc/icecast2/icecast.xml > /dev/null << 'EOF'
<icecast>
  <location>Cloud</location>
  <admin>admin@ether.radio</admin>
  <limits>
    <clients>100</clients>
    <sources>5</sources>
    <queue-size>524288</queue-size>
    <client-timeout>30</client-timeout>
    <header-timeout>15</header-timeout>
    <source-timeout>10</source-timeout>
    <burst-on-connect>1</burst-on-connect>
    <burst-size>65536</burst-size>
  </limits>
  <authentication>
    <source-password>hackme</source-password>
    <relay-password>hackme</relay-password>
    <admin-user>admin</admin-user>
    <admin-password>hackme</admin-password>
  </authentication>
  <hostname>localhost</hostname>
  <listen-socket><port>8000</port></listen-socket>
  <http-headers>
    <header name="Access-Control-Allow-Origin" value="*" />
  </http-headers>
  <mount>
    <mount-name>/live</mount-name>
    <max-listeners>100</max-listeners>
  </mount>
  <fileserve>1</fileserve>
  <paths>
    <basedir>/usr/share/icecast2</basedir>
    <logdir>/var/log/icecast2</logdir>
    <webroot>/usr/share/icecast2/web</webroot>
    <adminroot>/usr/share/icecast2/admin</adminroot>
    <alias source="/" destination="/status.xsl"/>
  </paths>
  <logging>
    <accesslog>access.log</accesslog>
    <errorlog>error.log</errorlog>
    <loglevel>3</loglevel>
  </logging>
  <security><chroot>0</chroot></security>
</icecast>
EOF

# The default Ubuntu icecast2 package disables startup via /etc/default/icecast2
sudo sed -i 's/^ENABLE=.*/ENABLE=true/' /etc/default/icecast2 2>/dev/null || true
sudo systemctl enable icecast2
sudo systemctl restart icecast2
echo "  icecast2 running on :8000"

# ── 6. Install npm packages ───────────────────────────────────
echo ""
echo "▶ Installing npm packages…"
cd "$PLAYOUT_DIR"
npm install --production 2>&1 | grep -E 'added|warn|error' | tail -5
echo "  npm install complete"

# ── 7. Write systemd service ──────────────────────────────────
echo ""
echo "▶ Installing systemd service…"
sudo tee /etc/systemd/system/ether-playout.service > /dev/null << EOF
[Unit]
Description=Ether Cloud Playout Engine
After=network.target icecast2.service
Wants=icecast2.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=$PLAYOUT_DIR
ExecStart=/usr/bin/node $PLAYOUT_DIR/playout.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ether-playout
Environment=PORT=3500
Environment=ICECAST_URL=icecast://source:hackme@localhost:8000/live
Environment=CACHE_DIR=$PLAYOUT_DIR/cache
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ether-playout
sudo systemctl restart ether-playout

# Wait for service to start
sleep 3

# ── 8. Verify ─────────────────────────────────────────────────
echo ""
echo "▶ Verifying services…"

PLAYOUT_STATUS=$(sudo systemctl is-active ether-playout 2>/dev/null || echo "unknown")
ICECAST_STATUS=$(sudo systemctl is-active icecast2 2>/dev/null || echo "unknown")
echo "  ether-playout: $PLAYOUT_STATUS"
echo "  icecast2:      $ICECAST_STATUS"

# Hit the health endpoint
sleep 2
if curl -sf http://localhost:3500/health > /dev/null 2>&1; then
  echo "  API health check: OK"
else
  echo "  API health check: FAILED — check logs with: journalctl -u ether-playout -n 30"
fi

# Get public IP
PUBLIC_IP=$(curl -sf http://checkip.amazonaws.com 2>/dev/null || echo "44.244.52.207")

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║              Setup complete!                         ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Playout API:  http://$PUBLIC_IP:3500        "
echo "║  Stream URL:   http://$PUBLIC_IP:8000/live   "
echo "║  Status:       http://$PUBLIC_IP:3500/api/playout/status"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Open in Lightsail firewall (AWS console):           ║"
echo "║    Custom TCP 3500  — Playout API                    ║"
echo "║    Custom TCP 8000  — Icecast stream                 ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Useful commands:"
echo "  journalctl -u ether-playout -f      # follow logs"
echo "  curl http://localhost:3500/api/playout/status | python3 -m json.tool"
echo "  sudo systemctl restart ether-playout"
