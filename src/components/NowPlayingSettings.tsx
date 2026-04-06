import React, { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { getStationTimezone, setStationTimezone, COMMON_TIMEZONES } from "../utils/timezone";
import { query, execute } from "../db/client";

type WidgetType = "sponsor" | "instagram" | "weather" | "twitter";

const WIDGET_ICONS: Record<WidgetType, JSX.Element> = {
  sponsor: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>,
  instagram: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>,
  weather: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>,
  twitter: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>,
};

const WIDGETS: { id: WidgetType; label: string; desc: string; badge?: string }[] = [
  { id: "sponsor", label: "Sponsor Display", desc: "Rotating sponsor/ad images" },
  { id: "instagram", label: "Instagram", desc: "Live Instagram feed or hashtag" },
  { id: "weather", label: "Weather", desc: "Current conditions for your city" },
  { id: "twitter", label: "X / Twitter", desc: "Live tweet ticker", badge: "PRO SOON" },
];

export default function NowPlayingSettings() {
  const [dashboardUrl, setDashboardUrl] = React.useState("");
  const [igHandle, setIgHandle] = useState("");
  const [igEnabled, setIgEnabled] = useState(false);
  const [saved, setSaved] = useState(false);
  const [timezone, setTimezone] = useState("");
  const [autostart, setAutostart] = useState(false);
  const [widgetType, setWidgetType] = useState<WidgetType>("sponsor");
  const [weatherCity, setWeatherCity] = useState("Las Vegas");
  const [weatherLat, setWeatherLat] = useState("36.1699");
  const [weatherLon, setWeatherLon] = useState("-115.1398");

  React.useEffect(() => {
    const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
    invoke<string>("get_local_ip").then(ip => setDashboardUrl("http://" + ip + ":4242")).catch(() => setDashboardUrl("http://localhost:4242"));
  }, []);

  useEffect(() => { getStationTimezone().then(setTimezone); }, []);

  const saveTimezone = async (tz: string) => { setTimezone(tz); await setStationTimezone(tz); };

  useEffect(() => {
    const isEnabled = () => (window as any).ether.autostart.isEnabled();
    isEnabled().then(setAutostart).catch(() => {});
  }, []);

  const toggleAutostart = async () => {
    try {
      if (autostart) { await (window as any).ether.autostart.disable(); setAutostart(false); }
      else { await (window as any).ether.autostart.enable(); setAutostart(true); }
    } catch (e) { console.error("Autostart error:", e); }
  };

  useEffect(() => {
    (async () => {
      try {
        const rows = await query<{ key: string; value: string }>(
          "SELECT key, value FROM station_config_kv WHERE key IN ('ig_handle','ig_enabled','now_playing_widget','weather_city','weather_lat','weather_lon')"
        );
        for (const r of rows) {
          if (r.key === "ig_handle") setIgHandle(r.value);
          if (r.key === "ig_enabled") setIgEnabled(r.value === "1");
          if (r.key === "now_playing_widget") setWidgetType((r.value as WidgetType) || "sponsor");
          if (r.key === "weather_city") setWeatherCity(r.value);
          if (r.key === "weather_lat") setWeatherLat(r.value);
          if (r.key === "weather_lon") setWeatherLon(r.value);
        }
      } catch {}
    })();
  }, []);

  const save = async () => {
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('ig_handle', ?)", [igHandle]);
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('ig_enabled', ?)", [igEnabled ? "1" : "0"]);
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('now_playing_widget', ?)", [widgetType]);
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('weather_city', ?)", [weatherCity]);
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('weather_lat', ?)", [weatherLat]);
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('weather_lon', ?)", [weatherLon]);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ padding: "0 0 20px" }}>

      <div style={{ background: "var(--bg-tertiary)", borderRadius: 0, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></svg>
          Mobile Dashboard</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 10 }}>Open on any phone or tablet on the same WiFi to remotely control playback:</div>
        {dashboardUrl && <div style={{ background: "var(--bg-secondary)", borderRadius: 0, padding: "10px 14px", fontFamily: "monospace", fontSize: 14, color: "var(--accent-blue)", letterSpacing: "0.02em", wordBreak: "break-all" as any }}>{dashboardUrl}</div>}
      </div>

      <div style={{ background: "var(--bg-tertiary)", borderRadius: 0, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          Public Now Playing Endpoint</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 10 }}>Your station website can poll this URL to show what's playing:</div>
        {dashboardUrl && <div style={{ background: "var(--bg-secondary)", borderRadius: 0, padding: "10px 14px", fontFamily: "monospace", fontSize: 13, color: "var(--accent-green)", letterSpacing: "0.02em" }}>{dashboardUrl}/now-playing.json</div>}
        <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 8 }}>Returns: title, artist, is_playing, updated_at — CORS enabled</div>
      </div>

      <div style={{ background: "var(--bg-tertiary)", borderRadius: 0, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          Launch on Windows Startup</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 12 }}>Automatically start Ether when Windows boots. Recommended for 24/7 stations.</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div onClick={toggleAutostart} style={{ width: 36, height: 20, borderRadius: 0, cursor: "pointer", transition: "background 0.2s", background: autostart ? "var(--accent-blue)" : "var(--bg-secondary)", border: "1px solid var(--border-primary)", position: "relative", flexShrink: 0 }}>
            <div style={{ position: "absolute", top: 2, left: autostart ? 18 : 2, width: 14, height: 14, borderRadius: 0, background: "#fff", transition: "left 0.2s" }} />
          </div>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{autostart ? "Ether will launch on startup" : "Launch on startup disabled"}</span>
        </div>
      </div>

      <div style={{ background: "var(--bg-tertiary)", borderRadius: 0, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 24 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Station Timezone</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 10 }}>Used for schedule times, DST handling, and play log timestamps.</div>
        <select value={timezone} onChange={e => saveTimezone(e.target.value)} style={{ width: "100%", padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }}>
          {COMMON_TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label} — {tz.value}</option>)}
        </select>
        <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 8 }}>
          Current: {timezone ? new Date().toLocaleTimeString("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : "—"}
        </div>
      </div>

      {/* Widget selector */}
      <h3 style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 14, textTransform: "uppercase" as const, letterSpacing: "0.14em" }}>Now Playing Screen — Right Panel</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 20 }}>
        {WIDGETS.map(w => (
          <div key={w.id} onClick={() => setWidgetType(w.id)} style={{
            padding: "14px 16px", borderRadius: 0, cursor: "pointer", position: "relative" as const,
            background: widgetType === w.id ? "rgba(34,211,238,0.08)" : "var(--bg-tertiary)",
            border: `1px solid ${widgetType === w.id ? "rgba(34,211,238,0.35)" : "var(--border-primary)"}`,
            transition: "all 0.15s ease",
          }}>
            {w.badge && <div style={{ position: "absolute" as const, top: 8, right: 8, fontSize: 8, fontWeight: 700, background: "rgba(167,139,250,0.15)", color: "#a78bfa", padding: "2px 6px", borderRadius: 0 }}>{w.badge}</div>}
            <div style={{ marginBottom: 6, color: widgetType === w.id ? "var(--accent-blue)" : "var(--text-tertiary)" }}>{WIDGET_ICONS[w.id]}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: widgetType === w.id ? "var(--accent-blue)" : "var(--text-primary)", marginBottom: 2 }}>{w.label}</div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{w.desc}</div>
          </div>
        ))}
      </div>

      {widgetType === "instagram" && (
        <div style={{ background: "var(--bg-tertiary)", borderRadius: 0, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 8 }}>Instagram Handle</div>
          <input value={igHandle} onChange={e => setIgHandle(e.target.value)} placeholder="@yourstation or #yourhashtag" style={{ width: "100%", padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", marginBottom: 10, boxSizing: "border-box" as const }} />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div onClick={() => setIgEnabled(!igEnabled)} style={{ width: 36, height: 20, borderRadius: 0, cursor: "pointer", transition: "background 0.2s", background: igEnabled ? "var(--accent-blue)" : "var(--bg-secondary)", border: "1px solid var(--border-primary)", position: "relative" }}>
              <div style={{ position: "absolute", top: 2, left: igEnabled ? 18 : 2, width: 14, height: 14, borderRadius: 0, background: "#fff", transition: "left 0.2s" }} />
            </div>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Enable Instagram feed</span>
          </div>
        </div>
      )}

      {widgetType === "weather" && (
        <div style={{ background: "var(--bg-tertiary)", borderRadius: 0, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 12 }}>Weather Location</div>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
            <input value={weatherCity} onChange={e => setWeatherCity(e.target.value)} placeholder="City name" style={{ padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }} />
            <div style={{ display: "flex", gap: 8 }}>
              <input value={weatherLat} onChange={e => setWeatherLat(e.target.value)} placeholder="Latitude" style={{ flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }} />
              <input value={weatherLon} onChange={e => setWeatherLon(e.target.value)} placeholder="Longitude" style={{ flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }} />
            </div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>Las Vegas default: 36.1699, -115.1398 · Powered by Open-Meteo (free, no API key needed)</div>
          </div>
        </div>
      )}

      <button onClick={save} style={{ padding: "10px 24px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: saved ? "var(--accent-green)" : "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", transition: "background 0.3s" }}>
        {saved ? "✓ Saved!" : "Save Settings"}
      </button>
    </div>
  );
}
