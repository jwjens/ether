// audiod/listen.js — PARK LISTEN sender (2026-10-13, docs/park-listen-plan-2026-10-13.md).
//
// Jeff: "add the local audio feed so logged-in staff can hear what the park hears … It must not add load or risk to
// the air chain: if the feed fails, playout and the stream are untouched."
//
// What it does: while someone on the Park page is listening, ONE ffmpeg reads this station's listen port (the engine's
// copy of what the park speakers get — native/src/localout.rs ListenRing), encodes Opus and publishes it over RTSPS to
// the relay (MediaMTX on the stream server), which serves it to the phones over WebRTC. One copy leaves the machine
// however many staff listen.
//
// Why it cannot touch air: it is its own process reading its own port. The engine writes that port's ring with
// try_push only, and only while this process is connected; the Icecast encoder (stream.js) is a different process on a
// different port. If this ffmpeg dies, hangs or loses the internet, the speakers, playout and the stream carry on.
//
// A LEASE, not a switch: the server sends `start` when a listener opens and again every renewal; with no renewal the
// sender stops by itself (so a phone that vanished never leaves an encoder running). Every number that shapes the sound
// comes from the station's settings (bitrate, Opus frame length) — none is chosen here.

const cp = require("child_process");

let ffmpegBin = null;
try {
  ffmpegBin = require("ffmpeg-static");
  if (ffmpegBin && ffmpegBin.includes("app.asar") && !ffmpegBin.includes("app.asar.unpacked")) {
    ffmpegBin = ffmpegBin.replace("app.asar", "app.asar.unpacked");
  }
} catch { /* falls back to PATH 'ffmpeg' */ }

/** Opus accepts these frame lengths (ms). */
const OPUS_FRAMES = [2.5, 5, 10, 20, 40, 60];

/**
 * Validate a start request. Pure — pinned by listen.test.js.
 * @returns {{ok:true, cfg:object}|{ok:false, error:string}}
 */
function checkConfig(c) {
  const x = c || {};
  const url = String(x.url || "");
  if (!/^rtsps?:\/\/[^\s]+$/.test(url)) return { ok: false, error: "No relay address." };
  const which = Number(x.which);
  if (![1, 2, 3].includes(which)) return { ok: false, error: "Choose which output feeds the park speakers (Preferences → Park page → Listen)." };
  const bitrate = Number(x.bitrateKbps);
  if (!(bitrate >= 6 && bitrate <= 510)) return { ok: false, error: "Listen quality (kbps) must be 6–510." };
  const frameMs = Number(x.frameMs);
  if (!OPUS_FRAMES.includes(frameMs)) return { ok: false, error: `Listen frame length must be one of ${OPUS_FRAMES.join(", ")} ms.` };
  const leaseSec = Number(x.leaseSec);
  if (!(leaseSec >= 10 && leaseSec <= 600)) return { ok: false, error: "Bad lease." };
  return { ok: true, cfg: { url, which, bitrate, frameMs, leaseSec } };
}

/** The ffmpeg command line. Pure — pinned by listen.test.js. */
function ffmpegArgs(port, cfg) {
  return [
    "-hide_banner", "-loglevel", "warning", "-stats",
    // Raw programme-rate PCM from the engine; no probing, no input buffering.
    "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0",
    "-f", "f32le", "-ar", "44100", "-ac", "2", "-i", `tcp://127.0.0.1:${port}`,
    "-af", "aresample=48000",
    "-c:a", "libopus", "-b:a", `${cfg.bitrate}k`, "-frame_duration", String(cfg.frameMs), "-application", "lowdelay",
    "-f", "rtsp", "-rtsp_transport", "tcp", cfg.url,
  ];
}

