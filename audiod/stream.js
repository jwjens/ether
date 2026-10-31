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

// THE STATION'S OWN PORT (dead-controls item 20; Jeff 2026-10-31: "Remove the hard-coded port 8000 everywhere; use each
// station's own setting"). A port written in the address ("stream.example.com:8443", or "http://host:8443/") wins;
// otherwise the station's port setting (stations.icecast_port). No port anywhere = null — the stream is refused with
// the reason, never sent to a guessed port. Shared by main (in-process path, Stream Manager, metadata).
function serverAndPort(raw, stationPort = null) {
  let s = String(raw || "").trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  const m = s.match(/^(.*):(\d{1,5})$/);
  const own = Number(stationPort);
  return m ? { host: m[1], port: parseInt(m[2], 10) } : { host: s, port: Number.isInteger(own) && own > 0 && own < 65536 ? own : null };
}

// THE REAL REASON AFTER REPEATED FAILURES (Jeff, 2026-10-31, HalloVeen check): the cooldown message used to replace the
// reason the server gave (e.g. "Forbidden (403)" when another computer holds the mount) with a generic "check URL and
// credentials". The message now keeps that reason and says what Ether does next. Shared by the in-process path (main.js).
function repeatedFailureMsg(reason) {
  const why = reason === "Forbidden (403)" ? "The server refused the stream (403): another computer may be sending to this mount, or the password is wrong"
    : reason === "Auth failed (401)" ? "The server refused the password (401)"
    : reason ? reason
    : "The stream could not connect";
  return `${why}. Ether tries again every 30 seconds; press Stop to end it.`;
}

// THE SAVED PASSWORD ON EVERY (RE)CONNECT (Jeff, 2026-10-13, C; docs/air-machine-stalls-plan-2026-10-13.md §6). A running
// encoder used to keep the password it started with, so after the server's password changed the next automatic
// reconnect used the OLD one and the station dropped. Every spawn now re-reads the station's saved password: change it in
// Station settings first (the running stream is untouched), then on the server — the next reconnect uses the new one.
// A missing/empty saved password keeps the one the stream started with (never a guessed value).
function withPassword(url, pw) {
  const p = pw == null ? "" : String(pw).trim();
  if (!p) return url;
  return String(url).replace(/^(icecast:\/\/source:)[^@]*(@)/, (_m, a, b) => a + p + b);
}

class StreamSupervisor {
  // getPort: () => program-bus TCP port for this station.  emit: (statusObj) => broadcast.
  // readPassword: () => the station's saved password now (or null) — re-read on every spawn.
  constructor(stationId, getPort, emit, readPassword = () => null) {
    this.stationId = stationId;
    this.getPort = getPort;
    this.emit = emit;
    this.readPassword = readPassword;
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
    const sp = serverAndPort(server, config.icecastPort);
    if (!sp.port) { this.statusState = "error"; this.errorMsg = "No port set for this station. Set it in Stream Manager."; this._emit(); return { ok: false, error: this.errorMsg }; }
    this.url = `icecast://source:${pw}@${sp.host}:${sp.port}${mount}`;
    this.armed = true; this.failureCount = 0;
    this._spawn(port);
    return { ok: true, server, mount };
  }

  _spawn(port) {
    this._kill();
    let saved = null;
    try { saved = this.readPassword(); } catch { saved = null; }
    const next = withPassword(this.url, saved);
    if (next !== this.url) { this.url = next; try { console.log(`[stream/${this.stationId}] using the station's saved password (changed since the last connect)`); } catch {} }
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
        // Repeated rapid failures: surface the error but DON'T permanently disarm. Keep the supervisor
        // armed and retry on a long cooldown so a transient Icecast outage self-heals — the next
        // successful connect emits "live" (errorMsg=null), which clears the sticky banner. (Previously:
        // armed=false + return → no recovery event could ever fire, so the banner stuck forever.)
        this.failureCount = 0; this.firstFailureTime = 0; this.statusState = "error";
        this.errorMsg = repeatedFailureMsg(this.errorMsg);
        this._emit();
        setTimeout(() => { if (this.armed) this._spawn(this.getPort()); }, 30000);
        return;
      }
      this.statusState = "connecting"; this._emit();
      setTimeout(() => { if (this.armed) this._spawn(this.getPort()); }, 500);
    });
  }

  _kill() { if (this.proc) { try { this.proc.kill("SIGTERM"); } catch {} this.proc = null; } }
  stop() { this.armed = false; this.failureCount = 0; this._kill(); this.statusState = "idle"; this.errorMsg = null; this.speed = null; this.bitrate = null; this._emit(); return { ok: true }; }
}

module.exports = { StreamSupervisor, withPassword, repeatedFailureMsg, serverAndPort };
