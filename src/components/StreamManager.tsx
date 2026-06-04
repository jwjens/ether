import { useState, useEffect, useRef } from "react";
import { query, execute, queryOne } from "../db/client";
const invoke = <T = any>(cmd: string, args?: any): Promise<T> => (window as any).ether.invoke(cmd, args);
const listen = <T = any>(e: string, cb: (ev: { payload: T }) => void): Promise<() => void> => { const h = (window as any).ether.on(e, (p: any) => cb({ payload: p })); return Promise.resolve(() => (window as any).ether.off(e, h)); };

interface StreamSettings {
  server: string; port: number; mount: string; password: string;
  bitrate: number; station_name: string | null; station_genre: string | null;
  station_url: string | null; is_active: number;
}

function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return h + "h " + m + "m";
  return m + "m " + s + "s";
}

export default function StreamManager() {
  const [settings, setSettings] = useState<StreamSettings | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("Disconnected");
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<any>(null);
  const timerRef = useRef<any>(null);
  const startRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const healthRef = useRef<any>(null);

  const load = async () => {
    const row = await queryOne<StreamSettings>("SELECT * FROM stream_settings WHERE id = 1");
    if (row) setSettings(row);
    // Check if already streaming
    try {
      const active = await invoke<boolean>("stream_status");
      setStreaming(active);
      if (active) setStatus("Streaming");
    } catch {}
  };

  useEffect(() => { load(); }, []);

  // Poll stream health when streaming
  useEffect(() => {
    if (!streaming) { setHealth(null); return; }
    healthRef.current = setInterval(async () => {
      try {
        const h = await invoke<any>("stream_health");
        setHealth(h);
      } catch {}
    }, 1000);
    return () => clearInterval(healthRef.current);
  }, [streaming]);

  // Listen for now-playing updates to push metadata to Icecast
  useEffect(() => {
    const unlisten = listen("now-playing-update", async (event: any) => {
      if (streaming && event.payload.isPlaying) {
        try {
          await invoke("stream_update_metadata", {
            title: event.payload.title,
            artist: event.payload.artist,
          });
          // Also push metadata via Icecast admin API
          if (settings) {
            const url = `http://${settings.server}:${settings.port}/admin/metadata?mount=${settings.mount}&mode=updinfo&song=${encodeURIComponent(event.payload.artist + " - " + event.payload.title)}`;
            fetch(url, {
              headers: { "Authorization": "Basic " + btoa("admin:" + settings.password) }
            }).catch(() => {});
          }
        } catch {}
      }
    });
    return () => { unlisten.then(f => f()); };
  }, [streaming, settings]);

  const save = async () => {
    if (!settings) return;
    await execute(
      "UPDATE stream_settings SET server=?, port=?, mount=?, password=?, bitrate=?, station_name=?, station_genre=?, station_url=? WHERE id=1",
      [settings.server, settings.port, settings.mount, settings.password, settings.bitrate, settings.station_name, settings.station_genre, settings.station_url]
    );
    setError("");
    setStatus("Settings saved");
    setTimeout(() => { if (!streaming) setStatus("Disconnected"); }, 2000);
  };

  const startStream = async () => {
    if (!settings) return;
    setError("");
    setStatus("Connecting...");
    try {
      await invoke<void>("stream_start", {
        config: {
          server: settings.server,
          port: settings.port,
          mount: settings.mount,
          password: settings.password,
          bitrate: settings.bitrate,
          station_name: settings.station_name || "",
        }
      });
      setStreaming(true);
      setStatus("Streaming ✓");
      startRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
      await execute("UPDATE stream_settings SET is_active = 1 WHERE id = 1");
    } catch (e) {
      setError("Stream error: " + String(e));
      setStatus("Error");
      setStreaming(false);
    }
  };

  const stopStream = async () => {
    try { await invoke("stream_stop"); } catch {}
    setStreaming(false);
    setStatus("Disconnected");
    setDuration(0);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    await execute("UPDATE stream_settings SET is_active = 0 WHERE id = 1");
  };

  if (!settings) return <div style={{ padding: 20, color: "var(--text-tertiary)" }}>Loading...</div>;

  return (
    <div style={{ maxWidth: 600 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20, color: "var(--text-primary)" }}>Stream Manager</h1>

      {/* Status bar */}
      <div style={{ background: streaming ? "rgba(34,197,94,0.06)" : "var(--bg-secondary)", border: "1px solid " + (streaming ? "rgba(34,197,94,0.25)" : "var(--border-primary)"), borderRadius: 0, padding: "14px 16px", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: health && streaming ? 12 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: streaming ? "#22c55e" : "#666", boxShadow: streaming ? "0 0 8px #22c55e" : "none", transition: "all 0.3s" }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: streaming ? "#22c55e" : "var(--text-secondary)" }}>
              {health?.status === "reconnecting" ? "Reconnecting..." : health?.status === "buffering" ? "Replaying buffer..." : status}
            </span>
          </div>
          {streaming && <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontFamily: "monospace" }}>{fmtDuration(duration)}</span>}
        </div>
        {/* Resilient stream health meters */}
        {health && streaming && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
            {[
              { label: "Status", value: (health.status || "").toUpperCase(), color: health.status === "live" ? "#22c55e" : health.status === "reconnecting" ? "#fbbf24" : "var(--text-secondary)" },
              { label: "Uptime", value: fmtDuration(health.uptimeSecs || 0), color: "var(--text-primary)" },
              { label: "Drops", value: String(health.dropCount ?? 0), color: health.dropCount > 0 ? "#fbbf24" : "#22c55e" },
              { label: "Buffer", value: `${health.bufferSecs || 0}s`, color: "var(--accent-blue)" },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ padding: "8px 10px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" as any, marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color, fontFamily: "monospace" }}>{value}</div>
              </div>
            ))}
          </div>
        )}
        {streaming && (health?.dropCount ?? 0) > 0 && (
          <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 0, background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.2)", fontSize: 11, color: "#fbbf24" }}>
            ⚡ {health.dropCount} reconnect{health.dropCount !== 1 ? "s" : ""} — listeners heard no gap thanks to the replay buffer
          </div>
        )}
      </div>

      {/* Server settings */}
      <div style={{ background: "var(--bg-secondary)", borderRadius: 0, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase" as any, letterSpacing: "0.06em", marginBottom: 12 }}>Icecast / Shoutcast Server</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginBottom: 8 }}>
          <input value={settings.server} onChange={e => setSettings({...settings, server: e.target.value})}
            placeholder="localhost" style={{ padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }} />
          <input value={settings.port} onChange={e => setSettings({...settings, port: parseInt(e.target.value) || 8000})}
            placeholder="8000" style={{ width: 80, padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <input value={settings.mount} onChange={e => setSettings({...settings, mount: e.target.value})}
            placeholder="/stream" style={{ padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }} />
          <input type="password" value={settings.password} onChange={e => setSettings({...settings, password: e.target.value})}
            placeholder="Password" style={{ padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
          <input value={settings.station_name || ""} onChange={e => setSettings({...settings, station_name: e.target.value})}
            placeholder="Station Name" style={{ padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }} />
          <select value={settings.bitrate} onChange={e => setSettings({...settings, bitrate: parseInt(e.target.value)})}
            style={{ padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }}>
            <option value={64}>64 kbps</option>
            <option value={96}>96 kbps</option>
            <option value={128}>128 kbps</option>
            <option value={192}>192 kbps</option>
            <option value={320}>320 kbps</option>
          </select>
        </div>
        <button onClick={save} style={{ padding: "8px 20px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Save Settings</button>
      </div>

      {error && <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444", borderRadius: 0, padding: "10px 14px", fontSize: 12, color: "#ef4444", marginBottom: 12 }}>{error}</div>}

      {/* Stream control */}
      <div style={{ display: "flex", gap: 10 }}>
        {!streaming ? (
          <button onClick={startStream} style={{ flex: 1, padding: "12px", borderRadius: 0, fontSize: 14, fontWeight: 700, background: "#22c55e", color: "#fff", border: "none", cursor: "pointer" }}>
            ▶ Start Streaming
          </button>
        ) : (
          <button onClick={stopStream} style={{ flex: 1, padding: "12px", borderRadius: 0, fontSize: 14, fontWeight: 700, background: "#ef4444", color: "#fff", border: "none", cursor: "pointer" }}>
            ⏹ Stop Streaming
          </button>
        )}
      </div>

      <div style={{ marginTop: 16, fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
        <strong>Setup:</strong> Install Icecast2 on your server. Set the mount point password in Icecast's config.xml. 
        Ether will connect as a source client and push audio. Now Playing metadata updates automatically.
      </div>
    </div>
  );
}
