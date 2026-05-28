// audiod/stream.js — daemon-side Icecast streamer (Item 10, Phase 2 Step 5).
//
// Moves the ffmpeg → Icecast encoder into the daemon so the STREAM survives a UI/app restart
// (the daemon keeps mixing AND streaming while the app relaunches). Faithful port of
// electron/main.js _spawnStream + _parseStreamLine + the 3×/10s respawn/backoff; status is
// emitted via a callback (the daemon broadcasts it as a `stream` event → main → renderer).
// The encoder reads the daemon's OWN program-bus TCP port (proven by
// scripts/spike-ffmpeg-from-programbus.js). The Rust StartStream is a stub, so this external
// ffmpeg is the real encoder.

const cp = require("child_process");

// ffmpeg-static, with the packaged asar-unpacked fixup (same as main.js).
let ffmpegBin = null;
try {
  ffmpegBin = require("ffmpeg-static");
  if (ffmpegBin && ffmpegBin.includes("app.asar") && !ffmpegBin.includes("app.asar.unpacked")) {
    ffmpegBin = ffmpegBin.replace("app.asar", "app.asar.unpacked");
  }
} catch { /* falls back to PATH 'ffmpeg' */ }

// Port of main.js _parseStreamLine — classify an ffmpeg stderr line.
function parseLine(line) {
  const speedM = line.match(/speed=\s*([\d.]+)x/);
  const bitrateM = line.match(/bitrate=\s*([\d.]+)kbits\/s/);
  return {
    speed: speedM ? parseFloat(speedM[1]) : null,
    bitrate: bitrateM ? parseFloat(bitrateM[1]) : null,
    isProgress: !!(speedM || bitrateM),
    isLive: /frame=\s*[1-9]\d*\s/.test(line) || /size=\s*[1-9]\d*kB/i.test(line),
    errorMsg: /Connection refused/i.test(line) ? "Connection refused"
      : /401|Unauthorized/i.test(line) ? "Auth failed (401)"
      : /403|Forbidden/i.test(line) ? "Forbidden (403)"
      : /Connection timed out/i.test(line) ? "Connection timed out"
      : /Failed to connect/i.test(line) ? "Failed to connect"
      : null,
  };
}

class StreamSupervisor {
  // getPort: () => program-bus TCP port for this station.  emit: (statusObj) => broadcast.
  constructor(stationId, getPort, emit) {
    this.stationId = stationId;
    this.getPort = getPort;
    this.emit = emit;
    this.armed = false; this.proc = null;
    this.failureCount = 0; this.firstFailureTime = 0;
    this.statusState = "idle"; this.speed = null; this.bitrate = null; this.startTime = null; this.errorMsg = null; this.url = "";
    this._sampleRate = 44100; this._bitrate = 128;
  }

  status() {
    return {
      stationId: this.stationId, state: this.statusState, speed: this.speed, bitrate: this.bitrate,
      uptimeSec: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : null,
      errorMsg: this.errorMsg, url: this.url,
    };
  }
  _emit() { try { this.emit(this.status()); } catch {} }

  start(config = {}) {
    const port = this.getPort();
    if (!port) { this.statusState = "error"; this.errorMsg = "Audio engine not ready — no Program Bus port."; this._emit(); return { ok: false, error: this.errorMsg }; }
    const server = String(config.server || "").trim();
    if (!server) { this.statusState = "error"; this.errorMsg = "No Icecast server configured."; this._emit(); return { ok: false, error: this.errorMsg }; }
    const pw = String(config.password || "hackme").trim();
    const mount = String(config.mount || "/live").trim();
    this._sampleRate = config.sampleRate || 44100;
    this._bitrate = config.bitrate || 128;
    this.url = `icecast://source:${pw}@${server}:${config.icecastPort || 8000}${mount}`;
    this.armed = true; this.failureCount = 0;
    this._spawn(port);
    return { ok: true, server, mount };
  }

  _spawn(port) {
    this._kill();
    const args = [
      "-f", "f32le", "-ar", String(this._sampleRate), "-ac", "2",
      "-i", `tcp://127.0.0.1:${port}`,
      "-c:a", "libmp3lame", "-b:a", `${this._bitrate}k`,
      "-f", "mp3", "-content_type", "audio/mpeg",
      this.url,
    ];
    const bin = ffmpegBin || "ffmpeg";
    this.statusState = "connecting"; this.errorMsg = null; this.speed = null; this.bitrate = null; this._emit();
    this.proc = cp.spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    this.proc.stderr.on("data", (d) => {
      for (const raw of d.toString().split("\n")) {
        const line = raw.trim(); if (!line) continue;
        const p = parseLine(line);
        if (p.errorMsg) {
          this.errorMsg = p.errorMsg;
          if (this.statusState === "connecting") { this.statusState = "error"; this._emit(); }
          // while live, the close handler is authoritative — a sub-request error leaves it flowing
        } else if (p.isLive && this.statusState === "connecting") {
          this.statusState = "live"; this.startTime = Date.now(); this.errorMsg = null; this._emit();
        } else if (p.isProgress && this.statusState === "live") {
          if (p.speed !== null) this.speed = p.speed;
          if (p.bitrate !== null) this.bitrate = p.bitrate;
        }
      }
    });
    this.proc.on("error", (e) => { this.proc = null; this.statusState = "error"; this.errorMsg = e.message; this._emit(); });
    this.proc.on("close", () => {
      this.proc = null;
      if (!this.armed) { this.statusState = "idle"; this.speed = null; this.bitrate = null; this._emit(); return; }
      const now = Date.now();
      if (now - this.firstFailureTime > 10000) { this.failureCount = 0; this.firstFailureTime = now; }
      if (this.failureCount === 0) this.firstFailureTime = now;
      this.failureCount++;
      if (this.failureCount >= 3) {
        this.armed = false; this.failureCount = 0; this.statusState = "error";
        this.errorMsg = "Streaming failed after repeated ffmpeg restarts. Check Icecast server URL and credentials.";
        this._emit(); return;
      }
      this.statusState = "connecting"; this._emit();
      setTimeout(() => { if (this.armed) this._spawn(this.getPort()); }, 500);
    });
  }

  _kill() { if (this.proc) { try { this.proc.kill("SIGTERM"); } catch {} this.proc = null; } }
  stop() { this.armed = false; this.failureCount = 0; this._kill(); this.statusState = "idle"; this.speed = null; this.bitrate = null; this._emit(); return { ok: true }; }
}

module.exports = { StreamSupervisor };
