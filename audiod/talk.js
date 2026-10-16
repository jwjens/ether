// audiod/talk.js — PARK MIC receiver (Hold to talk, 2026-10-16; docs/park-mic-build-2026-10-16.md).
//
// Jeff: "2 Park mic input sources (Park Mic 1, Park Mic 2), listed under Mic with the other inputs. The user puts each on
// any fader; that fader's existing settings (MAIN/AUX, ON, stream) decide where it's heard."
//
// What it does: while a logged-in staff member holds HOLD TO TALK on the Park page, ONE ffmpeg reads that Park mic's
// voice off the relay (MediaMTX on the stream server — the phone publishes it there over WebRTC) over RTSPS, decodes
// it to mono f32le at 48 kHz and writes it into the engine's Park mic port (native/src/micin.rs park_mic_port). From
// there the voice is the fader's mic input, like any other: fader, ON, MAIN/AUX, To stream, DUCKS, the rack's limiter.
//
// Why it cannot touch air when it fails: it is its own process writing its own port. The engine reads that port on its
// own thread into the fader's ring; the mixer only ever try-pops the ring. If this ffmpeg dies, hangs or loses the
// internet, the fader goes silent and the programme carries on.
//
// LIMITS, enforced HERE as well as on the server (a stuck button or a dropped phone cannot hold the park open):
//   · the longest talk (the station's setting, seconds) — the receiver stops at it, whatever the server says;
//   · a lease — no renewal within `leaseSec` and it stops by itself.
// Every number comes from the station's settings or the server's command — none is chosen here.

const cp = require("child_process");

let ffmpegBin = null;
try {
  ffmpegBin = require("ffmpeg-static");
  if (ffmpegBin && ffmpegBin.includes("app.asar") && !ffmpegBin.includes("app.asar.unpacked")) {
    ffmpegBin = ffmpegBin.replace("app.asar", "app.asar.unpacked");
  }
} catch { /* falls back to PATH 'ffmpeg' */ }

/** The Park mics the engine has (native/src/micin.rs PARK_MIC_COUNT). */
const PARK_MICS = [1, 2];
/** The engine's Park mic rate (micin.rs PARK_MIC_RATE): mono f32le. */
const PARK_MIC_RATE = 48000;

/**
 * Validate a start request. Pure — pinned by talk.test.js.
 * @returns {{ok:true, cfg:object}|{ok:false, error:string}}
 */
function checkTalk(c) {
  const x = c || {};
  const mic = Number(x.mic);
  if (!PARK_MICS.includes(mic)) return { ok: false, error: "No such Park mic." };
  const url = String(x.url || "");
  if (!/^rtsps?:\/\/[^\s]+$/.test(url)) return { ok: false, error: "No relay address." };
  const limitSec = Number(x.limitSec);
  if (!(limitSec >= 1 && limitSec <= 600)) return { ok: false, error: "Set the longest talk (Ether → Preferences → Park page — Hold to talk)." };
  const leaseSec = Number(x.leaseSec);
  if (!(leaseSec >= 5 && leaseSec <= 600)) return { ok: false, error: "Bad lease." };
  return { ok: true, cfg: { mic, url, limitSec, leaseSec, talkId: String(x.talkId || ""), by: String(x.by || "").slice(0, 60) } };
}

/** The ffmpeg command line. Pure — pinned by talk.test.js. */
function ffmpegArgs(port, cfg) {
  return [
    "-hide_banner", "-loglevel", "warning", "-stats",
    // The voice off the relay: no probing, no input buffering (least delay, as Listen).
    // LEAST DELAY (Jeff, 2026-10-16: "cut everything we can to shorten delay"): no reorder wait, no demuxer delay.
    "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0",
    "-max_delay", "0", "-reorder_queue_size", "0",
    "-rtsp_transport", "tcp", "-i", cfg.url,
    // Exactly the engine's Park mic format: mono, 48 kHz, f32le, into its port — each packet sent the moment it is
    // decoded (-flush_packets 1). Without it ffmpeg held up to 256 ms and sent it in one lump (measured 2026-10-16).
    "-vn", "-af", `aresample=${PARK_MIC_RATE}`, "-ac", "1", "-flush_packets", "1", "-f", "f32le", `tcp://127.0.0.1:${port}`,
  ];
}

