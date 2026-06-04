/**
 * StationManager.tsx — Manage Stations panel (operator tier).
 * Opened via "Manage Stations..." in the header switcher dropdown.
 * Uses ether.stations.* IPC (never raw SQL) so the safety gate is respected.
 */

import { useState, useEffect, useCallback } from "react";
import { query } from "../db/client";

interface Station {
  id:                 number;
  name:               string;
  callsign?:          string;
  frequency?:         string;
  city?:              string;
  state?:             string;
  icecast_server_url?: string;
  icecast_mount?:      string;
  icecast_password?:   string;
  icecast_bitrate?:    number;
  icecast_format?:     string;
  is_active:          number;
  created_at:         number;
}

interface StationStats {
  song_count:  number;
  clock_count: number;
}

interface Props {
  onStationSwitch?: (id: number, name: string) => void;
}

function fmtDate(epoch: number) {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─── Station row ──────────────────────────────────────────────

function StationRow({
  station, stats, onEdit, onDelete,
}: {
  station:  Station;
  stats:    StationStats;
  onEdit:   (s: Station) => void;
  onDelete: (id: number) => void;
}) {
  const isActive = !!station.is_active;

  return (
    <tr style={{ borderBottom: "1px solid var(--border-primary)" }}>
      <td style={{ padding: "10px 14px", verticalAlign: "middle" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {isActive && (
            <span style={{
              fontSize: 8, fontWeight: 900, color: "#22c55e",
              letterSpacing: "0.06em", padding: "1px 5px",
              border: "1px solid rgba(34,197,94,0.3)",
              background: "rgba(34,197,94,0.1)", flexShrink: 0,
            }}>●</span>
          )}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{station.name}</div>
            {(station.callsign || station.frequency) && (
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "monospace", marginTop: 1 }}>
                {[station.callsign, station.frequency, station.city].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
        </div>
      </td>
      <td style={{ padding: "10px 14px", verticalAlign: "middle", fontSize: 12, color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
        {fmtDate(station.created_at)}
      </td>
      <td style={{ padding: "10px 14px", verticalAlign: "middle", fontSize: 12, color: "var(--text-tertiary)" }}>
        {stats.song_count} songs · {stats.clock_count} clocks
      </td>
      <td style={{ padding: "10px 14px", verticalAlign: "middle" }}>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button onClick={() => onEdit(station)} style={actionBtn}>Rename</button>
          <button
            title="Duplicate station — coming soon"
            disabled
            style={{ ...actionBtn, opacity: 0.35, cursor: "not-allowed" }}
          >Duplicate</button>
          <button
            onClick={() => onDelete(station.id)}
            disabled={isActive}
            title={isActive ? "Cannot delete the active station" : `Delete ${station.name}`}
            style={{
              ...actionBtn,
              color: isActive ? "var(--text-tertiary)" : "#f87171",
              opacity: isActive ? 0.35 : 1,
              cursor: isActive ? "not-allowed" : "pointer",
            }}
          >Delete</button>
        </div>
      </td>
    </tr>
  );
}

// ─── Editor modal ─────────────────────────────────────────────

function StationEditor({
  station, onSave, onClose,
}: {
  station: Partial<Station> | null;
  onSave:  (data: Partial<Station>) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm]   = useState<Partial<Station>>(station || {
    name: "", callsign: "", frequency: "", city: "",
    icecast_server_url: "", icecast_mount: "/live",
    icecast_password: "", icecast_bitrate: 128, icecast_format: "mp3",
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  const set = <K extends keyof Station>(k: K, v: Station[K]) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    if (!form.name?.trim()) { setError("Name is required"); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
    } catch (e: any) {
      setError(e?.message || "Failed to save");
      setSaving(false);
    }
  };

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ width: 480, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,0.5)" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-primary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
            {station?.id ? `Edit — ${station.name}` : "New Station"}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ padding: 20 }}>
          {error && (
            <div style={{ marginBottom: 14, padding: "9px 12px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171", fontSize: 12 }}>{error}</div>
          )}

          <EF label="Station Name *">
            <input autoFocus value={form.name || ""} onChange={e => set("name", e.target.value)}
              onKeyDown={e => e.key === "Enter" && save()}
              placeholder="KETH Radio" style={inp} />
          </EF>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <EF label="Callsign"><input value={form.callsign || ""} onChange={e => set("callsign", e.target.value)} placeholder="KETH" style={inp} /></EF>
            <EF label="Frequency"><input value={form.frequency || ""} onChange={e => set("frequency", e.target.value)} placeholder="98.7 FM" style={inp} /></EF>
          </div>
          <EF label="City"><input value={form.city || ""} onChange={e => set("city", e.target.value)} placeholder="Las Vegas" style={inp} /></EF>

          <div style={{ borderTop: "1px solid var(--border-primary)", margin: "14px 0 12px", paddingTop: 4 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", marginBottom: 8 }}>ICECAST</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <EF label="Server URL"><input value={form.icecast_server_url || ""} onChange={e => set("icecast_server_url", e.target.value)} placeholder="127.0.0.1" style={inp} /></EF>
            <EF label="Mount"><input value={form.icecast_mount || ""} onChange={e => set("icecast_mount", e.target.value)} placeholder="/live" style={inp} /></EF>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <EF label="Password"><input value={form.icecast_password || ""} onChange={e => set("icecast_password", e.target.value)} placeholder="hackme" type="password" style={inp} /></EF>
            <EF label="Bitrate">
              <select value={form.icecast_bitrate || 128} onChange={e => set("icecast_bitrate", parseInt(e.target.value))} style={{ ...inp, background: "var(--bg-tertiary)", colorScheme: "dark" }}>
                {[64,96,128,192,256,320].map(b => <option key={b} value={b}>{b} kbps</option>)}
              </select>
            </EF>
            <EF label="Format">
              <select value={form.icecast_format || "mp3"} onChange={e => set("icecast_format", e.target.value)} style={{ ...inp, background: "var(--bg-tertiary)", colorScheme: "dark" }}>
                <option value="mp3">MP3</option>
                <option value="aac">AAC</option>
                <option value="ogg">OGG</option>
              </select>
            </EF>
          </div>
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border-primary)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={cancelBtn}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ ...cancelBtn, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Saving…" : station?.id ? "Save Changes" : "Create Station"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────

export default function StationManager({ onStationSwitch }: Props) {
  const ether = (window as any).ether;
  const [stations,  setStations]  = useState<Station[]>([]);
  const [stats,     setStats]     = useState<Record<number, StationStats>>({});
  const [loading,   setLoading]   = useState(true);
  const [editing,   setEditing]   = useState<Partial<Station> | null | false>(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await ether.stations.list();
      if (!Array.isArray(list)) return;
      setStations(list);

      const map: Record<number, StationStats> = {};
      for (const s of list as Station[]) {
        const [sc, cc] = await Promise.all([
          query<{ c: number }>(`SELECT COUNT(*) as c FROM songs WHERE station_id = ${s.id} OR station_id IS NULL`),
          query<{ c: number }>(`SELECT COUNT(*) as c FROM clocks WHERE station_id = ${s.id} OR station_id IS NULL`),
        ]);
        map[s.id] = { song_count: sc[0]?.c ?? 0, clock_count: cc[0]?.c ?? 0 };
      }
      setStats(map);
    } catch (e) { console.error("[StationManager]", e); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveStation = async (data: Partial<Station>) => {
    if (data.id) {
      const r = await ether.stations.update(data.id, data);
      if (!r?.ok) throw new Error(r?.error || "Update failed");
      if (data.is_active) onStationSwitch?.(data.id, data.name!);
    } else {
      const r = await ether.stations.create(data);
      if (!r?.ok) throw new Error(r?.error || "Create failed");
    }
    setEditing(false);
    load();
  };

  const deleteStation = async (id: number) => {
    const s = stations.find(x => x.id === id);
    if (!confirm(
      `Delete station "${s?.name}"?\n\nAll station-scoped data (schedules, logs, library associations) will be permanently removed. This cannot be undone.`
    )) return;
    const r = await ether.stations.delete(id);
    if (!r?.ok) {
      console.error("[StationManager] delete failed:", r?.error);
    }
    await load();
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--text-tertiary)", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ width: 16, height: 16, border: "2px solid var(--border-primary)", borderTopColor: "#6040c0", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
        Loading stations…
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--bg-primary)" }}>

      {/* Header */}
      <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-secondary)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "#a78bfa", textTransform: "uppercase", marginBottom: 2 }}>Enterprise</div>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)" }}>Station Manager</div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
            {stations.length} station{stations.length !== 1 ? "s" : ""} · {stations.find(s => s.is_active)?.name ?? "none"} active
          </div>
        </div>
        <button
          onClick={() => setEditing({})}
          style={{ padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "#a78bfa", color: "#000", border: "none", cursor: "pointer" }}
        >
          + Add Station
        </button>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
        {stations.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 24px", color: "var(--text-tertiary)" }}>
            <div style={{ fontSize: 28, marginBottom: 12 }}>📻</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>No stations yet</div>
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
                {["Station", "Created", "Library", "Actions"].map(h => (
                  <th key={h} style={{ padding: "8px 14px", textAlign: h === "Actions" ? "right" : "left", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stations.map(s => (
                <StationRow
                  key={s.id}
                  station={s}
                  stats={stats[s.id] ?? { song_count: 0, clock_count: 0 }}
                  onEdit={st => setEditing(st)}
                  onDelete={deleteStation}
                />
              ))}
            </tbody>
          </table>
        )}


      </div>

      {editing !== false && (
        <StationEditor
          station={editing}
          onSave={saveStation}
          onClose={() => setEditing(false)}
        />
      )}

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: "100%", padding: "7px 9px", borderRadius: 0, fontSize: 13,
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", outline: "none", boxSizing: "border-box",
};

const cancelBtn: React.CSSProperties = {
  padding: "7px 16px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};

const actionBtn: React.CSSProperties = {
  padding: "4px 10px", borderRadius: 0, fontSize: 11, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};

function EF({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 4, letterSpacing: "0.07em", textTransform: "uppercase" }}>{label}</div>
      {children}
    </div>
  );
}
