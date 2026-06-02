// src/components/AudioRoutingPanel.tsx
// Per-station audio output device routing — Phase A Piece 2.
// AudioRoutingPicker: station + device dropdowns + Apply button.
// CurrentRoutingSummary: read-only list of current assignments.

import { useState, useEffect, useCallback } from "react";
import { query } from "../db/client";

const TEAL = "#00c8a8";

interface Station { id: number; name: string; }
interface RoutingRow { stationId: number; stationName: string; deviceName: string; }

const selectStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-primary)",
  border: "1px solid var(--border-primary)",
  color: "var(--text-primary)",
  fontSize: 9,
  padding: "4px 6px",
  borderRadius: 0,
  cursor: "pointer",
  outline: "none",
};

function SectionChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="8" height="8" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
      style={{
        color: "var(--text-secondary)",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.15s",
        flexShrink: 0,
      }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function SectionHeader({ title, open, onToggle }: { title: string; open: boolean; onToggle: () => void }) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "5px 10px", cursor: "pointer", flexShrink: 0,
        background: "var(--bg-tertiary)",
        borderBottom: "1px solid var(--border-primary)",
        userSelect: "none" as const,
      }}
    >
      <SectionChevron open={open} />
      <span style={{
        fontSize: 7, fontWeight: 700, letterSpacing: "0.12em",
        color: "var(--text-secondary)", textTransform: "uppercase" as const,
      }}>{title}</span>
    </div>
  );
}

// ── AudioRoutingPicker ────────────────────────────────────────

