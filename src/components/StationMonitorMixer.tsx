// src/components/StationMonitorMixer.tsx
// Per-station LOCAL monitor mixer. Each station is a collapsible strip with its own monitor
// fader (what you HEAR on the local speakers) + output device. The monitor fader drives the
// native per-station monitor gain, which affects ONLY the local output — every station keeps
// broadcasting to Icecast at full air level regardless of where you set these. So you can pull
// the stations you're not running down to 0 and hear only the one you are, in real-time, without
// touching anybody's broadcast. Replaces the old single Audio-Routing dropdown + Current Routing.

import { useState, useEffect, useCallback } from "react";
import { query } from "../db/client";
import { useStreamStatus } from "../contexts/StreamStatusContext";

interface Station { id: number; name: string; }

const selectStyle: React.CSSProperties = {
  width: "100%", background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", fontSize: 12, padding: "3px 6px", borderRadius: 0,
  cursor: "pointer", outline: "none",
};

export default function StationMonitorMixer() {
  const { dests } = useStreamStatus();
  const [stations, setStations] = useState<Station[]>([]);
  const [devices,  setDevices]  = useState<string[]>([]);
  const [vol, setVol] = useState<Record<number, number>>({});
  const [dev, setDev] = useState<Record<number, string>>({});
  const [open, setOpen] = useState<Record<number, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("ether_monitor_open") || "{}"); } catch { return {}; }
  });

  // Load stations + each station's saved monitor level / output device, and APPLY them on launch
  // (so the operator's mix is restored, not reset to unity every start).
  useEffect(() => {
    (async () => {
      const ether = (window as any).ether;
      try {
        const stns: Station[] = await ether.stations.list();
        setStations(stns);
        const v: Record<number, number> = {}, d: Record<number, string> = {};
        await Promise.all(stns.map(async (s) => {
          const rows = await query<{ key: string; value: string }>(
            "SELECT key, value FROM station_config_kv WHERE station_id=? AND key IN ('monitor_volume','audio_output_device')", [s.id]);
          const mv = rows.find(r => r.key === "monitor_volume")?.value;
          const od = rows.find(r => r.key === "audio_output_device")?.value;
          v[s.id] = mv != null && mv !== "" ? Math.max(0, Math.min(1, parseFloat(mv))) : 1;
          d[s.id] = od ?? "";
          try { await ether.audio.setMonitorVolume(s.id, v[s.id]); } catch {}
          if (od) { try { await ether.audio.setOutputDevice(s.id, od); } catch {} }
        }));
        setVol(v); setDev(d);
        const devs = await ether.audio.listOutputDevices();
        setDevices(Array.isArray(devs) ? devs : []);
      } catch (e) { console.warn("[StationMonitorMixer] init:", e); }
    })();
  }, []);

  useEffect(() => { try { localStorage.setItem("ether_monitor_open", JSON.stringify(open)); } catch {} }, [open]);

  const setMonitor = useCallback((sid: number, value: number) => {
    setVol(prev => ({ ...prev, [sid]: value }));
    (window as any).ether?.audio?.setMonitorVolume?.(sid, value);
    (window as any).ether?.stationConfigKv?.upsertByKey?.(sid, "monitor_volume", String(value));
  }, []);

  const setDevice = useCallback((sid: number, device: string) => {
    setDev(prev => ({ ...prev, [sid]: device }));
    (window as any).ether?.audio?.setOutputDevice?.(sid, device);
    (window as any).ether?.stationConfigKv?.upsertByKey?.(sid, "audio_output_device", device);
  }, []);

  return (
    <div style={{ borderTop: "1px solid var(--border-primary)", flexShrink: 0 }}>
      <div style={{ padding: "5px 10px", background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-secondary)", textTransform: "uppercase" }}>Station Monitors</span>
      </div>

      {stations.length === 0 ? (
        <div style={{ padding: "6px 12px", fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No stations</div>
      ) : stations.map((s) => {
        const isOpen = open[s.id] !== false; // default expanded
        const v = vol[s.id] ?? 1;
        const live = dests[`icecast:${s.id}`]?.state === "live";
        const muted = v <= 0.001;
        return (
          <div key={s.id} style={{ borderBottom: "1px solid var(--border-primary)" }}>
            {/* Strip header — name + on-air dot + collapse chevron */}
            <div
              onClick={() => setOpen(o => ({ ...o, [s.id]: !isOpen }))}
              style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", cursor: "pointer", userSelect: "none" }}
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                style={{ color: "var(--text-secondary)", transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", flexShrink: 0 }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                background: live ? "var(--status-live, #ef4444)" : "var(--status-offline, #555)",
                boxShadow: live ? "0 0 6px var(--status-live, #ef4444)" : "none" }} title={live ? "ON AIR" : "off air"} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
              <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: muted ? "var(--text-tertiary)" : "var(--accent-teal)" }}>
                {muted ? "MUTE" : Math.round(v * 100)}
              </span>
            </div>

            {isOpen && (
              <div style={{ padding: "0 12px 9px", display: "flex", flexDirection: "column", gap: 7 }}>
                {/* Monitor fader (local speakers only) */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", width: 52, flexShrink: 0 }}>Monitor</span>
                  <input
                    type="range" min={0} max={1} step={0.01} value={v}
                    onChange={e => setMonitor(s.id, parseFloat(e.target.value))}
                    style={{ flex: 1, accentColor: "var(--accent-teal)", cursor: "pointer" }}
                    title="Local speaker level for this station — does NOT affect its broadcast"
                  />
                </div>
                {/* Output device */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", width: 52, flexShrink: 0 }}>Output</span>
                  <select value={dev[s.id] ?? ""} onChange={e => setDevice(s.id, e.target.value)} style={selectStyle}>
                    <option value="">System Default</option>
                    {devices.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div style={{ padding: "5px 12px 7px", fontSize: 10, color: "var(--text-tertiary)", fontStyle: "italic", lineHeight: 1.5 }}>
        Monitor levels are what you hear locally — broadcasts are unaffected.
      </div>
    </div>
  );
}
