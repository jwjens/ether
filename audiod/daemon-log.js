// audiod/daemon-log.js — durable append log for the detached daemon (Item 10 observability).
//
// The daemon is spawned detached + stdio:"ignore" (so it outlives the app for gapless updates),
// which means its console output is otherwise DISCARDED — we were blind to exactly the audio
// lifecycle events that decide whether the station stays on air. This module opens the daemon's
// OWN append-mode log file and tees console.log/console.error into it with ISO timestamps.
//
// Path resolution:
//   1. ETHER_AUDIOD_LOG  — set by the spawning client/watchdog, which knows app userData.
//   2. fallback          — derived <userData>/logs/ether-audiod.log, so the daemon is NEVER
//                          blind even when spawned by an older client that doesn't set the env.
//
// Size policy: at MAX_BYTES the file ROTATES (…log → …log.1, then a fresh …log) — it must never
// go SILENT at the cap, because a log that stops on the audio subsystem reintroduces the very
// blindness this fixes. Logging must never throw into the playout path: every fs op is guarded.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const MAX_BYTES = 5 * 1024 * 1024;   // 5 MB, then rotate (keeps one previous generation: .1)
const APP = "openair";               // electron app name → userData dir (matches main process)

function defaultLogPath() {
  let base;
  if (process.platform === "win32") base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  else if (process.platform === "darwin") base = path.join(os.homedir(), "Library", "Application Support");
  else base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, APP, "logs", "ether-audiod.log");
}

let stream = null;
let logPath = null;
let bytes = 0;
let installed = false;

function ts() { return new Date().toISOString(); }

function openStream() {
  logPath = process.env.ETHER_AUDIOD_LOG || defaultLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    try { bytes = fs.statSync(logPath).size; } catch { bytes = 0; }
    stream = fs.createWriteStream(logPath, { flags: "a" });
    stream.on("error", () => { /* a logging failure must never crash the daemon */ });
  } catch { stream = null; }
}

function rotate() {
  try { if (stream) stream.end(); } catch {}
  stream = null;
  try { fs.renameSync(logPath, logPath + ".1"); } catch { /* if rename fails, we just re-open + keep appending */ }
  bytes = 0;
  try {
    stream = fs.createWriteStream(logPath, { flags: "a" });
    stream.on("error", () => {});
  } catch { stream = null; }
}

function fmt(a) {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function writeLine(level, args) {
  if (!stream) return;
  const line = ts() + " [" + level + "] " + args.map(fmt).join(" ") + "\n";
  try { stream.write(line); bytes += Buffer.byteLength(line); } catch {}
  if (bytes >= MAX_BYTES) rotate();   // rotate AFTER writing — never silently stop at the cap
}

// Tee console.log/console.error to the file. Idempotent; safe if the sink can't open (no-op tee,
// the original console still works for harness/dev stdout).
function install() {
  if (installed) return;
  installed = true;
  openStream();
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...a) => { writeLine("INFO", a); origLog(...a); };
  console.error = (...a) => { writeLine("ERR", a); origErr(...a); };
  console.log("[audiod-log] sink open → " + logPath + " (pid " + process.pid + ", " + process.platform + ", node " + process.version + ")");
}

module.exports = { install, logPath: () => logPath };
