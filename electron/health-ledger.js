// electron/health-ledger.js — THE ONE HEALTH LOG WRITER (Jeff, 2026-10-13; docs/air-machine-stalls-plan-2026-10-13.md §3).
//
// ovowforestmusic: two health-events.jsonl files (415 MB + 375 MB), never rotated, written with appendFileSync on main —
// every event a blocking disk write on the process that carries the board. Now:
//   · ONE file: <profile>\health-events.jsonl (the one the Health Monitor reads). The audio health monitor's
//     <profile>\logs\health-events.jsonl is no longer written.
//   · IN THE BACKGROUND: append() only queues the line; the disk write is fs.promises.appendFile (libuv's thread pool),
//     one write in flight at a time, the queue batched into it. A slow disk never holds main. The queue is capped
//     (MAX_QUEUE); an overflow drops lines and one line later says how many.
//   · ROTATED BY SIZE: past "Rotate at" MB the file becomes health-events.1.jsonl (older ones shift up; past "Keep" the
//     oldest goes). Both are SETTINGS (install_config_kv health_log_max_mb / health_log_keep, written once, shown in
//     Preferences), never numbers in code paths that decide alone.
//   · THE OLD BIG FILES: on the first pass a file already past "Rotate at" (and the old logs\ copy) is renamed to
//     health-events.archive-<date>.jsonl — not deleted. Archives older than health_log_archive_days are deleted.
"use strict";
const fs = require("fs");
const path = require("path");

const MAX_QUEUE = 5000;
const BASE = "health-events";
const SETTING_KEYS = { maxMb: "health_log_max_mb", keep: "health_log_keep", archiveDays: "health_log_archive_days" };
// The starting values Jeff chose (2026-10-13: "rotate at 50 MB, keep 5"; "delete the archived health logs after 30 days
// (setting)"). Written ONCE into install_config_kv by seedSettings; from then on only the stored values are used.
const SETTINGS_START = { maxMb: 50, keep: 5, archiveDays: 30 };
const RANGE = { maxMb: [1, 2000], keep: [1, 50], archiveDays: [1, 3650] };

function validSetting(k, v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= RANGE[k][0] && n <= RANGE[k][1] ? (k === "maxMb" ? n : Math.round(n)) : null;
}

/** Read the three settings from install_config_kv. A missing or bad value is null (the ledger then does not rotate or
 *  delete on its account — it never guesses a number). */
function readSettings(db) {
  const out = { maxMb: null, keep: null, archiveDays: null };
  try {
    const st = db.prepare("SELECT value FROM install_config_kv WHERE key = ? AND deleted_at IS NULL");
    for (const [k, key] of Object.entries(SETTING_KEYS)) { const r = st.get(key); out[k] = r ? validSetting(k, r.value) : null; }
  } catch { /* table absent / db closed: unknown */ }
  return out;
}
function writeSetting(db, k, value) {
  const key = SETTING_KEYS[k];
  if (!key) return { ok: false, reason: `unknown setting ${k}` };
  const v = validSetting(k, value);
  if (v == null) return { ok: false, reason: `${k} must be ${RANGE[k][0]}–${RANGE[k][1]}` };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO install_config_kv (key, value, uuid, created_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
             "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, deleted_at = NULL")
    .run(key, String(v), require("crypto").randomUUID(), now, now);
  return { ok: true, value: v };
}
/** Write the starting values for any setting this machine has never stored. Returns the keys written. */
function seedSettings(db) {
  const cur = readSettings(db), wrote = [];
  for (const k of Object.keys(SETTING_KEYS)) {
    if (cur[k] != null) continue;
    try {
      const has = db.prepare("SELECT 1 FROM install_config_kv WHERE key = ? AND deleted_at IS NULL").get(SETTING_KEYS[k]);
      if (has) continue;                                   // an operator value that is out of range is shown, never overwritten
      if (writeSetting(db, k, SETTINGS_START[k]).ok) wrote.push(SETTING_KEYS[k]);
    } catch { /* table absent */ }
  }
  return wrote;
}

const stamp = (d) => d.toISOString().slice(0, 10).replace(/-/g, "") + "-" + d.toISOString().slice(11, 19).replace(/:/g, "");

/**
 * @param o.dir()          the profile folder (resolved on every write — the active profile can change)
 * @param o.settings()     { maxMb, keep, archiveDays } (nulls allowed)
 * @param o.fsp            fs.promises (injectable for tests)
 * @param o.now            () => Date
 */
