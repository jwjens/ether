// VoiceTrackInbox.tsx — studio-side inbox for voice tracks uploaded from
// the Ether2Go mobile companion app.
//
// What the DJ sees:
//   - Every voice track uploaded from any paired phone, newest first
//   - Audio playback inline (loaded via file:// URL)
//   - Status badges: uploaded → queued → played → archived
//   - Actions: Add to Queue (drops it into the playout engine), Delete
//
// The mobile app handles recording + upload; this is purely the receiving
// side. Voice tracks live as files in <userData>/voice-tracks/.

import { useEffect, useState } from "react";
import { engine } from "../audio/engine-rodio";

interface Track {
  id: number;
  pairing_id: number;
  file_path: string;
  mime_type: string;
  duration_ms: number;
  size_bytes: number;
  title: string;
  notes: string;
  status: "uploaded" | "queued" | "played" | "archived";
  uploaded_at: number;
  played_at: number;
  device_label?: string;
  operator_name?: string;
}

const STATUS_COLOR: Record<string, string> = {
  uploaded: "#38bdf8",
  queued:   "#f59e0b",
  played:   "#22c55e",
  archived: "#94a3b8",
};

function fmtMs(ms: number) {
  if (!ms) return "—";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtBytes(b: number) {
  if (!b) return "—";
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}
function fmtAgo(unixSec: number) {
  if (!unixSec) return "—";
  const d = Math.floor(Date.now() / 1000) - unixSec;
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export default function VoiceTrackInbox({ onClose }: { onClose?: () => void }) {
  const ether = (window as any).ether;
  const [tracks, setTracks]   = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter]   = useState<"all" | "uploaded" | "queued" | "played" | "archived">("all");
  const [playing, setPlaying] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const rows: Track[] = await ether?.v2g?.listTracks?.() || [];
      setTracks(rows);
    } catch (e) {
      console.error("[VoiceTrackInbox] load failed:", e);
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);
  // Auto-refresh every 5s while inbox is open — catches new uploads from
  // the mobile app without forcing a manual refresh.
  useEffect(() => {
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, []);

  const filtered = tracks.filter(t => filter === "all" || t.status === filter);

  // Drop the voice track into the playout queue. The engine accepts a
  // {filePath, title, artist} shape; voice tracks have no artist so we
  // tag them clearly so the DJ knows what's coming.
  const sendToQueue = (t: Track) => {
    try {
      engine.addToQueue([{
        filePath: t.file_path,
        title: t.title || `Voice Track #${t.id}`,
        artist: `📱 ${t.device_label || "Mobile"}`,
      }]);
      ether.v2g.updateTrack(t.id, { status: "queued" }).then(load);
    } catch (e) {
      console.error("[VoiceTrackInbox] addToQueue failed:", e);
    }
  };

  const archive = async (t: Track) => {
    await ether.v2g.updateTrack(t.id, { status: "archived" });
    load();
  };

  const reactivate = async (t: Track) => {
    await ether.v2g.updateTrack(t.id, { status: "uploaded" });
    load();
  };

  const deleteTrack = async (t: Track) => {
    if (!confirm(`Delete "${t.title || "Untitled"}"? The audio file will be removed from disk.`)) return;
    await ether.v2g.deleteTrack(t.id);
    load();
  };

  const counts = {
    all:      tracks.length,
    uploaded: tracks.filter(t => t.status === "uploaded").length,
    queued:   tracks.filter(t => t.status === "queued").length,
    played:   tracks.filter(t => t.status === "played").length,
    archived: tracks.filter(t => t.status === "archived").length,
  };

  return (
    <div style={{ padding: 24, color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em" }}>Voice Track Inbox</h1>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
            Voice tracks recorded on Ether2Go mobile devices and uploaded here
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={load} style={btnStyle}>↻ Refresh</button>
          {onClose && <button onClick={onClose} style={btnStyle}>Close</button>}
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
        {(["all","uploaded","queued","played","archived"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "6px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600,
            background: filter === f ? "var(--accent-blue)" : "var(--bg-secondary)",
            color:      filter === f ? "#fff" : "var(--text-secondary)",
            border: filter === f ? "none" : "1px solid var(--border-primary)",
            cursor: "pointer", textTransform: "capitalize" as any,
          }}>{f} ({counts[f]})</button>
        ))}
      </div>

      {loading && tracks.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center" as any, color: "var(--text-tertiary)" }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center" as any, background: "var(--bg-secondary)", border: "1px dashed var(--border-primary)" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>No voice tracks {filter !== "all" ? `with status "${filter}"` : "yet"}</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
            Pair a phone in <b>Settings → Pair Mobile App</b>, then open Ether2Go on the phone<br/>
            and tap the record button to send a voice track here.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(t => (
            <div key={t.id} style={{
              background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
              padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>{t.title || `Untitled #${t.id}`}</span>
                    <span style={{
                      padding: "2px 7px", fontSize: 10, fontWeight: 700, letterSpacing: "0.04em",
                      background: STATUS_COLOR[t.status] + "22", color: STATUS_COLOR[t.status],
                      textTransform: "uppercase" as any,
                    }}>{t.status}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", display: "flex", gap: 10, flexWrap: "wrap" as any }}>
                    <span>📱 {t.device_label || "Mobile"}</span>
                    <span>{fmtMs(t.duration_ms)}</span>
                    <span>{fmtBytes(t.size_bytes)}</span>
                    <span>{fmtAgo(t.uploaded_at)}</span>
                  </div>
                  {t.notes && (
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4, fontStyle: "italic" }}>{t.notes}</div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => setPlaying(playing === t.id ? null : t.id)} style={miniBtn}>
                    {playing === t.id ? "Hide" : "▶ Play"}
                  </button>
                  {t.status !== "queued" && t.status !== "played" && (
                    <button onClick={() => sendToQueue(t)} style={{ ...miniBtn, background: "var(--accent-blue)", color: "#fff", border: "none" }}>
                      → Queue
                    </button>
                  )}
                  {t.status === "archived" ? (
                    <button onClick={() => reactivate(t)} style={miniBtn}>↺ Restore</button>
                  ) : (
                    <button onClick={() => archive(t)} style={miniBtn}>Archive</button>
                  )}
                  <button onClick={() => deleteTrack(t)} style={{ ...miniBtn, color: "#ef4444" }}>Del</button>
                </div>
              </div>
              {playing === t.id && (
                // Use file:// URL to load the local audio. Electron renderer can play this.
                <audio
                  src={"file:///" + t.file_path.replace(/\\/g, "/")}
                  controls
                  autoPlay
                  style={{ width: "100%" }}
                  onError={() => alert("Playback failed — file may have been moved or deleted")}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
const miniBtn: React.CSSProperties = {
  padding: "4px 10px", borderRadius: 0, fontSize: 11, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
