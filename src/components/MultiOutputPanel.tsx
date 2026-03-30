/**
 * MultiOutputPanel.tsx
 * Ether Technologies — Multi-Output Audio Routing (Pro feature)
 *
 * Lets you assign each deck (A/B/C) to a different physical audio output.
 * E.g. Deck A → ASIO Broadcast, Deck B → WASAPI Headphones, Monitor → Cue Mix
 *
 * Routing is saved to station_config_kv and restored on startup.
 */

import { useState, useEffect } from "react";
const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
import { query, execute } from "../db/client";
import { usePlan } from "../hooks/usePlan";

// ─── Types ────────────────────────────────────────────────────

interface AudioDevice {
  name:        string;
  host:        string;
  is_default:  boolean;
  channels:    number;
  sample_rate: number;
  is_asio:     boolean;
}

interface DeckRouting {
  deck_a:  string | null;
  deck_b:  string | null;
  deck_c:  string | null;
  monitor: string | null;
  master:  string | null;
}

// ─── Helpers ──────────────────────────────────────────────────

const DECK_LABELS: Record<string, { label: string; sub: string; color: string; emoji: string }> = {
  A:       { label: "Deck A",   sub: "Primary playback deck",         color: "#38bdf8", emoji: "🎵" },
  B:       { label: "Deck B",   sub: "Secondary / crossfade deck",    color: "#a78bfa", emoji: "🎶" },
  C:       { label: "Deck C",   sub: "Cart / jingle deck",            color: "#34d399", emoji: "🔔" },
  MONITOR: { label: "Monitor",  sub: "Headphone cue mix",             color: "#fbbf24", emoji: "🎧" },
  MASTER:  { label: "Master",   sub: "Broadcast / main output",       color: "#f87171", emoji: "📡" },
};

function hostBadgeColor(host: string) {
  if (host.toUpperCase().includes("ASIO"))      return { bg: "rgba(167,139,250,0.15)", color: "#a78bfa", border: "rgba(167,139,250,0.3)" };
  if (host.toUpperCase().includes("WASAPI"))    return { bg: "rgba(56,189,248,0.1)",  color: "#38bdf8", border: "rgba(56,189,248,0.25)" };
  if (host.toUpperCase().includes("COREAUDIO")) return { bg: "rgba(52,211,153,0.1)",  color: "#34d399", border: "rgba(52,211,153,0.25)" };
  return { bg: "rgba(255,255,255,0.05)", color: "var(--text-tertiary)", border: "var(--border-primary)" };
}

// ─── Device Selector ──────────────────────────────────────────

