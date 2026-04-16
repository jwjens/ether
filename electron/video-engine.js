// electron/video-engine.js
//
// Phase 0 video engine — Electron-native.
//
// The renderer captures sources (desktopCapturer + getUserMedia), composites
// them onto a <canvas>, taps the canvas via captureStream(), and feeds it to
// a MediaRecorder. The MediaRecorder produces WebM chunks. The renderer
// sends those chunks here over IPC, and we pipe them into one or more
// ffmpeg subprocesses that re-encode/mux to RTMP and/or MP4.
//
// Why this architecture
//   - capture is a solved problem in browser APIs (cross-platform, no native code)
//   - MediaRecorder gives us a hardware-accelerated VP9 encode for free
//   - ffmpeg is only used at the OUTPUT stage, where we need protocols
//     (RTMP, MP4 muxing) that browsers don't speak
//
// Lifecycle
//   1. Renderer enables a "session" with start-stream or start-recording
//   2. Each call spawns its own ffmpeg subprocess with stdin piped
//   3. Renderer pushes WebM chunks via "video:chunk"; we write to all open
//      subprocess stdins
//   4. stop-stream/stop-recording closes that subprocess (graceful EOF)

const { spawn, execFile } = require("child_process");

let ffmpegBin = null;
function setFfmpegBin(bin) { ffmpegBin = bin; }

// One subprocess per active sink. Keyed by id ("stream" or "record").
const sinks = new Map(); // id -> { proc, label, startedAt, framesWritten }

// Cached encoder list, populated lazily on first call to listEncoders.
let cachedEncoders = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function probeEncoders() {
  return new Promise((resolve) => {
    if (!ffmpegBin) return resolve([]);
    execFile(ffmpegBin, ["-hide_banner", "-encoders"], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const candidates = [
        "libx264", "libx265",
        "h264_nvenc", "hevc_nvenc",
        "h264_qsv",   "hevc_qsv",
        "h264_amf",   "hevc_amf",
        "h264_videotoolbox", "hevc_videotoolbox",
      ];
      const found = [];
      for (const line of String(stdout).split("\n")) {
        const t = line.trim();
        if (!t.startsWith("V")) continue;
        const parts = t.split(/\s+/);
        if (parts.length < 2) continue;
        const name = parts[1];
        if (candidates.includes(name)) found.push(name);
      }
      console.log("[video] ffmpeg encoders detected:", found);
      resolve(found);
    });
  });
}

// Pick the right ffmpeg `-c:v` based on user preference + availability.
// `codec` is "h264/auto", "h264/nvenc", "h265/software", or just "h264".
function resolveEncoder(codec, available) {
  const raw = String(codec || "h264").toLowerCase();
  const [family = "h264", hw = "auto"] = raw.split("/");
  const prefix = family === "h265" || family === "hevc" ? "hevc" : "h264";
  const order = hw === "software" ? []
              : hw === "auto"     ? ["nvenc", "qsv", "amf", "videotoolbox"]
              : [hw];
  for (const h of order) {
    const name = `${prefix}_${h}`;
    if (available.includes(name)) return name;
  }
  return prefix === "hevc" ? "libx265" : "libx264";
}

function presetFor(encoder) {
  if (encoder.endsWith("_nvenc")) return "p4";
  if (encoder.endsWith("_qsv"))   return "veryfast";
  if (encoder.endsWith("_amf"))   return "balanced";
  if (encoder.endsWith("_videotoolbox")) return null;
  return "veryfast";
}

function joinRtmp(url, key) {
  if (!key) return url;
  return url.endsWith("/") ? url + key : url + "/" + key;
}

function redactKey(url, key) {
  if (!key) return url;
  return url.replace(key, "****");
}

// Build ffmpeg arg list for an RTMP destination.
function rtmpArgs({ url, key, fps, bitrate_kbps, keyframe_interval, codec }, encoders) {
  const enc = resolveEncoder(codec, encoders);
  const preset = presetFor(enc);
  const fullUrl = joinRtmp(url, key);
  const gop = String((fps || 30) * (keyframe_interval || 2));
  const br  = `${bitrate_kbps || 4500}k`;
  const buf = `${(bitrate_kbps || 4500) * 2}k`;

  const args = [
    "-hide_banner", "-loglevel", "warning",
    // Input — WebM/MKV from stdin (MediaRecorder output)
    "-i", "pipe:0",
    // Video output
    "-c:v", enc,
  ];
  if (preset) { args.push("-preset", preset); }
  if (enc.startsWith("lib")) {
    args.push("-tune", "zerolatency", "-profile:v", "main");
  }
  args.push(
    "-pix_fmt", "yuv420p",
    "-b:v", br, "-maxrate", br, "-bufsize", buf,
    "-g", gop, "-keyint_min", gop,
    // Audio output (MediaRecorder may give us Opus or none; AAC for RTMP)
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-f", "flv", fullUrl,
  );
  return { args, encoder: enc, redactedUrl: redactKey(fullUrl, key) };
}

// Build ffmpeg arg list for MP4 file recording.
function mp4Args({ filePath, fps, bitrate_kbps, keyframe_interval, codec }, encoders) {
  const enc = resolveEncoder(codec, encoders);
  const preset = presetFor(enc);
  const gop = String((fps || 30) * (keyframe_interval || 2));
  const br  = `${bitrate_kbps || 6000}k`;

  const args = [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-i", "pipe:0",
    "-c:v", enc,
  ];
  if (preset) { args.push("-preset", preset); }
  args.push(
    "-pix_fmt", "yuv420p",
    "-b:v", br, "-g", gop,
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    filePath,
  );
  return { args, encoder: enc };
}

