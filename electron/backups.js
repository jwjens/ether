// electron/backups.js — BACKUPS BY SETTING, PER COMPUTER (Jeff, 2026-10-20: "make it settings-based: I set how often
// backups run (down to every few minutes) and how many are kept, on each computer. The restore screen lists every
// backup with its date and time so I can pick the one from just before a mistake."). docs/backups-today-and-settings-plan-2026-10-20.md.
//
// SETTINGS live in system_state — this computer's own bookkeeping, never synced — so one computer's choice never reaches
// another. Starting values are what each computer did before 4.6.62: local backups OFF (they were manual only), cloud
// every 6 hours (or the computer's own cloud interval), cloud backups kept forever. Every number is shown and changeable.
//   backup_local_every_min   0 = off, else >= 5        backup_local_keep   the last K local backups (>= 1)
//   backup_cloud_every_min   0 = off, else >= 5        backup_cloud_keep   0 = keep all, else the last K of THIS computer
// THE SCHEDULE SURVIVES RESTARTS: the next due time is stored (backup_*_next_at), so a computer restarted more often than
// the interval still backs up (before, the cloud timer restarted with the app).
// THE WORK IS OFF MAIN: electron/backup-worker.js makes, checks and (for cloud) compresses every backup.
"use strict";
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");

const MIN_EVERY = 5;
const LOCAL_RE = /^openair-backup-(\d+)\.db$/;

