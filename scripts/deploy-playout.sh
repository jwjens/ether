#!/usr/bin/env bash
# deploy-playout.sh — Deploy Ether Cloud Playout Engine to Lightsail
#
# Usage:
#   ./scripts/deploy-playout.sh [--key ~/.ssh/your-key.pem]
#
# Requirements on your local machine:
#   - SSH access to 44.244.52.207 (default key or --key flag)
#   - rsync (included in Git Bash / WSL / macOS)
#
# What this does:
#   1. Installs Node.js 20 LTS, ffmpeg, icecast2 on the server
#   2. Copies the playout service files to /opt/ether-playout
#   3. Installs npm dependencies
#   4. Deploys icecast config
#   5. Installs + starts the systemd service
#   6. Opens firewall ports 3500 (API) and 8000 (Icecast stream)

set -euo pipefail

SERVER="44.244.52.207"
SSH_USER="ubuntu"
SSH_KEY=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$SCRIPT_DIR/playout-service"

# ── Parse args ────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --key) SSH_KEY="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=15"
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
fi

SSH="ssh $SSH_OPTS $SSH_USER@$SERVER"
SCP="scp $SSH_OPTS"
RSYNC="rsync -avz --progress -e \"ssh $SSH_OPTS\""

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║        Ether Cloud Playout — Deployment              ║"
echo "║        Server: $SERVER                        ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── 1. Test SSH ───────────────────────────────────────────────
echo "▶ Testing SSH connection…"
$SSH "echo '  SSH OK — hostname: $(hostname)'"

# ── 2. Install system dependencies ────────────────────────────
echo ""
echo "▶ Installing Node.js 20 LTS, ffmpeg, icecast2…"
$SSH "bash -s" << 'ENDSSH'
set -e

# Node.js 20 LTS via NodeSource
if ! command -v node &>/dev/null || [[ "$(node -e 'console.log(parseInt(process.versions.node))')" -lt 20 ]]; then
  echo "  Installing Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>&1 | tail -5
  sudo apt-get install -y nodejs 2>&1 | tail -5
fi
echo "  Node: $(node --version), npm: $(npm --version)"

# ffmpeg
if ! command -v ffmpeg &>/dev/null; then
  echo "  Installing ffmpeg…"
  sudo apt-get install -y ffmpeg 2>&1 | tail -3
fi
echo "  ffmpeg: $(ffmpeg -version 2>&1 | head -1)"

# icecast2 (non-interactive)
if ! command -v icecast2 &>/dev/null; then
  echo "  Installing icecast2…"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y icecast2 2>&1 | tail -5
fi
echo "  icecast2 installed"
ENDSSH

# ── 3. Deploy playout service files ───────────────────────────
echo ""
echo "▶ Uploading playout service…"
$SSH "sudo mkdir -p /opt/ether-playout && sudo chown ubuntu:ubuntu /opt/ether-playout"

# Copy service files (exclude systemd/icecast configs — handled separately)
rsync -avz --progress \
  -e "ssh $SSH_OPTS" \
  --exclude='*.service' \
  --exclude='icecast.xml' \
  "$SERVICE_DIR/" \
  "$SSH_USER@$SERVER:/opt/ether-playout/"

# ── 4. Install npm dependencies ────────────────────────────────
echo ""
echo "▶ Installing npm dependencies…"
$SSH "cd /opt/ether-playout && npm install --production 2>&1 | tail -5"

# ── 5. Deploy icecast config ───────────────────────────────────
echo ""
echo "▶ Configuring icecast2…"
$SCP "$SERVICE_DIR/icecast.xml" "$SSH_USER@$SERVER:/tmp/icecast.xml"
$SSH "sudo cp /tmp/icecast.xml /etc/icecast2/icecast.xml && sudo systemctl enable icecast2 && sudo systemctl restart icecast2"
echo "  Icecast2 restarted"

# ── 6. Install systemd service ─────────────────────────────────
echo ""
echo "▶ Installing systemd service…"
$SCP "$SERVICE_DIR/ether-playout.service" "$SSH_USER@$SERVER:/tmp/ether-playout.service"
$SSH "bash -s" << 'ENDSSH'
set -e
sudo cp /tmp/ether-playout.service /etc/systemd/system/ether-playout.service
sudo systemctl daemon-reload
sudo systemctl enable ether-playout
sudo systemctl restart ether-playout
sleep 2
echo "  Service status: $(sudo systemctl is-active ether-playout)"
ENDSSH

# ── 7. Open firewall ports ─────────────────────────────────────
echo ""
echo "▶ Configuring firewall…"
$SSH "bash -s" << 'ENDSSH'
# Allow Icecast (8000) and Playout API (3500) through UFW if it's running
if sudo ufw status 2>/dev/null | grep -q 'Status: active'; then
  sudo ufw allow 8000/tcp comment 'Icecast stream' 2>/dev/null || true
  sudo ufw allow 3500/tcp comment 'Ether playout API' 2>/dev/null || true
  echo "  UFW: ports 8000 + 3500 open"
else
  echo "  UFW inactive — ports open by default (configure Lightsail firewall in AWS console)"
fi
ENDSSH

# ── 8. Verify ─────────────────────────────────────────────────
echo ""
echo "▶ Verifying deployment…"
sleep 3
$SSH "curl -sf http://localhost:3500/api/playout/status | python3 -m json.tool 2>/dev/null || curl -sf http://localhost:3500/health"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║                 Deployment complete!                 ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Playout API:   http://$SERVER:3500      ║"
echo "║  Stream URL:    http://$SERVER:8000/live  ║"
echo "║  Status:        http://$SERVER:3500/api/playout/status ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  IMPORTANT: Open these ports in the Lightsail        ║"
echo "║  firewall (AWS console → Lightsail → Networking):    ║"
echo "║    Custom TCP 3500 (Playout API)                     ║"
echo "║    Custom TCP 8000 (Icecast stream)                  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Next step: In Ether Settings → Broadcast → Cloud Playout,"
echo "click 'Sync R2 Config' then 'Sync Schedule' to push"
echo "your library and schedule to the cloud server."
echo ""
