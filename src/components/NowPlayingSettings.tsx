import React, { useState, useEffect } from "react";
import { getStationTimezone, setStationTimezone, COMMON_TIMEZONES } from "../utils/timezone";
import { query, execute } from "../db/client";

export default function NowPlayingSettings() {
  const [dashboardUrl, setDashboardUrl] = React.useState("");

  React.useEffect(() => {
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string>("get_local_ip").then(ip => {
        setDashboardUrl("http://" + ip + ":4242");
      }).catch(() => setDashboardUrl("http://localhost:4242"));
    });
  }, []);
  const [igHandle, setIgHandle] = useState("");
  const [igEnabled, setIgEnabled] = useState(false);
  const [saved, setSaved] = useState(false);
  const [timezone, setTimezone] = useState("");

  useEffect(() => {
    getStationTimezone().then(setTimezone);
  }, []);

  const saveTimezone = async (tz: string) => {
    setTimezone(tz);
    await setStationTimezone(tz);
  };
  const [autostart, setAutostart] = useState(false);

  useEffect(() => {
    import("@tauri-apps/plugin-autostart").then(({ isEnabled }) => {
      isEnabled().then(setAutostart).catch(() => {});
    }).catch(() => {});
  }, []);

  const toggleAutostart = async () => {
    try {
      if (autostart) {
        const { disable } = await import("@tauri-apps/plugin-autostart");
        await disable();
        setAutostart(false);
      } else {
        const { enable } = await import("@tauri-apps/plugin-autostart");
        await enable();
        setAutostart(true);
      }
    } catch (e) { console.error("Autostart error:", e); }
  };

  useEffect(() => {
    (async () => {
      try {
        const rows = await query<{key:string,value:string}>("SELECT key, value FROM station_config_kv WHERE key IN ('ig_handle','ig_enabled')");
        for (const r of rows) {
          if (r.key === 'ig_handle') setIgHandle(r.value);
          if (r.key === 'ig_enabled') setIgEnabled(r.value === '1');
        }
      } catch {}
    })();
  }, []);

  const save = async () => {
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('ig_handle', ?)", [igHandle]);
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('ig_enabled', ?)", [igEnabled ? '1' : '0']);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ padding: "0 0 20px" }}>
      <div style={{ background: "var(--bg-tertiary)", borderRadius: 10, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>📱 Mobile Dashboard</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 10 }}>Open this URL on any phone or tablet on the same WiFi network to remotely control playback:</div>
        {dashboardUrl && (
          <div style={{ background: "var(--bg-secondary)", borderRadius: 8, padding: "10px 14px", fontFamily: "monospace", fontSize: 14, color: "var(--accent-blue)", letterSpacing: "0.02em", wordBreak: "break-all" as any }}>
            {dashboardUrl}
          </div>
        )}
      </div>
      <div style={{ background: "var(--bg-tertiary)", borderRadius: 10, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>🌐 Public Now Playing Endpoint</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 10 }}>
          Your station website can poll this URL to show what's playing:
        </div>
        {dashboardUrl && (
          <div style={{ background: "var(--bg-secondary)", borderRadius: 8, padding: "10px 14px", fontFamily: "monospace", fontSize: 13, color: "var(--accent-green)", letterSpacing: "0.02em" }}>
            {dashboardUrl.replace(":4242", ":4242")}/now-playing.json
          </div>
        )}
        <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 8 }}>
          Returns: title, artist, is_playing, updated_at — CORS enabled for cross-origin requests
        </div>
      </div>
      <div style={{ background: "var(--bg-tertiary)", borderRadius: 10, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>🚀 Launch on Windows Startup</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 12 }}>
          Automatically start Ether when Windows boots. Recommended for 24/7 stations.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            onClick={toggleAutostart}
            style={{
              width: 36, height: 20, borderRadius: 10, cursor: "pointer", transition: "background 0.2s",
              background: autostart ? "var(--accent-blue)" : "var(--bg-secondary)",
              border: "1px solid var(--border-primary)", position: "relative", flexShrink: 0
            }}
          >
            <div style={{
              position: "absolute", top: 2, left: autostart ? 18 : 2,
              width: 14, height: 14, borderRadius: 7, background: "#fff", transition: "left 0.2s"
            }} />
          </div>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {autostart ? "Ether will launch on startup" : "Launch on startup disabled"}
          </span>
        </div>
      </div>
      <div style={{ background: "var(--bg-tertiary)", borderRadius: 10, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>🕐 Station Timezone</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 10 }}>
          Used for schedule times, DST handling, and play log timestamps.
        </div>
        <select value={timezone} onChange={e => saveTimezone(e.target.value)}
          style={{ width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 13, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }}>
          {COMMON_TIMEZONES.map(tz => (
            <option key={tz.value} value={tz.value}>{tz.label} — {tz.value}</option>
          ))}
        </select>
        <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 8 }}>
          Current time in this zone: {timezone ? new Date().toLocaleTimeString('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : "—"}
        </div>
      </div>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.06em" }}>Now Playing Screen</h3>

      <div style={{ background: "var(--bg-tertiary)", borderRadius: 10, padding: 16, border: "1px solid var(--border-primary)" }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 8 }}>Instagram Feed</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 12 }}>
          Shows in the Now Playing window when no ads are configured. Enter a profile (@handle) or hashtag (#tag).
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            value={igHandle}
            onChange={e => setIgHandle(e.target.value)}
            placeholder="@opportunityvillage or #ovlasvegas"
            style={{ flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div
            onClick={() => setIgEnabled(!igEnabled)}
            style={{
              width: 36, height: 20, borderRadius: 10, cursor: "pointer", transition: "background 0.2s",
              background: igEnabled ? "var(--accent-blue)" : "var(--bg-secondary)",
              border: "1px solid var(--border-primary)", position: "relative"
            }}
          >
            <div style={{
              position: "absolute", top: 2, left: igEnabled ? 18 : 2,
              width: 14, height: 14, borderRadius: 7, background: "#fff", transition: "left 0.2s"
            }} />
          </div>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Enable Instagram feed</span>
        </div>

        <button
          onClick={save}
          style={{ padding: "8px 20px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: saved ? "var(--accent-green)" : "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", transition: "background 0.3s" }}
        >{saved ? "Saved!" : "Save"}</button>
      </div>
    </div>
  );
}
