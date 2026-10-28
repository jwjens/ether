// electron/backup-worker.js — MAKE ONE BACKUP, OFF THE MAIN THREAD (Jeff, 2026-10-20: backups "down to every few
// minutes"). Its own read-only connection to the live database; SQLite's online backup (consistent while on air, WAL
// included — docs/cloud-backup-torn-wal-2026-08-07.md); the copy is opened and integrity-checked before it counts; for a
// cloud backup it is gzipped and checksummed by streaming. Nothing here touches the main thread: before 4.6.62 the cloud
// backup ran integrity_check and gzipSync of the whole database on main (fine every 6 h, a freeze every few minutes).
//
// workerData: { dbPath, outPath, gzip } → posts { ok, bytes, songs, gzPath, gzBytes, checksum, ms } or { ok:false, error }.
// A failed copy is deleted: a backup nobody can restore must never sit in the list.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const zlib = require("zlib");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const Database = require("better-sqlite3");

(async () => {
  const t0 = Date.now();
  const { dbPath, outPath, gzip } = workerData;
  let gzPath = null;
  try {
    const src = new Database(dbPath, { readonly: true, fileMustExist: true });
    src.pragma("busy_timeout = 10000");
    try { await src.backup(outPath); } finally { src.close(); }
    // NO SIGN-IN IN A BACKUP (Phase 0, docs/account-sign-in-plan-2026-10-26.md): an older database may still hold one;
    // the copy is scrubbed with secure_delete (the bytes are overwritten, not left in free pages) before it counts.
    { const w = new Database(outPath, { fileMustExist: true });
      try { require("./account-session").createAccountSession({ safeStorage: null, dir: () => "" }).scrubDb(w); } finally { w.close(); } }
    const probe = new Database(outPath, { readonly: true, fileMustExist: true });
    let integrity, songs;
    try {
      integrity = probe.prepare("PRAGMA integrity_check").get().integrity_check;
      songs = probe.prepare("SELECT COUNT(*) AS n FROM songs").get().n;
    } finally { probe.close(); }
    if (integrity !== "ok") throw new Error(`the copy failed its integrity check ("${integrity}")`);
    const bytes = fs.statSync(outPath).size;
    let gzBytes = null, checksum = null;
    if (gzip) {
      gzPath = outPath + ".gz";
      await pipeline(fs.createReadStream(outPath), zlib.createGzip({ level: 6 }), fs.createWriteStream(gzPath));
      gzBytes = fs.statSync(gzPath).size;
      const h = crypto.createHash("sha256");
      await pipeline(fs.createReadStream(gzPath), async function* (src) { for await (const c of src) h.update(c); });
      checksum = h.digest("hex").slice(0, 16);
    }
    parentPort.postMessage({ ok: true, bytes, songs, gzPath, gzBytes, checksum, ms: Date.now() - t0 });
  } catch (e) {
    for (const p of [outPath, gzPath]) { try { if (p) fs.rmSync(p, { force: true }); } catch { /* best effort */ } }
    parentPort.postMessage({ ok: false, error: e.message, ms: Date.now() - t0 });
  }
})();