function createLedger({ dir, settings, fsp = fs.promises, now = () => new Date(), onError = () => {} }) {
  let queue = [], dropped = 0, writing = false, sizeKnown = new Map(), firstPass = new Set();
  const stats = { written: 0, dropped: 0, rotations: 0, archived: [], deleted: [], lastError: null, peakQueue: 0 };

  function append(obj) {
    let line;
    try { line = (typeof obj === "string" ? obj : JSON.stringify(obj)) + "\n"; } catch { return; }
    if (queue.length >= MAX_QUEUE) { dropped++; stats.dropped++; return; }
    queue.push(line);
    if (queue.length > stats.peakQueue) stats.peakQueue = queue.length;
    if (!writing) { writing = true; setImmediate(pump); }
  }

  async function exists(p) { try { await fsp.stat(p); return true; } catch { return false; } }
  async function sizeOf(p) { try { return (await fsp.stat(p)).size; } catch { return 0; } }

  // First time a folder is seen: an over-size file and the old logs\ copy become archives; archives past their days go.
  async function firstPassFor(d, s) {
    if (firstPass.has(d)) return;
    firstPass.add(d);
    const t = now(), file = path.join(d, `${BASE}.jsonl`), old = path.join(d, "logs", `${BASE}.jsonl`);
    try {
      if (await exists(old)) {
        const to = path.join(d, "logs", `${BASE}.archive-${stamp(t)}.jsonl`);
        await fsp.rename(old, to); stats.archived.push(to);
      }
      if (s.maxMb != null && (await sizeOf(file)) > s.maxMb * 1048576) {
        const to = path.join(d, `${BASE}.archive-${stamp(t)}.jsonl`);
        await fsp.rename(file, to); stats.archived.push(to);
      }
    } catch (e) { stats.lastError = `archive: ${e.message}`; onError(e); }
    await pruneArchives(d, s);
  }
  async function pruneArchives(d, s) {
    if (s.archiveDays == null) return;
    const cutoff = now().getTime() - s.archiveDays * 86400000;
    for (const folder of [d, path.join(d, "logs")]) {
      let names = [];
      try { names = await fsp.readdir(folder); } catch { continue; }
      for (const n of names) {
        if (!n.startsWith(`${BASE}.archive-`) || !n.endsWith(".jsonl")) continue;
        const p = path.join(folder, n);
        try { if ((await fsp.stat(p)).mtimeMs < cutoff) { await fsp.unlink(p); stats.deleted.push(p); } }
        catch (e) { stats.lastError = `prune: ${e.message}`; }
      }
    }
  }
  async function rotate(d, s) {
    const f = (i) => path.join(d, i === 0 ? `${BASE}.jsonl` : `${BASE}.${i}.jsonl`);
    try { await fsp.unlink(f(s.keep)); } catch { /* none */ }
    for (let i = s.keep - 1; i >= 0; i--) { try { await fsp.rename(f(i), f(i + 1)); } catch { /* gap */ } }
    stats.rotations++;
    await pruneArchives(d, s);
  }

  async function pump() {
    try {
      while (queue.length || dropped) {
        let d;
        try { d = dir(); } catch (e) { stats.lastError = e.message; break; }
        const s = settings() || {};
        await firstPassFor(d, s);
        const file = path.join(d, `${BASE}.jsonl`);
        if (dropped) { queue.push(JSON.stringify({ t: now().toISOString(), kind: "health-log-dropped", lines: dropped }) + "\n"); dropped = 0; }
        const batch = queue.join(""); const n = queue.length; queue = [];
        if (!sizeKnown.has(file)) sizeKnown.set(file, await sizeOf(file));
        if (s.maxMb != null && s.keep != null && sizeKnown.get(file) + batch.length > s.maxMb * 1048576 && sizeKnown.get(file) > 0) {
          await rotate(d, s); sizeKnown.set(file, 0);
        }
        try {
          await fsp.mkdir(d, { recursive: true });
          await fsp.appendFile(file, batch);
          sizeKnown.set(file, sizeKnown.get(file) + Buffer.byteLength(batch));
          stats.written += n;
        } catch (e) { stats.lastError = e.message; onError(e); sizeKnown.delete(file); }
      }
    } finally {
      writing = false;
      if (queue.length) { writing = true; setImmediate(pump); }
    }
  }

  /** Resolves once everything queued so far is on disk (tests, quit). */
  function flush() {
    return new Promise((res) => { const chk = () => (!writing && !queue.length ? res() : setTimeout(chk, 5)); chk(); });
  }
  function status() {
    const s = settings() || {};
    let size = null; try { size = fs.statSync(path.join(dir(), `${BASE}.jsonl`)).size; } catch { /* none yet */ }
    return { ...stats, queued: queue.length, sizeBytes: size, settings: s };
  }
  /** At quit only: whatever is still queued is written now (blocking is fine then — nothing is on air through main). */
  function drainSync() {
    if (!queue.length) return;
    try { fs.appendFileSync(path.join(dir(), `${BASE}.jsonl`), queue.join("")); queue = []; } catch { /* lost at quit */ }
  }
  return { append, flush, status, drainSync };
}

module.exports = { createLedger, readSettings, writeSetting, seedSettings, SETTINGS_START, SETTING_KEYS, RANGE, MAX_QUEUE };
