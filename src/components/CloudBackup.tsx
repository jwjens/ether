/**
 * CloudBackup.tsx
 * Ether Technologies — Cloud Log Backup (Pro feature)
 *
 * Backs up play_log, scheduled_log, and songs metadata to Railway backend.
 * Data is gzipped JSON before upload. Restore downloads and reimports.
 *
 * Gating: Pro = 30 backups max. Station = unlimited.
 */

import { useState, useEffect, useCallback } from "react";
import { query, execute } from "../db/client";
import { usePlan } from "../hooks/usePlan";
import { useActiveStation } from "../hooks/useActiveStation";
import { ETHER_BACKEND_URL } from "../lib/etherBackend";

// ─── Types ────────────────────────────────────────────────────

interface BackupEntry {
  id: number;
  filename: string;
  size_bytes: number;
  checksum: string;
  created_at: string;
  description: string | null;
}

interface BackupListResponse {
  backups: BackupEntry[];
  total_size_bytes: number;
  plan: string;
  limit: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────

function fmtBytes(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return fmtDate(iso);
}

// Simple gzip via CompressionStream (available in WebView2 / modern browsers)
async function gzipString(str: string): Promise<Uint8Array> {
  const stream = new (window as any).CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  writer.write(encoder.encode(str));
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

async function gunzipBytes(bytes: Uint8Array): Promise<string> {
  const stream = new (window as any).DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(result);
}

// ─── Main Component ───────────────────────────────────────────

export default function CloudBackup() {
  const { isPro, isStation, plan } = usePlan();
  const { stationId: activeStationId, isReady } = useActiveStation();

  const [licenseKey, setLicenseKey]       = useState("");
  const [stationId, setStationId]         = useState("");
  const [backups, setBackups]             = useState<BackupEntry[]>([]);
  const [totalSize, setTotalSize]         = useState(0);
  const [backupLimit, setBackupLimit]     = useState<number | null>(null);
  const [loading, setLoading]             = useState(false);
  const [backing, setBacking]             = useState(false);
  const [restoring, setRestoring]         = useState<number | null>(null);
  const [deleting, setDeleting]           = useState<number | null>(null);
  const [status, setStatus]               = useState<{ msg: string; type: "ok" | "err" | "info" } | null>(null);
  const [description, setDescription]    = useState("");
  const [autoBackup, setAutoBackup]       = useState(false);
  const [lastBackupAt, setLastBackupAt]   = useState<string | null>(null);

  // ── R2 config state ──
  const [r2Endpoint, setR2Endpoint]       = useState("");
  const [r2Bucket, setR2Bucket]           = useState("");
  const [r2AccessKey, setR2AccessKey]     = useState("");
  const [r2Secret, setR2Secret]           = useState("");
  const [r2HasSecret, setR2HasSecret]     = useState(false);
  const [r2Enabled, setR2Enabled]         = useState(false);
  const [r2Saving, setR2Saving]           = useState(false);
  const [r2Running, setR2Running]         = useState(false);
  const [r2History, setR2History]         = useState<{id:number;status:string;size_bytes:number;checksum:string;backed_up_at:number}[]>([]);
  const [r2Status, setR2Status]           = useState<{ msg: string; type: "ok" | "err" | "info" } | null>(null);

  // Load saved credentials
  useEffect(() => {
    if (!isReady) return;
    (async () => {
      try {
        const result = await (window as any).ether.stationConfigKv.list(activeStationId);
        const rows: { key: string; value: string }[] = result.ok ? result.rows : [];
        const get = (k: string) => rows.find((r: { key: string }) => r.key === k)?.value;
        if (get('license_key'))    setLicenseKey(get('license_key')!);
        if (get('license_email'))  setStationId(get('license_email')!);
        if (get('cloud_auto_backup') === "1") setAutoBackup(true);
        if (get('cloud_last_backup'))         setLastBackupAt(get('cloud_last_backup')!);
      } catch {}
    })();
  }, [activeStationId, isReady]);

  // Load R2 config from main process
  useEffect(() => {
    (async () => {
      try {
        const cfg = await (window as any).ether.cloudBackup.getR2Config();
        if (cfg.endpoint)    setR2Endpoint(cfg.endpoint);
        if (cfg.bucket)      setR2Bucket(cfg.bucket);
        if (cfg.accessKeyId) setR2AccessKey(cfg.accessKeyId);
        setR2HasSecret(!!cfg.hasSecret);
        setR2Enabled(!!cfg.enabled);
        const hist = await (window as any).ether.cloudBackup.getHistory();
        setR2History(hist ?? []);
      } catch {}
    })();
  }, []);

  const saveR2Config = async () => {
    setR2Saving(true);
    setR2Status({ msg: "Saving...", type: "info" });
    try {
      const result = await (window as any).ether.cloudBackup.setR2Config({
        endpoint:      r2Endpoint.trim(),
        bucket:        r2Bucket.trim(),
        accessKeyId:   r2AccessKey.trim(),
        secretAccessKey: r2Secret.trim() || undefined,
        enabled:       r2Enabled,
      });
      if (r2Secret) { setR2HasSecret(true); setR2Secret(""); }
      setR2Status({
        msg: result.ready ? "✓ R2 credentials saved — ready to backup" : "Saved (credentials incomplete — enter access key + secret)",
        type: result.ready ? "ok" : "info",
      });
    } catch (e: any) {
      setR2Status({ msg: "Save failed: " + e.message, type: "err" });
    }
    setR2Saving(false);
  };

  const runR2Backup = async () => {
    setR2Running(true);
    setR2Status({ msg: "Running backup...", type: "info" });
    try {
      const result = await (window as any).ether.cloudBackup.runNow();
      if (result.ok) {
        setR2Status({ msg: `✓ Backup complete — ${(result.size / 1024).toFixed(1)} KB (${result.checksum})`, type: "ok" });
        const hist = await (window as any).ether.cloudBackup.getHistory();
        setR2History(hist ?? []);
      } else {
        setR2Status({ msg: "Backup failed: " + result.error, type: "err" });
      }
    } catch (e: any) {
      setR2Status({ msg: "Backup failed: " + e.message, type: "err" });
    }
    setR2Running(false);
  };

  const loadBackups = useCallback(async () => {
    if (!licenseKey || !stationId) return;
    setLoading(true);
    try {
      const res = await fetch(`${ETHER_BACKEND_URL}/backup/list?station_id=${encodeURIComponent(stationId)}`, {
        headers: { "x-license-key": licenseKey },
      });
      if (!res.ok) throw new Error(await res.text());
      const data: BackupListResponse = await res.json();
      setBackups(data.backups);
      setTotalSize(data.total_size_bytes);
      setBackupLimit(data.limit);
    } catch (e: any) {
      setStatus({ msg: "Could not load backups: " + e.message, type: "err" });
    }
    setLoading(false);
  }, [licenseKey, stationId]);

  useEffect(() => { loadBackups(); }, [loadBackups]);

  // ── Create backup ──────────────────────────────────────────

  const createBackup = async () => {
    if (!licenseKey || !stationId) {
      setStatus({ msg: "Enter your license key and station ID first.", type: "err" });
      return;
    }
    setBacking(true);
    setStatus({ msg: "Collecting data...", type: "info" });

    try {
      // Gather all data
      const [plays, scheduled, songs, artists] = await Promise.all([
        query("SELECT * FROM play_log ORDER BY played_at DESC LIMIT 10000"),
        query("SELECT * FROM scheduled_log ORDER BY log_date DESC, hour, position LIMIT 50000"),
        query("SELECT id,title,artist_id,file_path,duration_ms,bpm,energy,lufs_measured,peak_db,gain_db,cue_in,cue_out,intro_end,outro_start,last_played_at FROM songs"),
        query("SELECT * FROM artists"),
      ]);

      const payload = {
        version: "1.5.2",
        exported_at: new Date().toISOString(),
        station_id: stationId,
        tables: { play_log: plays, scheduled_log: scheduled, songs, artists },
      };

      setStatus({ msg: "Compressing...", type: "info" });
      const json       = JSON.stringify(payload);
      const compressed = await gzipString(json);
      const filename   = `ether_backup_${stationId.replace(/[^a-z0-9]/gi, "_")}_${new Date().toISOString().slice(0, 10)}.json.gz`;

      setStatus({ msg: "Uploading...", type: "info" });
      const formData = new FormData();
      formData.append("backup", new Blob([compressed as Uint8Array<ArrayBuffer>], { type: "application/gzip" }), filename);
      formData.append("station_id", stationId);
      formData.append("filename", filename);
      if (description.trim()) formData.append("description", description.trim());

      const res = await fetch(`${ETHER_BACKEND_URL}/backup/upload`, {
        method: "POST",
        headers: { "x-license-key": licenseKey },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }

      const now = new Date().toISOString();
      await (window as any).ether.stationConfigKv.upsertByKey(activeStationId, 'cloud_last_backup', now);
      setLastBackupAt(now);
      setDescription("");
      setStatus({ msg: `✓ Backup uploaded (${fmtBytes(compressed.length)})`, type: "ok" });
      loadBackups();
    } catch (e: any) {
      setStatus({ msg: "Backup failed: " + e.message, type: "err" });
    }
    setBacking(false);
  };

  // ── Restore backup ─────────────────────────────────────────

  const restoreBackup = async (backup: BackupEntry) => {
    if (!confirm(`Restore backup from ${fmtDate(backup.created_at)}?\n\nThis will REPLACE your current play_log and scheduled_log with the backup data. Songs library will not be affected.`)) return;

    setRestoring(backup.id);
    setStatus({ msg: "Downloading backup...", type: "info" });

    try {
      const res = await fetch(`${ETHER_BACKEND_URL}/backup/download/${backup.id}`, {
        headers: { "x-license-key": licenseKey },
      });
      if (!res.ok) throw new Error("Download failed");

      const arrayBuf = await res.arrayBuffer();
      const bytes    = new Uint8Array(arrayBuf);

      setStatus({ msg: "Decompressing...", type: "info" });
      const json    = await gunzipBytes(bytes);
      const payload = JSON.parse(json);

      setStatus({ msg: "Restoring data...", type: "info" });

      // Restore play_log
      // DEFERRED (phase-3.5 cluster B step 3): these two execute() calls are intentional
      // raw writes that bypass the typed handler. Cloud restore is a privileged DB
      // operation — NOT a normal app write. Wrapping in window.ether.playLog.* requires
      // either a 'restore-batch' protocol op (out of scope) or a dedicated restore IPC
      // that bypasses sync entirely (correct architecture, separate arc).
      // The db:execute lock WILL fire here on a real restore. See:
      //   docs/phase-3.5-cloudbackup-restore-deferred.md
      if (payload.tables?.play_log?.length > 0) {
        await execute("DELETE FROM play_log", []);
        for (const row of payload.tables.play_log) {
          await execute(
            "INSERT OR IGNORE INTO play_log (id,title,artist,deck_id,played_at) VALUES (?,?,?,?,?)",
            [row.id, row.title, row.artist, row.deck_id, row.played_at]
          );
        }
      }

      // Restore scheduled_log
      // DEFERRED (phase-3.5 cluster C): these execute() calls are intentional
      // raw writes that bypass the typed handler. Same class as the play_log
      // restore above — cloud restore is a privileged DB operation, not a
      // normal app write. Additionally, the column names here (song_title,
      // song_artist, slot_type, etc.) do not match the live DB schema (title,
      // artist), so this restore path is doubly broken. Both problems deferred.
      // See docs/phase-3.5-programlog-deferred.md and
      //     docs/phase-3.5-cloudbackup-restore-deferred.md
      if (payload.tables?.scheduled_log?.length > 0) {
        await execute("DELETE FROM scheduled_log", []);
        for (const row of payload.tables.scheduled_log) {
          await execute(
            `INSERT OR IGNORE INTO scheduled_log
             (id,log_date,hour,position,slot_type,category_id,category_code,category_color,
              song_id,song_title,song_artist,duration_ms,label,status,overflow,fade_out_at_ms,fade_duration_ms)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [row.id, row.log_date, row.hour, row.position, row.slot_type,
             row.category_id, row.category_code, row.category_color,
             row.song_id, row.song_title, row.song_artist, row.duration_ms,
             row.label, row.status, row.overflow, row.fade_out_at_ms, row.fade_duration_ms]
          );
        }
      }

      setStatus({ msg: `✓ Restored ${payload.tables?.play_log?.length ?? 0} play log entries and ${payload.tables?.scheduled_log?.length ?? 0} scheduled entries.`, type: "ok" });
    } catch (e: any) {
      setStatus({ msg: "Restore failed: " + e.message, type: "err" });
    }
    setRestoring(null);
  };

  // ── Delete backup ──────────────────────────────────────────

  const deleteBackup = async (backup: BackupEntry) => {
    if (!confirm("Delete this backup? This cannot be undone.")) return;
    setDeleting(backup.id);
    try {
      const res = await fetch(`${ETHER_BACKEND_URL}/backup/${backup.id}`, {
        method: "DELETE",
        headers: { "x-license-key": licenseKey },
      });
      if (!res.ok) throw new Error("Delete failed");
      setStatus({ msg: "Backup deleted.", type: "ok" });
      loadBackups();
    } catch (e: any) {
      setStatus({ msg: "Delete failed: " + e.message, type: "err" });
    }
    setDeleting(null);
  };

  const toggleAutoBackup = async () => {
    const next = !autoBackup;
    setAutoBackup(next);
    await (window as any).ether.stationConfigKv.upsertByKey(activeStationId, 'cloud_auto_backup', next ? "1" : "0");
  };

  const statusColor = status?.type === "ok" ? "#34d399" : status?.type === "err" ? "#ef4444" : "var(--accent-cyan)";

  // ─── Render ──────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--bg-primary)" }}>

      {/* Header */}
      <div style={{ padding: "14px 24px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-secondary)", flexShrink: 0 }}>
        <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "var(--accent-cyan)", textTransform: "uppercase", marginBottom: 2 }}>Pro Feature</div>
        <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>Cloud Log Backup</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
          Back up your play history and program logs securely to Ether cloud
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Status banner */}
        {status && (
          <div style={{ padding: "10px 14px", borderRadius: 0, background: statusColor + "12", border: `1px solid ${statusColor}35`, fontSize: 12, color: statusColor, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>{status.msg}</span>
            <button onClick={() => setStatus(null)} style={{ background: "none", border: "none", color: statusColor, cursor: "pointer", fontSize: 14 }}>✕</button>
          </div>
        )}

        {/* ── R2 Direct Storage ── */}
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "16px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "#f97316", textTransform: "uppercase", marginBottom: 2 }}>Cloudflare R2</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Direct object storage — credentials stored locally, never transmitted</div>
            </div>
            {/* enabled toggle */}
            <button onClick={() => setR2Enabled(e => !e)} style={{ width: 40, height: 22, borderRadius: 0, border: "none", cursor: "pointer", position: "relative", background: r2Enabled ? "#f97316" : "var(--bg-tertiary)", transition: "background 0.2s", flexShrink: 0 }}>
              <div style={{ position: "absolute", top: 3, left: r2Enabled ? 20 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
            </button>
          </div>

          {r2Status && (
            <div style={{ marginBottom: 10, padding: "8px 12px", background: (r2Status.type === "ok" ? "#34d399" : r2Status.type === "err" ? "#ef4444" : "var(--accent-cyan)") + "14", border: `1px solid ${r2Status.type === "ok" ? "#34d399" : r2Status.type === "err" ? "#ef4444" : "var(--accent-cyan)"}35`, fontSize: 11, color: r2Status.type === "ok" ? "#34d399" : r2Status.type === "err" ? "#ef4444" : "var(--accent-cyan)", display: "flex", justifyContent: "space-between" }}>
              <span>{r2Status.msg}</span>
              <button onClick={() => setR2Status(null)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>✕</button>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4 }}>Endpoint URL</div>
              <input type="text" value={r2Endpoint} onChange={e => setR2Endpoint(e.target.value)} placeholder="https://<account-id>.r2.cloudflarestorage.com"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'DM Mono', monospace", boxSizing: "border-box" }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4 }}>Bucket Name</div>
              <input type="text" value={r2Bucket} onChange={e => setR2Bucket(e.target.value)} placeholder="ether-backups"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4 }}>Access Key ID</div>
              <input type="text" value={r2AccessKey} onChange={e => setR2AccessKey(e.target.value)} placeholder="Access key ID"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'DM Mono', monospace", boxSizing: "border-box" }} />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4 }}>
                Secret Access Key {r2HasSecret && !r2Secret && <span style={{ color: "#34d399" }}>— saved ✓</span>}
              </div>
              <input type="password" value={r2Secret} onChange={e => setR2Secret(e.target.value)}
                placeholder={r2HasSecret ? "Leave blank to keep saved secret" : "Secret access key"}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'DM Mono', monospace", boxSizing: "border-box" }} />
            </div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={saveR2Config} disabled={r2Saving}
              style={{ padding: "7px 16px", borderRadius: 0, fontSize: 11, fontWeight: 700, background: "rgba(249,115,22,0.12)", color: "#f97316", border: "1px solid rgba(249,115,22,0.3)", cursor: "pointer", opacity: r2Saving ? 0.6 : 1 }}>
              {r2Saving ? "Saving..." : "Save Credentials"}
            </button>
            <button onClick={runR2Backup} disabled={r2Running}
              style={{ padding: "7px 18px", borderRadius: 0, fontSize: 11, fontWeight: 700, background: r2Running ? "var(--bg-tertiary)" : "#f97316", color: r2Running ? "var(--text-tertiary)" : "#000", border: "none", cursor: r2Running ? "default" : "pointer", transition: "all 0.15s" }}>
              {r2Running ? "⏳ Backing up..." : "▲ Backup to R2 Now"}
            </button>
          </div>

          {/* R2 history */}
          {r2History.length > 0 && (
            <div style={{ marginTop: 12, borderTop: "1px solid var(--border-primary)", paddingTop: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6 }}>Recent Backups</div>
              {r2History.slice(0, 5).map(h => (
                <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", fontSize: 11 }}>
                  <span style={{ color: h.status === "success" ? "#34d399" : "#ef4444", fontWeight: 700, width: 14 }}>{h.status === "success" ? "✓" : "✕"}</span>
                  <span style={{ color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", fontSize: 10 }}>
                    {new Date(h.backed_up_at * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  {h.status === "success" && (
                    <>
                      <span style={{ color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", fontSize: 10 }}>{(h.size_bytes / 1024).toFixed(1)} KB</span>
                      <span style={{ color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", fontSize: 10 }}>{h.checksum}</span>
                    </>
                  )}
                  {h.status !== "success" && <span style={{ color: "#ef4444", fontSize: 10 }}>{h.status}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Credentials */}
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "16px 18px" }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 12 }}>Connection</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4 }}>License Key</div>
              <input
                type="password" value={licenseKey}
                onChange={e => setLicenseKey(e.target.value)}
                placeholder="ETH-PRO-XXXX-XXXX-XXXX"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'DM Mono', monospace", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 4 }}>Station ID (your email)</div>
              <input
                type="text" value={stationId}
                onChange={e => setStationId(e.target.value)}
                placeholder="you@station.com"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" }}
              />
            </div>
          </div>
          <button onClick={loadBackups} disabled={loading || !licenseKey || !stationId} style={{ marginTop: 10, padding: "7px 16px", borderRadius: 0, fontSize: 11, fontWeight: 700, background: "rgba(34,211,238,0.12)", color: "var(--accent-cyan)", border: "1px solid rgba(34,211,238,0.25)", cursor: "pointer", opacity: (!licenseKey || !stationId) ? 0.5 : 1 }}>
            {loading ? "Loading..." : "Connect"}
          </button>
        </div>

        {/* Create backup */}
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "16px 18px" }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 12 }}>Create Backup</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <input
              type="text" value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Description (optional) — e.g. 'Before format change'"
              style={{ flex: 1, padding: "8px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}
            />
            <button
              onClick={createBackup}
              disabled={backing || !licenseKey || !stationId}
              style={{
                padding: "8px 20px", borderRadius: 0, fontSize: 12, fontWeight: 700,
                background: backing ? "var(--bg-tertiary)" : "var(--accent-green)",
                color: backing ? "var(--text-tertiary)" : "#000",
                border: "none", cursor: (!licenseKey || !stationId || backing) ? "default" : "pointer",
                opacity: (!licenseKey || !stationId) ? 0.5 : 1,
                transition: "all 0.15s", flexShrink: 0,
              }}
            >
              {backing ? "⏳ Backing up..." : "☁ Backup Now"}
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={toggleAutoBackup}
              style={{ width: 36, height: 20, borderRadius: 0, border: "none", cursor: "pointer", position: "relative", background: autoBackup ? "var(--accent-green)" : "var(--bg-tertiary)", transition: "background 0.2s", flexShrink: 0 }}
            >
              <div style={{ position: "absolute", top: 2, left: autoBackup ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
            </button>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Auto-backup daily at midnight</span>
            {lastBackupAt && <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginLeft: "auto" }}>Last backup: {timeAgo(lastBackupAt)}</span>}
          </div>

          <div style={{ marginTop: 10, fontSize: 10, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
            Backs up: play history, program logs, scheduling data.
            {plan === "pro" ? ` Pro plan: last ${backupLimit ?? 30} backups stored.` : " Station plan: unlimited backups."}
          </div>
        </div>

        {/* Backup list */}
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>
              Saved Backups {backups.length > 0 && `(${backups.length})`}
            </div>
            {totalSize > 0 && (
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>
                {fmtBytes(totalSize)} total
              </div>
            )}
          </div>

          {loading ? (
            <div style={{ padding: "32px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>Loading backups...</div>
          ) : backups.length === 0 ? (
            <div style={{ padding: "40px 24px", textAlign: "center" }}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>☁</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>No backups yet</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Click "Backup Now" to create your first cloud backup</div>
            </div>
          ) : (
            backups.map((b, i) => (
              <div key={b.id} style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "12px 16px",
                borderBottom: i < backups.length - 1 ? "1px solid var(--border-primary)" : "none",
                background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
              }}>
                {/* Icon */}
                <div style={{ width: 36, height: 36, borderRadius: 0, background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>☁</div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {b.description || b.filename}
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
                    <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{fmtDate(b.created_at)}</span>
                    <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>{fmtBytes(b.size_bytes)}</span>
                  </div>
                </div>

                {/* Actions */}
                <button
                  onClick={() => restoreBackup(b)}
                  disabled={restoring === b.id}
                  style={{ padding: "5px 12px", borderRadius: 0, fontSize: 10, fontWeight: 700, background: "rgba(52,211,153,0.1)", color: "#34d399", border: "1px solid rgba(52,211,153,0.25)", cursor: "pointer", flexShrink: 0 }}
                >
                  {restoring === b.id ? "Restoring..." : "↩ Restore"}
                </button>
                <button
                  onClick={() => deleteBackup(b)}
                  disabled={deleting === b.id}
                  style={{ padding: "5px 8px", borderRadius: 0, fontSize: 11, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer", flexShrink: 0 }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
                >✕</button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
