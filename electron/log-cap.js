// electron/log-cap.js — a log file that can't grow past a set size (Jeff, 2026-10-23: "cap the startup log so it can't
// grow past a set size"). ether-startup.log on OVEVENTS had reached 1.87 GB.
//
// One file plus one previous: when the current file passes `capBytes`, its LAST `capBytes` move to `<file>.1` (replacing
// the previous one) and the current file starts empty. So the pair never holds more than ~2 × capBytes, and an oversized
// file left by an older build is cut down at its first rotation, keeping its newest part, not carried along whole.
//
// The size is tracked in memory (one stat at open), so an append costs no extra disk call.
"use strict";
const fs = require("fs");

const STARTUP_LOG_CAP_BYTES = 20 * 1024 * 1024;   // 20 MB current + 20 MB previous

function createCappedLog(filePath, { capBytes = STARTUP_LOG_CAP_BYTES } = {}) {
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch { size = 0; }

  function rotate() {
    const prev = `${filePath}.1`;
    let fd = null;
    try {
      const total = fs.statSync(filePath).size;
      const keep = Math.min(total, capBytes);
      const buf = Buffer.alloc(keep);
      fd = fs.openSync(filePath, "r");
      fs.readSync(fd, buf, 0, keep, total - keep);
      fs.closeSync(fd); fd = null;
      fs.writeFileSync(prev, buf);
    } catch { /* a failed copy of the old lines must never stop the log */ }
    finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
    try { fs.writeFileSync(filePath, ""); size = 0; } catch {}
  }

  function append(line) {
    if (size >= capBytes) rotate();
    try { fs.appendFileSync(filePath, line); size += Buffer.byteLength(line); } catch {}
  }

  return { append, rotateIfOver: () => { if (size >= capBytes) rotate(); }, size: () => size };
}

module.exports = { createCappedLog, STARTUP_LOG_CAP_BYTES };
