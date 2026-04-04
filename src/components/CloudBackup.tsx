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

const API_URL = "https://ether-backend-production.up.railway.app";

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

  // Load saved credentials
  useEffect(() => {
    (async () => {
      try {
        const rows = await query<{ key: string; value: string }>(
          "SELECT key, value FROM station_config_kv WHERE key IN ('license_key','license_email','station_name','cloud_auto_backup','cloud_last_backup')"
        );
        const kv: Record<string, string> = {};
        rows.forEach(r => { kv[r.key] = r.value; });
        if (kv.license_key) setLicenseKey(kv.license_key);
        if (kv.license_email) setStationId(kv.license_email);
        if (kv.cloud_auto_backup === "1") setAutoBackup(true);
        if (kv.cloud_last_backup) setLastBackupAt(kv.cloud_last_backup);
      } catch {}
    })();
  }, []);

  const loadBackups = useCallback(async () => {
    if (!licenseKey || !stationId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/backup/list?station_id=${encodeURIComponent(stationId)}`, {
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
      formData.append("backup", new Blob([compressed], { type: "application/gzip" }), filename);
      formData.append("station_id", stationId);
      formData.append("filename", filename);
      if (description.trim()) formData.append("description", description.trim());

      const res = await fetch(`${API_URL}/backup/upload`, {
        method: "POST",
        headers: { "x-license-key": licenseKey },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }

      const now = new Date().toISOString();
      await execute("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('cloud_last_backup',?)", [now]);
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
      const res = await fetch(`${API_URL}/backup/download/${backup.id}`, {
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
      const res = await fetch(`${API_URL}/backup/${backup.id}`, {
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
    await execute("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('cloud_auto_backup',?)", [next ? "1" : "0"]);
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