class ListenSender {
  // A: the native addon (audioGetListenPort / audioSetListenSource / audioGetListenConnected). emit: status → broadcast.
  constructor(stationId, A, emit, timers = { setTimeout, clearTimeout }) {
    this.stationId = stationId; this.A = A; this.emit = emit; this.t = timers;
    this.armed = false; this.proc = null; this.cfg = null; this.lease = null; this.retry = null;
    this.state = "idle"; this.errorMsg = null; this.since = null; this.restarts = 0;
  }
  status() {
    let tap = false; try { tap = !!this.A.audioGetListenConnected(this.stationId); } catch {}
    return { stationId: this.stationId, state: this.state, errorMsg: this.errorMsg, since: this.since, restarts: this.restarts,
             tapConnected: tap, which: this.cfg ? this.cfg.which : null, bitrateKbps: this.cfg ? this.cfg.bitrate : null,
             frameMs: this.cfg ? this.cfg.frameMs : null };
  }
  _emit() { try { this.emit(this.status()); } catch {} }

  /** Start, or renew while running (a renewal with changed settings restarts the encoder). */
  start(config) {
    const v = checkConfig(config);
    if (!v.ok) { this.state = "error"; this.errorMsg = v.error; this._emit(); return { ok: false, error: v.error }; }
    let port = 0; try { port = this.A.audioGetListenPort(this.stationId); } catch {}
    if (!port) { this.state = "error"; this.errorMsg = "Audio engine not ready — no listen port."; this._emit(); return { ok: false, error: this.errorMsg }; }
    try { this.A.audioSetListenSource(this.stationId, v.cfg.which); } catch {}
    const changed = !this.cfg || ["url", "which", "bitrate", "frameMs"].some(k => this.cfg[k] !== v.cfg[k]);
    this.cfg = v.cfg; this.armed = true;
    this._renewLease();
    if (!this.proc || changed) this._spawn(port);
    return { ok: true };
  }
  stop(reason = "stopped") {
    this.armed = false;
    if (this.lease) { this.t.clearTimeout(this.lease); this.lease = null; }
    if (this.retry) { this.t.clearTimeout(this.retry); this.retry = null; }
    this._kill();
    this.state = "idle"; this.errorMsg = reason === "stopped" ? null : reason; this.since = null; this._emit();
    return { ok: true };
  }
  _renewLease() {
    if (this.lease) this.t.clearTimeout(this.lease);
    this.lease = this.t.setTimeout(() => { this.lease = null; this.stop("nobody listening (lease ended)"); }, this.cfg.leaseSec * 1000);
  }
  _spawn(port) {
    this._kill();
    this.state = "connecting"; this.errorMsg = null; this._emit();
    const p = cp.spawn(ffmpegBin || "ffmpeg", ffmpegArgs(port, this.cfg), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.proc = p;
    p.stderr.on("data", (d) => {
      for (const raw of d.toString().split(/[\r\n]+/)) {
        const line = raw.trim(); if (!line) continue;
        if (/size=\s*\d+\s*[kK]i?B/.test(line) && this.state !== "live") { this.state = "live"; this.since = Date.now(); this._emit(); }
        else if (/error|failed|refused|unauthorized|denied|timed out/i.test(line)) { this.errorMsg = line.slice(0, 200); }
      }
    });
    p.on("error", (e) => { if (this.proc === p) this.proc = null; this.state = "error"; this.errorMsg = e.message; this._emit(); });
    p.on("close", () => {
      if (this.proc === p) this.proc = null; else return;
      if (!this.armed) return;
      // Fell over while someone is listening: retry after a pause. Never a tight loop.
      this.restarts++; this.state = "error"; this._emit();
      this.retry = this.t.setTimeout(() => { this.retry = null; if (this.armed) { let pt = 0; try { pt = this.A.audioGetListenPort(this.stationId); } catch {} if (pt) this._spawn(pt); } }, 3000);
    });
  }
  _kill() { if (this.proc) { const p = this.proc; this.proc = null; try { p.kill("SIGTERM"); } catch {} } }
}

module.exports = { ListenSender, checkConfig, ffmpegArgs, OPUS_FRAMES };
