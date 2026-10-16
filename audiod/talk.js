// audiod/talk.js — PARK MIC: warm phone lines and the talk switch (2026-10-16; docs/park-mic-build-2026-10-16.md).
//
// THE STANDING RULE (Jeff, 2026-10-16): "the user is in charge of on and off. The system never assumes, never listens for
// talking, never ends a talk because of silence, and never auto-stops. Once green, it stays open until the user taps
// off, or a person presses STOP / the studio lock in Ether. Show green only when the line is truly open end to end, so
// the first word is always heard. If the connection drops, say so plainly … don't silently end it."
//
// WARM LINES: for every phone with its microphone on, the server sends `park:warm` (renewed while the phone is there)
// with that phone's own relay address. This daemon keeps ONE ffmpeg reading it (mono f32le 48 kHz on a pipe). A read
// that fails — the phone not there yet, or a drop — is tried again every RETRY_MS, quietly, for as long as the line is
// wanted. A muted phone sends only silence frames (tiny data). A line is OPEN when its audio is arriving — any audio,
// silence included: nothing here ever judges whether someone is talking.
//
// THE SWITCH: `park:talk on` names a Park mic and a warm line. From then on that line's samples go into the engine's port
// for that Park mic (native/src/micin.rs park_mic_port) — no new connection, so the first word goes straight through.
// It stays on until `off`: the user's tap, Ether's STOP, or the studio lock. NOTHING ELSE ENDS A TALK — no timer, no
// lease, no silence. A line that drops during a talk keeps the talk on; it is reported (`lineOpen: false`) so the phone
// can say "Disconnected — tap to reconnect", and it is retried.
//
// A warm line that is NOT in a talk lapses when its phone stops renewing (the page closed) — only cleanup of something
// that was never turned on for talking.
"use strict";
const cp = require("child_process");
const net = require("net");

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
/** A line's read that fails is tried again this often while the line is wanted. */
const RETRY_MS = 300;
/** A line is OPEN while audio (silence frames included) arrived within this long — a fact about the line, not a
 *  judgement about talking. A muted phone sends silence frames every 20 ms. */
const OPEN_WITHIN_MS = 600;

/** Validate a warm line. Pure — pinned by talk.test.js. */
function checkWarm(c) {
  const x = c || {};
  const warmId = String(x.warmId || "");
  if (!/^[0-9a-f]{8,64}$/.test(warmId)) return { ok: false, error: "Bad line id." };
  const url = String(x.url || "");
  if (!/^rtsps?:\/\/[^\s]+$/.test(url)) return { ok: false, error: "No relay address." };
  const leaseSec = Number(x.leaseSec);
  if (!(leaseSec >= 5 && leaseSec <= 600)) return { ok: false, error: "Bad lease." };
  return { ok: true, cfg: { warmId, url, leaseSec } };
}
/** Validate a talk switch. Pure. */
function checkTalk(c) {
  const x = c || {};
  const mic = Number(x.mic);
  if (!PARK_MICS.includes(mic)) return { ok: false, error: "No such Park mic." };
  const warmId = String(x.warmId || "");
  if (!/^[0-9a-f]{8,64}$/.test(warmId)) return { ok: false, error: "No phone line for this talk." };
  return { ok: true, cfg: { mic, warmId, talkId: String(x.talkId || ""), by: String(x.by || "").slice(0, 60) } };
}

/** The ffmpeg command line for a warm line: the phone's voice off the relay, onto stdout. Pure. */
function ffmpegArgs(url) {
  return [
    "-hide_banner", "-loglevel", "warning",
    // Least delay: no probing, no input buffering, no reorder wait.
    "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0",
    "-max_delay", "0", "-reorder_queue_size", "0",
    "-rtsp_transport", "tcp", "-i", url,
    // Exactly the engine's Park mic format, each packet the moment it is decoded.
    "-vn", "-af", `aresample=${PARK_MIC_RATE}`, "-ac", "1", "-flush_packets", "1", "-f", "f32le", "pipe:1",
  ];
}