function create({ getDb, dbPath, backupsDir, cloudRun, healthEvent, log = console.log }) {
  const kvGet = (k) => { try { return getDb().prepare("SELECT value FROM system_state WHERE key = ?").get(k)?.value ?? null; } catch { return null; } };
  const kvSet = (k, v) => getDb().prepare("INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES (?, ?, ?)").run(k, String(v), new Date().toISOString());

  function settings() {
    const num = (k, d) => { const v = kvGet(k); const n = v == null ? NaN : Number(v); return Number.isFinite(n) ? n : d; };
    let cloudDefault = 360;
    try {   // the computer's own cloud interval from before 4.6.62 (station_config_kv cloud_backup_interval_hours)
      const r = getDb().prepare("SELECT value FROM station_config_kv WHERE key = 'cloud_backup_interval_hours' AND deleted_at IS NULL LIMIT 1").get();
      const h = r ? Number(r.value) : NaN; if (Number.isFinite(h) && h > 0) cloudDefault = Math.round(h * 60);
    } catch {}
    return {
      localEveryMin: num("backup_local_every_min", 0), localKeep: num("backup_local_keep", 10),
      cloudEveryMin: num("backup_cloud_every_min", cloudDefault), cloudKeep: num("backup_cloud_keep", 0),
      localNextAt: num("backup_local_next_at", 0) || null, cloudNextAt: num("backup_cloud_next_at", 0) || null,
      localLast: JSON.parse(kvGet("backup_local_last") || "null"), cloudLast: JSON.parse(kvGet("backup_cloud_last") || "null"),
      dbBytes: (() => { try { return fs.statSync(dbPath()).size; } catch { return null; } })(),
    };
  }

  /** Validate and store. → the new settings. Throws with a plain reason on a bad value. */
  function setSettings(p) {
    const every = (v, name) => { const n = Number(v); if (!Number.isInteger(n) || (n !== 0 && n < MIN_EVERY)) throw new Error(`${name}: Off, or every ${MIN_EVERY} minutes or more`); return n; };
    const keep = (v, name, allowAll) => { const n = Number(v); if (!Number.isInteger(n) || n < (allowAll ? 0 : 1)) throw new Error(`${name}: ${allowAll ? "0 (keep all) or more" : "at least 1"}`); return n; };
    const now = Date.now();
    if (p.localEveryMin !== undefined) { const n = every(p.localEveryMin, "Local backups"); kvSet("backup_local_every_min", n); kvSet("backup_local_next_at", n ? now + n * 60000 : 0); }
    if (p.localKeep !== undefined) kvSet("backup_local_keep", keep(p.localKeep, "Local backups kept", false));
    if (p.cloudEveryMin !== undefined) { const n = every(p.cloudEveryMin, "Cloud backups"); kvSet("backup_cloud_every_min", n); kvSet("backup_cloud_next_at", n ? now + n * 60000 : 0); }
    if (p.cloudKeep !== undefined) kvSet("backup_cloud_keep", keep(p.cloudKeep, "Cloud backups kept", true));
    healthEvent("backup-settings-changed", { ...p, message: "Backup settings changed on this computer" });
    if (p.localKeep !== undefined) pruneLocal();
    return settings();
  }

  /** Make one backup in the worker. → result posted by electron/backup-worker.js */
  function inWorker(outPath, gzip) {
    return new Promise((resolve) => {
      const w = new Worker(path.join(__dirname, "backup-worker.js"), { workerData: { dbPath: dbPath(), outPath, gzip } });
      let done = false;
      w.once("message", (m) => { done = true; resolve(m); });
      w.once("error", (e) => { if (!done) { done = true; resolve({ ok: false, error: e.message }); } });
      w.once("exit", (c) => { if (!done) { done = true; resolve({ ok: false, error: `backup worker exited (${c})` }); } });
    });
  }

  function listLocal() {
    const dir = backupsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map(n => { const m = LOCAL_RE.exec(n); if (!m) return null; let size = null; try { size = fs.statSync(path.join(dir, n)).size; } catch {} return { name: n, at: Number(m[1]) * 1000, bytes: size, where: "local" }; })
      .filter(Boolean).sort((a, b) => b.at - a.at);
  }
  function pruneLocal() {
    const keep = settings().localKeep;
    const drop = listLocal().slice(Math.max(1, keep));
    for (const b of drop) { try { fs.rmSync(path.join(backupsDir(), b.name), { force: true }); } catch {} }
    if (drop.length) log(`[backups] local: kept ${keep}, removed ${drop.length}`);
    return drop.length;
  }

  let localRunning = false, cloudRunning = false;
  async function runLocal(reason) {
    if (localRunning) return { ok: false, error: "a local backup is already running" };
    localRunning = true;
    try {
      const dir = backupsDir(); fs.mkdirSync(dir, { recursive: true });
      // A FREE name (two backups in one second must never share one), written as .partial and renamed only when the
      // worker says it is good — so a failed backup can only ever remove its own unfinished file, never a good backup.
      let sec = Math.floor(Date.now() / 1000);
      while (fs.existsSync(path.join(dir, `openair-backup-${sec}.db`))) sec++;
      const name = `openair-backup-${sec}.db`;
      const partial = path.join(dir, name + ".partial");
      const r = await inWorker(partial, false);
      if (r.ok) fs.renameSync(partial, path.join(dir, name));
      const last = { at: Date.now(), ok: r.ok, name: r.ok ? name : null, bytes: r.bytes ?? null, songs: r.songs ?? null, ms: r.ms, error: r.error || null, reason };
      kvSet("backup_local_last", JSON.stringify(last));
      if (r.ok) { pruneLocal(); log(`[backups] local backup ${name}: ${(r.bytes / 1048576).toFixed(1)} MB, ${r.songs} songs, ${r.ms} ms (${reason})`); }
      else { log(`[backups] local backup FAILED (${reason}): ${r.error}`); healthEvent("backup-local-failed", { reason, error: r.error, message: `Local backup failed: ${r.error}` }); }
      return { ...r, name: r.ok ? name : null };
    } finally { localRunning = false; }
  }
  async function runCloud(reason) {
    if (cloudRunning) return { ok: false, error: "a cloud backup is already running" };
    cloudRunning = true;
    try {
      const r = await cloudRun({ reason, keep: settings().cloudKeep });
      kvSet("backup_cloud_last", JSON.stringify({ at: Date.now(), ok: !!(r && r.ok), skipped: r && r.skipped || null, error: (r && r.error) || null, reason }));
      if (r && !r.ok && !r.skipped) healthEvent("backup-cloud-failed", { reason, error: r.error, message: `Cloud backup failed: ${r.error}` });
      return r;
    } finally { cloudRunning = false; }
  }

  /** Every minute: run whatever is due. A due time in the past (the computer was off) runs now, once. */
  async function tick() {
    const s = settings(), now = Date.now();
    // No due time stored yet (the first run of 4.6.62, or a setting changed elsewhere): the first backup is one interval
    // from now — never a burst of work a minute after Ether starts on an air computer.
    if (s.localEveryMin >= MIN_EVERY && !s.localNextAt) { kvSet("backup_local_next_at", now + s.localEveryMin * 60000); return; }
    if (s.cloudEveryMin >= MIN_EVERY && !s.cloudNextAt) { kvSet("backup_cloud_next_at", now + s.cloudEveryMin * 60000); return; }
    if (s.localEveryMin >= MIN_EVERY && now >= s.localNextAt) {
      kvSet("backup_local_next_at", now + s.localEveryMin * 60000);
      await runLocal("scheduled");
    }
    if (s.cloudEveryMin >= MIN_EVERY && now >= s.cloudNextAt) {
      kvSet("backup_cloud_next_at", now + s.cloudEveryMin * 60000);
      await runCloud("scheduled");
    }
  }

  return { settings, setSettings, listLocal, pruneLocal, runLocal, runCloud, tick, inWorker };
}

module.exports = { create, MIN_EVERY, LOCAL_RE };