export function AudioRoutingPicker({ onApplied }: { onApplied: () => void }) {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("ether_routing_picker_collapsed") !== "1"; } catch { return true; }
  });
  const [stations, setStations] = useState<Station[]>([]);
  const [devices,  setDevices]  = useState<string[]>([]);
  const [selectedStation, setSelectedStation] = useState<number | null>(null);
  const [selectedDevice,  setSelectedDevice]  = useState("");
  const [applying,   setApplying]   = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  useEffect(() => {
    try { localStorage.setItem("ether_routing_picker_collapsed", open ? "0" : "1"); } catch {}
  }, [open]);

  // Mount: load stations, apply all saved devices (startup restore), load device list
  useEffect(() => {
    (async () => {
      try {
        const ether = (window as any).ether;

        const stns: Station[] = await ether.stations.list();
        setStations(stns);

        // Startup: apply saved device for every station
        await Promise.all(stns.map(async (s: Station) => {
          try {
            const rows = await query<{ value: string }>(
              "SELECT value FROM station_config_kv WHERE station_id=? AND key='audio_output_device'",
              [s.id]
            );
            const dev = rows[0]?.value;
            if (dev) await ether.audio.setOutputDevice(s.id, dev);
          } catch {}
        }));

        if (stns.length > 0) setSelectedStation(stns[0].id);

        const devs = await ether.audio.listOutputDevices();
        setDevices(Array.isArray(devs) ? devs : []);
      } catch (e) {
        console.warn("[AudioRoutingPicker] init error:", e);
      }
    })();
  }, []);

  // Load saved device for the currently selected station
  useEffect(() => {
    if (selectedStation === null) return;
    query<{ value: string }>(
      "SELECT value FROM station_config_kv WHERE station_id=? AND key='audio_output_device'",
      [selectedStation]
    ).then(rows => setSelectedDevice(rows[0]?.value ?? "")).catch(() => {});
  }, [selectedStation]);

  const handleApply = useCallback(async () => {
    if (selectedStation === null) return;
    console.log("[AudioRouting] Apply clicked", { selectedStation, selectedDevice });
    setApplying(true);
    try {
      await (window as any).ether.stationConfigKv.upsertByKey(selectedStation, 'audio_output_device', selectedDevice);
      console.log("[AudioRouting] DB write OK, calling setOutputDevice");
      const result = await (window as any).ether.audio.setOutputDevice(selectedStation, selectedDevice);
      console.log("[AudioRouting] setOutputDevice returned:", result);
      setSuccessMsg("✓ Routing updated");
      setTimeout(() => setSuccessMsg(""), 3000);
      onApplied();
    } catch (e) {
      console.error("[AudioRoutingPicker] apply error:", e);
    }
    setApplying(false);
  }, [selectedStation, selectedDevice, onApplied]);

  return (
    <div style={{ borderTop: "1px solid var(--border-primary)", flexShrink: 0 }}>
      <SectionHeader title="Audio Routing" open={open} onToggle={() => setOpen(o => !o)} />
      {open && (
        <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>

          {/* Station picker */}
          <div>
            <div style={{ fontSize: 7, color: "var(--text-secondary)", letterSpacing: "0.1em", marginBottom: 4, textTransform: "uppercase" as const, opacity: 0.7 }}>Station</div>
            <select
              value={selectedStation ?? ""}
              onChange={e => setSelectedStation(Number(e.target.value))}
              style={selectStyle}
            >
              {stations.length === 0 && <option value="">Loading…</option>}
              {stations.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          {/* Device picker */}
          <div>
            <div style={{ fontSize: 7, color: "var(--text-secondary)", letterSpacing: "0.1em", marginBottom: 4, textTransform: "uppercase" as const, opacity: 0.7 }}>Output Device</div>
            <select
              value={selectedDevice}
              onChange={e => setSelectedDevice(e.target.value)}
              style={selectStyle}
            >
              <option value="">System Default</option>
              {devices.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          {/* Apply row */}
          <div style={{ fontSize: 8, color: "var(--text-secondary)", opacity: 0.6, fontStyle: "italic" }}>
            Note: changing device may restart the current track.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={handleApply}
              disabled={applying || selectedStation === null}
              style={{
                padding: "5px 14px", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
                background: applying ? "var(--bg-tertiary)" : `${TEAL}22`,
                border: `1px solid ${applying ? "var(--border-primary)" : TEAL}`,
                color: applying ? "var(--text-secondary)" : TEAL,
                cursor: applying ? "default" : "pointer",
                transition: "all 0.15s", borderRadius: 0,
                opacity: selectedStation === null ? 0.5 : 1,
              }}
            >{applying ? "APPLYING…" : "APPLY"}</button>
            {successMsg && (
              <span style={{ fontSize: 9, color: TEAL, fontWeight: 600 }}>{successMsg}</span>
            )}
          </div>

        </div>
      )}
    </div>
  );
}

// ── CurrentRoutingSummary ─────────────────────────────────────

export function CurrentRoutingSummary({ refreshKey }: { refreshKey: number }) {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("ether_routing_summary_collapsed") !== "1"; } catch { return true; }
  });
  const [rows, setRows] = useState<RoutingRow[]>([]);

  useEffect(() => {
    try { localStorage.setItem("ether_routing_summary_collapsed", open ? "0" : "1"); } catch {}
  }, [open]);

  useEffect(() => {
    (async () => {
      try {
        const stns: Station[] = await (window as any).ether.stations.list();
        const result: RoutingRow[] = await Promise.all(
          stns.map(async (s: Station) => {
            const dbRows = await query<{ value: string }>(
              "SELECT value FROM station_config_kv WHERE station_id=? AND key='audio_output_device'",
              [s.id]
            );
            return {
              stationId: s.id,
              stationName: s.name,
              deviceName: dbRows[0]?.value || "System Default",
            };
          })
        );
        setRows(result);
      } catch (e) {
        console.warn("[CurrentRoutingSummary] load error:", e);
      }
    })();
  }, [refreshKey]);

  return (
    <div style={{ borderTop: "1px solid var(--border-primary)", flexShrink: 0 }}>
      <SectionHeader title="Current Routing" open={open} onToggle={() => setOpen(o => !o)} />
      {open && (
        <div style={{ padding: "4px 0 6px" }}>
          {rows.length === 0 ? (
            <div style={{ padding: "4px 12px", fontSize: 9, color: "var(--text-tertiary)", fontStyle: "italic" }}>
              No stations configured
            </div>
          ) : rows.map(r => (
            <div key={r.stationId} style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "3px 12px",
            }}>
              <span style={{ fontSize: 9, fontWeight: 600, color: "var(--text-secondary)", flexShrink: 0 }}>{r.stationName}</span>
              <span style={{ fontSize: 9, color: "var(--text-tertiary)", flexShrink: 0 }}>→</span>
              <span style={{
                fontSize: 9, color: r.deviceName === "System Default" ? "var(--text-tertiary)" : "var(--text-primary)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
                fontStyle: r.deviceName === "System Default" ? "italic" : "normal",
              }}>{r.deviceName}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── AudioRoutingScreen ────────────────────────────────────────
// Full-screen view for panel === "multioutput" ("Multi-Output Audio Routing"). Replaces the retired
// MultiOutputPanel.tsx (which called the orphaned, unregistered IPC name `list_audio_output_devices`).
// Composes the working, mode-agnostic picker + summary — both backed by audio:listOutputDevices /
// audio:setOutputDevice, which function in BOTH daemon and in-process modes. The backed routing model
// is per-station output device (the per-deck model in the old panel had no backend).

export default function AudioRoutingScreen() {
  const [refresh, setRefresh] = useState(0);
  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "28px 20px" }}>
      <h2 style={{ fontSize: 16, fontWeight: 800, letterSpacing: "0.04em", color: "var(--text-primary)", textTransform: "uppercase" as const, margin: 0 }}>
        Multi-Output Audio Routing
      </h2>
      <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "6px 0 18px", lineHeight: 1.5 }}>
        Assign each station's playout to a specific audio output device. Applies live — works whether
        Ether is running the out-of-process engine or the in-process fallback.
      </p>
      <div style={{ border: "1px solid var(--border-primary)", background: "var(--bg-secondary)" }}>
        <AudioRoutingPicker onApplied={() => setRefresh(k => k + 1)} />
        <CurrentRoutingSummary refreshKey={refresh} />
      </div>
    </div>
  );
}
