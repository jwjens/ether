// audiod/loudness.js — ONE loudness normalization for every source on air (2026-10-11).
//
// docs/fader-kind-loudness-taper-2026-10-11.md §2. Jeff: "every source (music, sweepers, carts, announcements, mic,
// Link, anything on any fader) is treated the same: same normalization … No per-type or per-item exceptions."
// Measured on 2026-10-11: the music −15.8 LUFS, a sweeper −9.6, a cart −7.3 — and nothing was normalized (every deck
// loaded with gain 0), so carts and sweepers aired 6–9 LU over the music.
//
// THE RULE, for every FILE loaded onto any fader:  gain = target − measured.
//   · measured — the file's integrated loudness (EBU R128 / BS.1770, ffmpeg's ebur128), measured ONCE per file CONTENT
//     (sha256 of the bytes) and cached, so a renamed or copied file is not measured twice and an edited one is;
//   · target   — the station's `loudness_target_lufs` (Settings; −16 until the operator sets it);
//   · nothing else: no per-item trim, no per-type rule. A per-song gain stored elsewhere (songs.gain_db) is ignored.
// The gain rides the engine's existing per-deck trim (audio_load gain_db), which the engine clamps to −20…+12 dB; a
// file outside that range is said, never silently.
// Measuring is a background job: one ffmpeg at a time, at low CPU priority, never on the playout path. A file not yet
// measured plays at 0 dB trim and is reported (and queued); nothing is ever held back from air waiting for a number.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const cp = require("child_process");

const ENGINE_TRIM_DB = [-20, 12];          // the engine's own per-deck trim clamp (native audio.rs: 0.1…4.0)
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a|aac|aif|aiff|opus|wma)$/i;

/** Parse ffmpeg's ebur128 summary: "I: -15.8 LUFS". null when absent (silence, or not audio). */
function parseIntegrated(stderr) {
  const tail = String(stderr || "").split(/Summary:/).pop();
  const m = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(tail);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > -70 ? v : null;   // −70 is the gate: below it there is no programme to measure
}

/** gain = target − measured, inside the engine's trim range. `clamped` says when the range bit. */
function gainFor(measured, target) {
  if (measured == null || !Number.isFinite(measured) || !Number.isFinite(target)) return { gainDb: 0, measured: false, clamped: false };
  const want = target - measured;
  const g = Math.max(ENGINE_TRIM_DB[0], Math.min(ENGINE_TRIM_DB[1], want));
  return { gainDb: g, measured: true, clamped: g !== want, wantDb: want };
}

function sha256File(fp) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(fp).on("error", reject).on("data", d => h.update(d)).on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * @param {{ cachePath: string, ffmpegPath?: string, log?: (m: string) => void, measure?: (fp: string) => Promise<number|null> }} o
 */
function createLoudness(o) {
  const log = o.log || (() => {});
  let cache = { v: 1, byHash: {}, byPath: {} };   // byHash: sha → { lufs, at }; byPath: path → { size, mtimeMs, sha }
  try { const c = JSON.parse(fs.readFileSync(o.cachePath, "utf8")); if (c && c.byHash && c.byPath) cache = c; } catch { /* first run */ }
  let saveTimer = null;
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { fs.mkdirSync(path.dirname(o.cachePath), { recursive: true }); fs.writeFileSync(o.cachePath + ".tmp", JSON.stringify(cache)); fs.renameSync(o.cachePath + ".tmp", o.cachePath); }
      catch (e) { log(`[loudness] cache NOT saved ✗ ${e && e.message}`); }
    }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  };

  const measureWithFfmpeg = (fp) => new Promise((resolve) => {
    const ff = o.ffmpegPath;
    if (!ff) { resolve(null); return; }
    let err = "";
    const child = cp.spawn(ff, ["-hide_banner", "-nostats", "-i", fp, "-af", "ebur128", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* best effort — never fatal */ }
    child.stderr.on("data", d => { err += d; if (err.length > 200000) err = err.slice(-50000); });
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(parseIntegrated(err)));
  });
  const measure = o.measure || measureWithFfmpeg;

  // The cache file is shared by the daemon (which measures) and main (in-process fallback): pick up the other's writes.
  let cacheMtime = 0, checkedAt = 0;
  try { cacheMtime = fs.statSync(o.cachePath).mtimeMs; } catch {}
  function refresh() {
    const now = Date.now(); if (now - checkedAt < 2000) return; checkedAt = now;
    let m = 0; try { m = fs.statSync(o.cachePath).mtimeMs; } catch { return; }
    if (m === cacheMtime || saveTimer) return;
    try { const c = JSON.parse(fs.readFileSync(o.cachePath, "utf8")); if (c && c.byHash && c.byPath) { cache = c; cacheMtime = m; } } catch { /* mid-write — next time */ }
  }
  /** The cached loudness of a file, or null — synchronous, never measures (the playout path calls this). */
  function lookup(fp) {
    refresh();
    let st; try { st = fs.statSync(fp); } catch { return null; }
    const p = cache.byPath[fp];
    if (!p || p.size !== st.size || p.mtimeMs !== st.mtimeMs) return null;
    const h = cache.byHash[p.sha];
    return h && Number.isFinite(h.lufs) ? h.lufs : null;
  }

  // ── the background measurer: one file at a time ──
  const queue = [], queued = new Set();
  let running = false, measuredCount = 0, failedCount = 0;
  function enqueue(fp) {
    if (!fp || queued.has(fp) || lookup(fp) != null) return;
    queued.add(fp); queue.push(fp);
    pump();
  }
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const fp = queue.shift();
        try {
          const st = fs.statSync(fp);
          const sha = await sha256File(fp);
          let h = cache.byHash[sha];
          if (!h) {
            const lufs = await measure(fp);
            if (lufs == null) { failedCount++; log(`[loudness] NOT measured (no programme above the gate, or not audio): ${path.basename(fp)}`); }
            h = { lufs: lufs == null ? null : Math.round(lufs * 10) / 10, at: new Date().toISOString() };
            cache.byHash[sha] = h;
            if (lufs != null) measuredCount++;
          }
          cache.byPath[fp] = { size: st.size, mtimeMs: st.mtimeMs, sha };
          save();
        } catch (e) { failedCount++; log(`[loudness] ${path.basename(fp)} ✗ ${e && e.message}`); }
        finally { queued.delete(fp); }
        await new Promise(r => setImmediate(r));   // yield between files
      }
    } finally { running = false; }
  }
  /** Queue every audio file the station could air (paths), skipping what is already measured. */
  function backfill(paths) {
    let n = 0;
    for (const fp of paths) { if (fp && AUDIO_EXT.test(fp) && lookup(fp) == null && !queued.has(fp)) { enqueue(fp); n++; } }
    if (n) log(`[loudness] backfill: ${n} file(s) queued for measuring (background, low priority)`);
    return n;
  }
  const status = () => ({ cached: Object.keys(cache.byHash).length, queued: queue.length + (running ? 1 : 0), measured: measuredCount, failed: failedCount });
  const idle = () => new Promise((resolve) => { const t = setInterval(() => { if (!running && !queue.length) { clearInterval(t); resolve(); } }, 20); });
  return { lookup, enqueue, backfill, status, idle, gainFor: (fp, target) => ({ ...gainFor(lookup(fp), target), lufs: lookup(fp) }) };
}

module.exports = { createLoudness, parseIntegrated, gainFor, ENGINE_TRIM_DB, AUDIO_EXT };