function DeviceSelector({
  value, devices, onChange, color,
}: {
  value:    string | null;
  devices:  AudioDevice[];
  onChange: (name: string | null) => void;
  color:    string;
}) {
  const selected = devices.find(d => d.name === value);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <select
        value={value ?? "__default__"}
        onChange={e => onChange(e.target.value === "__default__" ? null : e.target.value)}
        style={{
          width: "100%", padding: "9px 12px", borderRadius: 9,
          fontSize: 12, fontWeight: 600,
          background: "#1a1a2e",
          border: `1px solid ${value ? color + "55" : "rgba(255,255,255,0.12)"}`,
          color: "#f0f0f8", outline: "none", cursor: "pointer",
          colorScheme: "dark",
        }}
      >
        <option value="__default__" style={{ background: "#1a1a2e" }}>
          ⬡ System Default
        </option>
        {devices.map(d => (
          <option key={`${d.host}::${d.name}`} value={d.name} style={{ background: "#1a1a2e" }}>
            {d.is_asio ? "⚡ " : ""}{d.name} ({d.host})
          </option>
        ))}
      </select>

      {selected && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 4 }}>
          {(() => {
            const badge = hostBadgeColor(selected.host);
            return (
              <span style={{ fontSize: 8, fontWeight: 800, padding: "2px 7px", borderRadius: 4, background: badge.bg, color: badge.color, border: `1px solid ${badge.border}`, letterSpacing: "0.1em" }}>
                {selected.host}
              </span>
            );
          })()}
          <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>
            {selected.channels}ch · {(selected.sample_rate / 1000).toFixed(1)}kHz
          </span>
          {selected.is_default && (
            <span style={{ fontSize: 8, color: "var(--text-tertiary)", opacity: 0.6 }}>default</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────

export default function MultiOutputPanel() {
  const { isPro } = usePlan();
  const [devices, setDevices]   = useState<AudioDevice[]>([]);
  const [routing, setRouting]   = useState<DeckRouting>({ deck_a: null, deck_b: null, deck_c: null, monitor: null, master: null });
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  // Load devices and saved routing on mount
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // Load devices from Rust
        const devs = await invoke<AudioDevice[]>("list_audio_output_devices");
        setDevices(devs);

        // Load saved routing from SQLite
        const rows = await query<{ value: string }>(
          "SELECT value FROM station_config_kv WHERE key = 'audio_routing'"
        );
        if (rows[0]?.value) {
          try { setRouting(JSON.parse(rows[0].value)); } catch {}
        }
      } catch (e: any) {
        setError("Could not list audio devices: " + e.message);
      }
      setLoading(false);
    })();
  }, []);

  const rescanDevices = async () => {
    setScanning(true);
    try {
      const devs = await invoke<AudioDevice[]>("list_audio_output_devices");
      setDevices(devs);
    } catch (e: any) {
      setError("Rescan failed: " + e.message);
    }
    setScanning(false);
  };

  const updateRoute = (key: keyof DeckRouting, value: string | null) => {
    setRouting(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const saveRouting = async () => {
    setSaving(true);
    try {
      // Save to SQLite
      await execute(
        "INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('audio_routing', ?)",
        [JSON.stringify(routing)]
      );

      // Apply to Rust routing state
      await invoke("set_deck_output", { deck: "A",       deviceName: routing.deck_a  });
      await invoke("set_deck_output", { deck: "B",       deviceName: routing.deck_b  });
      await invoke("set_deck_output", { deck: "C",       deviceName: routing.deck_c  });
      await invoke("set_deck_output", { deck: "MONITOR", deviceName: routing.monitor });
      await invoke("set_deck_output", { deck: "MASTER",  deviceName: routing.master  });

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) {
      setError("Failed to save routing: " + e.message);
    }
    setSaving(false);
  };

  const resetToDefault = () => {
    setRouting({ deck_a: null, deck_b: null, deck_c: null, monitor: null, master: null });
    setSaved(false);
  };

  // Group devices by host for the info section
  const asioDevices  = devices.filter(d => d.is_asio);
  const wasapiDevices = devices.filter(d => !d.is_asio && d.host.toUpperCase().includes("WASAPI"));
  const otherDevices  = devices.filter(d => !d.is_asio && !d.host.toUpperCase().includes("WASAPI"));

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--text-tertiary)" }}>
        <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid var(--border-primary)", borderTopColor: "var(--accent-cyan)", animation: "spin 0.7s linear infinite" }} />
        <span>Scanning audio devices...</span>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--bg-primary)", overflowY: "auto" }}>

      {/* Header */}
      <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-secondary)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "var(--accent-cyan)", textTransform: "uppercase", marginBottom: 2 }}>Pro Feature</div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>Multi-Output Audio Routing</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>Assign each deck to a different physical audio output</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={rescanDevices} disabled={scanning} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
              {scanning ? "Scanning..." : "↻ Rescan"}
            </button>
            <button onClick={resetToDefault} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: "transparent", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
              Reset
            </button>
            <button onClick={saveRouting} disabled={saving} style={{
              padding: "7px 20px", borderRadius: 8, fontSize: 12, fontWeight: 700,
              background: saved ? "var(--accent-green)" : "var(--accent-cyan)",
              color: "#000", border: "none", cursor: "pointer",
              boxShadow: saved ? "0 0 16px rgba(52,211,153,0.3)" : "0 0 16px rgba(56,189,248,0.3)",
              transition: "all 0.2s",
            }}>
              {saving ? "Saving..." : saved ? "✓ Saved" : "Apply Routing"}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div style={{ margin: "12px 24px 0", padding: "10px 14px", borderRadius: 8, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", fontSize: 12, color: "#f87171", display: "flex", justifyContent: "space-between" }}>
          <span>{error}</span>
          <button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "#f87171", cursor: "pointer" }}>✕</button>
        </div>
      )}

      <div style={{ flex: 1, padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>

        {/* ASIO notice */}
        {asioDevices.length === 0 && (
          <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.15)", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 16 }}>⚡</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa", marginBottom: 2 }}>No ASIO drivers detected</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
                For lowest latency professional output, install ASIO drivers for your audio interface.
                WASAPI devices are available and work well for most broadcast applications.
              </div>
            </div>
          </div>
        )}

        {/* Routing grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {(["A", "B", "C", "MONITOR", "MASTER"] as const).map(deckKey => {
            const meta = DECK_LABELS[deckKey];
            const isSpecial = deckKey === "MONITOR" || deckKey === "MASTER";
            const routingKey = isSpecial ? null : `deck_${deckKey.toLowerCase()}` as keyof DeckRouting;
            const value = deckKey === "MONITOR" ? routing.monitor : deckKey === "MASTER" ? routing.master : routingKey ? routing[routingKey] : null;
            const selectedDevice = devices.find(d => d.name === value);

            return (
              <div key={deckKey} style={{
                background: "var(--bg-secondary)", border: `1px solid ${value ? meta.color + "35" : "var(--border-primary)"}`,
                borderRadius: 14, padding: "16px 18px",
                gridColumn: deckKey === "MASTER" ? "2" : undefined,
              }}>
                {/* Deck header */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <div style={{ width: 34, height: 34, borderRadius: 9, background: meta.color + "18", border: `1px solid ${meta.color}30`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>
                    {meta.emoji}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{meta.label}</div>
                    <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{meta.sub}</div>
                  </div>
                  {value && (
                    <div style={{ marginLeft: "auto", width: 8, height: 8, borderRadius: "50%", background: meta.color, boxShadow: `0 0 8px ${meta.color}` }} />
                  )}
                </div>

                <DeviceSelector
                  value={value ?? null}
                  devices={devices}
                  color={meta.color}
                  onChange={v => {
                    if (deckKey === "MONITOR") updateRoute("monitor", v);
                    else if (deckKey === "MASTER") updateRoute("master", v);
                    else if (routingKey) updateRoute(routingKey, v);
                  }}
                />

                {/* Active device info */}
                {selectedDevice && (
                  <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: meta.color + "08", border: `1px solid ${meta.color}20`, display: "flex", align: "center", gap: 8 }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={meta.color} strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}><polyline points="20 6 9 17 4 12"/></svg>
                    <span style={{ fontSize: 10, color: meta.color, fontWeight: 600 }}>
                      Routing to: {selectedDevice.name}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Device inventory */}
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 14, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>
              Available Devices ({devices.length})
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 1, background: "var(--border-primary)" }}>
            {devices.map(device => {
              const badge = hostBadgeColor(device.host);
              const isUsed = Object.values(routing).includes(device.name);
              return (
                <div key={`${device.host}::${device.name}`} style={{ padding: "10px 14px", background: isUsed ? "rgba(56,189,248,0.04)" : "var(--bg-secondary)", display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
                      {device.is_default && <span style={{ fontSize: 8, color: "var(--accent-cyan)" }}>●</span>}
                      {device.name}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 3, alignItems: "center" }}>
                      <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 6px", borderRadius: 3, background: badge.bg, color: badge.color, border: `1px solid ${badge.border}`, letterSpacing: "0.08em" }}>
                        {device.host}
                      </span>
                      <span style={{ fontSize: 9, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>
                        {device.channels}ch · {(device.sample_rate / 1000).toFixed(1)}kHz
                      </span>
                    </div>
                  </div>
                  {isUsed && (
                    <span style={{ fontSize: 8, fontWeight: 700, color: "var(--accent-cyan)", background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>IN USE</span>
                  )}
                </div>
              );
            })}
            {devices.length === 0 && (
              <div style={{ padding: "24px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 12, gridColumn: "1/-1" }}>
                No output devices found. Check your audio interface connections.
              </div>
            )}
          </div>
        </div>

        {/* Help */}
        <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-primary)", fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.7 }}>
          <strong style={{ color: "var(--text-secondary)" }}>How routing works:</strong> Each deck plays audio through its assigned output device independently.
          Changes take effect on the <em>next track load</em> — currently playing tracks will finish on their current device.
          ASIO devices provide the lowest latency but require dedicated drivers. WASAPI works on all Windows systems.
          Set <strong style={{ color: "var(--text-secondary)" }}>Monitor</strong> to your headphones for cue listening,
          and <strong style={{ color: "var(--text-secondary)" }}>Master</strong> to your broadcast/main output.
        </div>

      </div>
    </div>
  );
}