// ── Sink lifecycle ──────────────────────────────────────────────────────────

function spawnSink(id, label, args) {
  if (!ffmpegBin) throw new Error("ffmpeg-static not available");
  if (sinks.has(id)) {
    console.warn(`[video] sink "${id}" already running, stopping previous`);
    stopSink(id);
  }
  const proc = spawn(ffmpegBin, args, {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  proc.stderr.on("data", (chunk) => {
    // Echo ffmpeg's diagnostics to console so users see encoder errors
    process.stdout.write(`[video/${id}] ${chunk.toString()}`);
  });
  proc.on("error", (e) => {
    console.error(`[video/${id}] ffmpeg spawn error:`, e);
    sinks.delete(id);
  });
  proc.on("exit", (code, sig) => {
    console.log(`[video/${id}] ffmpeg exited code=${code} signal=${sig}`);
    sinks.delete(id);
  });
  proc.stdin.on("error", (e) => {
    // EPIPE happens when ffmpeg exits before we close stdin — don't crash
    if (e.code !== "EPIPE") console.error(`[video/${id}] stdin error:`, e);
  });
  sinks.set(id, { proc, label, startedAt: Date.now(), framesWritten: 0 });
  console.log(`[video] sink "${id}" started: ${label}`);
}

function stopSink(id) {
  const s = sinks.get(id);
  if (!s) return false;
  try { s.proc.stdin.end(); } catch {}
  // Give ffmpeg up to 3s to flush trailers (mp4 moov, RTMP deleteStream)
  const killTimer = setTimeout(() => {
    try { s.proc.kill(); } catch {}
  }, 3000);
  s.proc.once("exit", () => clearTimeout(killTimer));
  sinks.delete(id);
  return true;
}

function pushChunk(uint8) {
  if (!sinks.size) return;
  // Convert from ArrayBuffer/Uint8Array to Node Buffer
  const buf = Buffer.from(uint8.buffer || uint8, uint8.byteOffset || 0, uint8.byteLength);
  for (const s of sinks.values()) {
    try {
      s.proc.stdin.write(buf);
      s.framesWritten++;
    } catch (e) {
      // EPIPE / write after end — sink is dead, will be cleaned in 'exit'
    }
  }
}

function getStatus() {
  const out = {
    streaming: sinks.has("stream"),
    recording: sinks.has("record"),
    sinks: [],
  };
  for (const [id, s] of sinks.entries()) {
    out.sinks.push({
      id, label: s.label,
      uptimeMs: Date.now() - s.startedAt,
      framesWritten: s.framesWritten,
    });
  }
  return out;
}

// ── IPC registration ────────────────────────────────────────────────────────

function installVideoEngine(ipcMain, opts = {}) {
  if (opts.ffmpegBin) setFfmpegBin(opts.ffmpegBin);
  console.log("[video] installVideoEngine", { ffmpegBin });

  ipcMain.handle("video:list-encoders", async () => {
    if (cachedEncoders) return cachedEncoders;
    cachedEncoders = await probeEncoders();
    return cachedEncoders;
  });

  // Multi-destination RTMP: each call gets a unique sinkId ("stream:0", "stream:1", …).
  // pushChunk() already broadcasts to ALL open sinks, so a single MediaRecorder feeds
  // every destination simultaneously.
  ipcMain.handle("video:start-stream", async (_evt, dest) => {
    // dest = { url, key, label, fps, bitrate_kbps, keyframe_interval, codec, sinkId? }
    if (!ffmpegBin) throw new Error("ffmpeg-static not available");
    if (cachedEncoders === null) cachedEncoders = await probeEncoders();
    const sinkId = dest.sinkId || "stream";
    const { args, encoder, redactedUrl } = rtmpArgs(dest, cachedEncoders);
    spawnSink(sinkId, `RTMP → ${redactedUrl}`, args);
    return { encoder, url: redactedUrl, sinkId };
  });

  // Stop a single stream sink or ALL stream:* sinks if no sinkId given.
  ipcMain.handle("video:stop-stream", async (_evt, sinkId) => {
    if (sinkId) return stopSink(sinkId);
    // Stop every sink whose id starts with "stream"
    let stopped = 0;
    for (const id of [...sinks.keys()]) {
      if (id === "stream" || id.startsWith("stream:")) {
        stopSink(id);
        stopped++;
      }
    }
    return stopped > 0;
  });

  ipcMain.handle("video:start-recording", async (_evt, opts) => {
    // opts = { filePath, fps, bitrate_kbps, keyframe_interval, codec }
    if (!ffmpegBin) throw new Error("ffmpeg-static not available");
    if (cachedEncoders === null) cachedEncoders = await probeEncoders();
    const { args, encoder } = mp4Args(opts, cachedEncoders);
    spawnSink("record", `MP4 → ${opts.filePath}`, args);
    return { encoder, filePath: opts.filePath };
  });

  ipcMain.handle("video:stop-recording", async () => {
    return stopSink("record");
  });

  ipcMain.handle("video:chunk", async (_evt, chunk) => {
    pushChunk(chunk);
    return true;
  });

  ipcMain.handle("video:get-status", async () => {
    return getStatus();
  });

  ipcMain.on("video:shutdown", () => {
    for (const id of [...sinks.keys()]) stopSink(id);
  });
}

module.exports = { installVideoEngine, setFfmpegBin };