class TalkReceiver {
  // A: the native addon (audioGetParkMicPort). emit: status → broadcast. One receiver per (station, Park mic).
  constructor(stationId, mic, A, emit, timers = { setTimeout, clearTimeout, now: Date.now }) {
    this.stationId = stationId; this.mic = mic; this.A = A; this.emit = emit; this.t = timers;
    this.proc = null; this.cfg = null; this.lease = null; this.limit = null;
    this.state = "idle"; this.errorMsg = null; this.since = null; this.receiving = false; this.endedHow = null;
  }
  status() {
    return { stationId: this.stationId, mic: this.mic, state: this.state, errorMsg: this.errorMsg, since: this.since,
             receiving: this.receiving, by: this.cfg ? this.cfg.by : null, talkId: this.cfg ? this.cfg.talkId : null,
             limitSec: this.cfg ? this.cfg.limitSec : null, endedHow: this.endedHow };
  }
  _emit() { try { this.emit(this.status()); } catch {} }

  /** Start a talk, or renew the one running (same talkId). A new talkId replaces the running talk. */
  start(config) {
    const v = checkTalk(config);
    if (!v.ok) { this.state = "error"; this.errorMsg = v.error; this._emit(); return { ok: false, error: v.error }; }
    if (v.cfg.mic !== this.mic) return { ok: false, error: "wrong Park mic" };
    let port = 0; try { port = this.A.audioGetParkMicPort(this.stationId, this.mic); } catch {}
    if (!port) { this.state = "error"; this.errorMsg = "Audio engine not ready — no Park mic port."; this._emit(); return { ok: false, error: this.errorMsg }; }
    const renewal = this.proc && this.cfg && this.cfg.talkId === v.cfg.talkId && this.cfg.url === v.cfg.url;
    if (!renewal) {
      this._kill();
      this.cfg = v.cfg; this.since = this.t.now(); this.endedHow = null; this.receiving = false;
      if (this.limit) this.t.clearTimeout(this.limit);
      // THE LONGEST TALK, enforced by the station itself.
      this.limit = this.t.setTimeout(() => { this.limit = null; this.stop("limit"); }, this.cfg.limitSec * 1000);
      this._spawn(port);
    }
    this._renewLease();
    return { ok: true };
  }
  /** End the talk. `how`: "released" (the page let go) | "limit" | "lease" | "locked" | "ether" (Stop in Ether) | … */
  stop(how = "released") {
    const was = this.state !== "idle";
    if (this.lease) { this.t.clearTimeout(this.lease); this.lease = null; }
    if (this.limit) { this.t.clearTimeout(this.limit); this.limit = null; }
    this._kill();
    this.receiving = false;
    if (was) { this.endedHow = how; this.state = "idle"; this.errorMsg = null; this._emit(); }
    return { ok: true, was };
  }
  _renewLease() {
    if (this.lease) this.t.clearTimeout(this.lease);
    this.lease = this.t.setTimeout(() => { this.lease = null; this.stop("lease"); }, this.cfg.leaseSec * 1000);
  }
  _spawn(port) {
    this.state = "connecting"; this.errorMsg = null; this._emit();
    const p = cp.spawn(ffmpegBin || "ffmpeg", ffmpegArgs(port, this.cfg), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.proc = p;
    p.stderr.on("data", (d) => {
      for (const raw of d.toString().split(/[\r\n]+/)) {
        const line = raw.trim(); if (!line) continue;
        if (/size=\s*\d+\s*[kK]i?B/.test(line) && !this.receiving) { this.receiving = true; this.state = "receiving"; this._emit(); }
        else if (/error|failed|refused|unauthorized|denied|timed out|not found/i.test(line)) { this.errorMsg = line.slice(0, 200); }
      }
    });
    p.on("error", (e) => { if (this.proc === p) this.proc = null; this.state = "error"; this.errorMsg = e.message; this._emit(); });
    p.on("close", () => {
      if (this.proc !== p) return;
      this.proc = null;
      // The phone stopped publishing (released) or the relay dropped it. A talk is short: no retry loop — the page
      // presses again. Say how it ended.
      if (this.state !== "idle") this.stop(this.errorMsg && !this.receiving ? "no-audio" : "released");
    });
  }
  _kill() { if (this.proc) { const p = this.proc; this.proc = null; try { p.kill("SIGTERM"); } catch {} } }
}

module.exports = { TalkReceiver, checkTalk, ffmpegArgs, PARK_MICS, PARK_MIC_RATE };