class ParkTalk {
  // A: the native addon (audioGetParkMicPort). emit: per-mic status → broadcast. spawn/connect injectable for tests.
  constructor(stationId, A, emit, deps = {}) {
    this.stationId = stationId; this.A = A; this.emit = emit;
    this.t = deps.timers || { setTimeout, clearTimeout, now: Date.now };
    this.spawn = deps.spawn || ((args) => cp.spawn(ffmpegBin || "ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
    this.connect = deps.connect || ((port) => { const s = net.connect({ host: "127.0.0.1", port }); s.setNoDelay(true); return s; });
    this.lines = new Map();     // warmId → { cfg, proc, lease, retry, lastData }
    this.active = {};           // mic → { warmId, talkId, by, since, open }
    this.sockets = {};          // mic → engine port socket
    this.endedHow = {};
  }
  _inTalk(warmId) { return PARK_MICS.some(m => this.active[m] && this.active[m].warmId === warmId); }
  _open(warmId) { const l = this.lines.get(warmId); return !!(l && l.lastData && this.t.now() - l.lastData <= OPEN_WITHIN_MS); }

  // ── warm lines ──
  warm(config) {
    const v = checkWarm(config);
    if (!v.ok) return { ok: false, error: v.error };
    let l = this.lines.get(v.cfg.warmId);
    if (!l) { l = { cfg: v.cfg, proc: null, lease: null, retry: null, lastData: 0 }; this.lines.set(v.cfg.warmId, l); this._read(v.cfg.warmId); }
    else if (l.cfg.url !== v.cfg.url) { l.cfg = v.cfg; this._kill(l); this._read(v.cfg.warmId); }
    else l.cfg = v.cfg;
    this._lease(v.cfg.warmId);
    return { ok: true, lines: this.lines.size };
  }
  _lease(warmId) {
    const l = this.lines.get(warmId); if (!l) return;
    if (l.lease) this.t.clearTimeout(l.lease);
    // Cleanup of a line nobody is talking on. A line in a talk is never dropped by a timer (the standing rule).
    l.lease = this.t.setTimeout(() => { l.lease = null; if (this._inTalk(warmId)) this._lease(warmId); else this.unwarm(warmId); }, l.cfg.leaseSec * 1000);
  }
  /** The phone turned its microphone off (or the page closed). Never ends a talk: a person ends a talk. */
  unwarm(warmId) {
    const l = this.lines.get(warmId); if (!l) return { ok: true, was: false };
    if (this._inTalk(warmId)) return { ok: true, was: false, kept: "in a talk" };
    this.lines.delete(warmId);
    if (l.lease) this.t.clearTimeout(l.lease);
    if (l.retry) this.t.clearTimeout(l.retry);
    this._kill(l);
    return { ok: true, was: true };
  }
  _read(warmId) {
    const l = this.lines.get(warmId); if (!l) return;
    const p = this.spawn(ffmpegArgs(l.cfg.url));
    l.proc = p;
    p.stdout && p.stdout.on("data", (d) => this._data(warmId, d));
    p.stderr && p.stderr.on("data", () => {});
    const again = () => {
      if (l.proc !== p) return;
      l.proc = null; l.lastData = 0;
      for (const m of PARK_MICS) if (this.active[m] && this.active[m].warmId === warmId && this.active[m].open) { this.active[m].open = false; this._emit(m, "on"); }
      // KEEP TRYING (Jeff: "receiver keeps retrying instead of giving up"), quietly, while the line is wanted.
      if (this.lines.get(warmId) === l) l.retry = this.t.setTimeout(() => { l.retry = null; if (this.lines.get(warmId) === l) this._read(warmId); }, RETRY_MS);
    };
    p.on("close", again);
    p.on("error", again);
  }
  _data(warmId, chunk) {
    const l = this.lines.get(warmId); if (l) l.lastData = this.t.now();
    for (const m of PARK_MICS) {
      const a = this.active[m];
      if (!a || a.warmId !== warmId) continue;
      const s = this._socket(m);
      if (s) { try { s.write(chunk); } catch { /* reconnects on its own */ } }
      if (!a.open) { a.open = true; this._emit(m, "on"); }
    }
  }
  _socket(m) {
    const cur = this.sockets[m];
    if (cur && !cur.destroyed) return cur;
    let port = 0; try { port = this.A.audioGetParkMicPort(this.stationId, m); } catch {}
    if (!port) return null;
    const s = this.connect(port);
    s.on("error", () => {}); s.on("close", () => { if (this.sockets[m] === s) delete this.sockets[m]; });
    this.sockets[m] = s;
    return s;
  }
  _kill(l) { if (l.proc) { const p = l.proc; l.proc = null; try { p.kill("SIGTERM"); } catch {} } }

  // ── the switch ──
  /** Turn a talk ON: this line's audio into Park mic `mic`. Stays on until off(). Repeating it changes nothing. */
  on(config) {
    const v = checkTalk(config);
    if (!v.ok) return { ok: false, error: v.error };
    const m = v.cfg.mic, cur = this.active[m];
    if (cur && cur.talkId === v.cfg.talkId && cur.warmId === v.cfg.warmId) return { ok: true, open: cur.open };
    if (cur) this.off(m, "replaced");
    this.active[m] = { warmId: v.cfg.warmId, talkId: v.cfg.talkId, by: v.cfg.by, since: this.t.now(), open: this._open(v.cfg.warmId) };
    this._socket(m);
    this._emit(m, "on");
    return { ok: true, open: this.active[m].open };
  }
  /** Turn a talk OFF. `how`: "released" (the user tapped off) | "ether" (STOP in Ether) | "locked" | "replaced" | "shutdown". */
  off(mic, how = "released") {
    const a = this.active[mic]; if (!a) return { ok: true, was: false };
    delete this.active[mic];
    this.endedHow[mic] = how;
    this._emit(mic, "idle", a);
    return { ok: true, was: true };
  }
  status() {
    return PARK_MICS.map(m => {
      const a = this.active[m];
      return { stationId: this.stationId, mic: m, state: a ? "on" : "idle", lineOpen: !!(a && a.open), by: a ? a.by : null,
               talkId: a ? a.talkId : null, since: a ? a.since : null, lines: this.lines.size };
    });
  }
  _emit(m, state, was = null) {
    const a = this.active[m] || was;
    try {
      // `receiving` = the line is OPEN end to end (audio arriving from the phone into this Park mic) — what the phone
      // shows green on. Never a judgement about talking.
      this.emit({ stationId: this.stationId, mic: m, state, by: a ? a.by : null, talkId: a ? a.talkId : null, since: a ? a.since : null,
                  receiving: state === "on" && !!(a && a.open), lineOpen: state === "on" && !!(a && a.open),
                  endedHow: state === "idle" ? (this.endedHow[m] || "released") : null, lines: this.lines.size });
    } catch {}
  }
  shutdown() {
    for (const m of PARK_MICS) this.off(m, "shutdown");
    for (const id of [...this.lines.keys()]) this.unwarm(id);
    for (const s of Object.values(this.sockets)) { try { s.destroy(); } catch {} }
  }
}

module.exports = { ParkTalk, checkWarm, checkTalk, ffmpegArgs, PARK_MICS, PARK_MIC_RATE, RETRY_MS, OPEN_WITHIN_MS };
