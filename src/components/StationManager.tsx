/**
 * StationManager.tsx
 * Ether Technologies — Multi-Station Console (Station plan)
 *
 * Manages multiple station profiles within one Ether install.
 * Each station has its own: name, branding color, music library,
 * format clocks, scheduling, audio routing, and stream settings.
 *
 * All data lives in one SQLite DB, namespaced by station_id.
 * Switching stations updates the active context and reloads all panels.
 */

import { useState, useEffect, useCallback } from "react";
import { query, execute } from "../db/client";

// ─── Types ────────────────────────────────────────────────────

interface Station {
  id:          number;
  name:        string;
  short_name:  string;
  color:       string;
  frequency:   string | null;
  format:      string | null;
  stream_url:  string | null;
  is_active:   boolean;
  created_at:  number;
}

interface StationStats {
  song_count:     number;
  clock_count:    number;
  last_scheduled: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────

const COLORS = ["#38bdf8","#a78bfa","#34d399","#f87171","#fbbf24","#fb923c","#e879f9","#22d3ee"];

function fmtDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─── Station Card ─────────────────────────────────────────────

function StationCard({
  station, stats, isActive, onSwitch, onEdit, onDelete,
}: {
  station:  Station;
  stats:    StationStats;
  isActive: boolean;
  onSwitch: (id: number) => void;
  onEdit:   (s: Station) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <div style={{
      background: isActive ? station.color + "08" : "var(--bg-secondary)",
      border: `1px solid ${isActive ? station.color + "40" : "var(--border-primary)"}`,
      borderRadius: 0, overflow: "hidden",
      boxShadow: isActive ? `0 0 0 2px ${station.color}25` : "none",
      transition: "all 0.15s",
    }}>
      {/* Header stripe */}
      <div style={{ height: 4, background: station.color }} />

      <div style={{ padding: "16px 18px" }}>
        {/* Station identity */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
          <div style={{
            width: 46, height: 46, borderRadius: 0, flexShrink: 0,
            background: station.color + "20",
            border: `1px solid ${station.color}35`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "'Syne', sans-serif", fontSize: 14, fontWeight: 800,
            color: station.color,
          }}>
            {station.short_name.slice(0, 3).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.02em", marginBottom: 2 }}>{station.name}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {station.frequency && (
                <span style={{ fontSize: 9, fontWeight: 700, color: station.color, background: station.color + "15", borderRadius: 0, padding: "1px 7px", border: `1px solid ${station.color}30` }}>{station.frequency}</span>
              )}
              {station.format && (
                <span style={{ fontSize: 9, color: "var(--text-tertiary)", background: "var(--bg-tertiary)", borderRadius: 0, padding: "1px 7px", border: "1px solid var(--border-primary)" }}>{station.format}</span>
              )}
            </div>
          </div>
          {isActive && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 0, background: station.color + "15", border: `1px solid ${station.color}30`, flexShrink: 0 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: station.color, animation: "pulse-dot 1.5s ease-in-out infinite" }} />
              <span style={{ fontSize: 9, fontWeight: 800, color: station.color, letterSpacing: "0.1em" }}>ACTIVE</span>
            </div>
          )}
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 14 }}>
          {[
            { label: "Songs",    value: stats.song_count },
            { label: "Clocks",   value: stats.clock_count },
            { label: "Created",  value: fmtDate(station.created_at) },
          ].map(s => (
            <div key={s.label} style={{ background: "var(--bg-tertiary)", borderRadius: 0, padding: "8px 10px", border: "1px solid var(--border-primary)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)", fontFamily: s.label === "Songs" || s.label === "Clocks" ? "'DM Mono', monospace" : undefined }}>{s.value}</div>
              <div style={{ fontSize: 8, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 1 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Stream URL */}
        {station.stream_url && (
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", background: "var(--bg-tertiary)", borderRadius: 0, padding: "5px 9px", marginBottom: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            📡 {station.stream_url}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 6 }}>
          {!isActive && (
            <button onClick={() => onSwitch(station.id)} style={{
              flex: 1, padding: "8px", borderRadius: 0, fontSize: 11, fontWeight: 700,
              background: station.color, color: "#000", border: "none", cursor: "pointer",
              transition: "all 0.15s",
            }}>
              Switch to Station
            </button>
          )}
          {isActive && (
            <div style={{ flex: 1, padding: "8px", borderRadius: 0, fontSize: 11, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", textAlign: "center" }}>
              Currently Active
            </div>
          )}
          <button onClick={() => onEdit(station)} style={{ padding: "8px 12px", borderRadius: 0, fontSize: 11, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>✏️</button>
          {!isActive && (
            <button onClick={() => onDelete(station.id)} style={{ padding: "8px 12px", borderRadius: 0, fontSize: 11, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
            >🗑</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Station Editor Modal ─────────────────────────────────────

function StationEditor({
  station, onSave, onClose,
}: {
  station: Partial<Station> | null;
  onSave:  (data: Partial<Station>) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Partial<Station>>(station || {
    name: "", short_name: "", color: COLORS[0], frequency: "", format: "", stream_url: "",
  });

  const set = (k: keyof Station, v: any) => setForm(p => ({ ...p, [k]: v }));

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        width: 480, background: "#0d0d18",
        border: "1px solid rgba(255,255,255,0.1)", borderRadius: 0,
        overflow: "hidden",
        boxShadow: "0 40px 100px rgba(0,0,0,0.6)",
      }}>
        {/* Header stripe */}
        <div style={{ height: 4, background: form.color || COLORS[0] }} />

        <div style={{ padding: "24px 28px" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text-primary)", marginBottom: 20, fontFamily: "'Syne', sans-serif" }}>
            {station?.id ? "Edit Station" : "Add New Station"}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Name */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 5, letterSpacing: "0.08em", textTransform: "uppercase" }}>Station Name *</div>
              <input value={form.name || ""} onChange={e => set("name", e.target.value)} placeholder="KETH Radio" style={{ width: "100%", padding: "9px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" }} />
            </div>

            {/* Short name + Frequency */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 5, letterSpacing: "0.08em", textTransform: "uppercase" }}>Short Name / Call Sign *</div>
                <input value={form.short_name || ""} onChange={e => set("short_name", e.target.value)} placeholder="KETH" maxLength={6} style={{ width: "100%", padding: "9px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box", fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }} />
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 5, letterSpacing: "0.08em", textTransform: "uppercase" }}>Frequency</div>
                <input value={form.frequency || ""} onChange={e => set("frequency", e.target.value)} placeholder="98.7 FM" style={{ width: "100%", padding: "9px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" }} />
              </div>
            </div>

            {/* Format */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 5, letterSpacing: "0.08em", textTransform: "uppercase" }}>Format</div>
              <select value={form.format || ""} onChange={e => set("format", e.target.value)} style={{ width: "100%", padding: "9px 12px", borderRadius: 0, fontSize: 13, background: "#1a1a2e", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", colorScheme: "dark", boxSizing: "border-box" }}>
                <option value="">Select format...</option>
                {["Adult Contemporary","CHR / Top 40","Country","Rock","Classic Rock","Hip-Hop / R&B","Jazz","Classical","News/Talk","Sports","Religious","Easy Listening","Electronic/Dance","Alternative","Oldies","Latin"].map(f => (
                  <option key={f} value={f} style={{ background: "#1a1a2e" }}>{f}</option>
                ))}
              </select>
            </div>

            {/* Stream URL */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 5, letterSpacing: "0.08em", textTransform: "uppercase" }}>Stream URL (Icecast)</div>
              <input value={form.stream_url || ""} onChange={e => set("stream_url", e.target.value)} placeholder="http://icecast.example.com:8000/stream" style={{ width: "100%", padding: "9px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box", fontFamily: "'DM Mono', monospace" }} />
            </div>

            {/* Color */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 8, letterSpacing: "0.08em", textTransform: "uppercase" }}>Station Color</div>
              <div style={{ display: "flex", gap: 8 }}>
                {COLORS.map(c => (
                  <button key={c} onClick={() => set("color", c)} style={{
                    width: 28, height: 28, borderRadius: "50%", border: "none", cursor: "pointer",
                    background: c,
                    boxShadow: form.color === c ? `0 0 0 3px #000, 0 0 0 5px ${c}` : "none",
                    transition: "all 0.1s",
                    transform: form.color === c ? "scale(1.15)" : "scale(1)",
                  }} />
                ))}
              </div>
            </div>
          </div>

          {/* Buttons */}
          <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
            <button onClick={onClose} style={{ flex: 1, padding: "10px", borderRadius: 0, fontSize: 12, background: "transparent", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
            <button onClick={() => {
              if (!form.name?.trim() || !form.short_name?.trim()) return alert("Name and call sign are required.");
              onSave(form);
            }} style={{ flex: 2, padding: "10px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: form.color || COLORS[0], color: "#000", border: "none", cursor: "pointer" }}>
              {station?.id ? "Save Changes" : "Create Station"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────

interface Props {
  onStationSwitch?: (stationId: number, stationName: string) => void;
}

export default function StationManager({ onStationSwitch }: Props) {
  const [stations, setStations]       = useState<Station[]>([]);
  const [stats, setStats]             = useState<Record<number, StationStats>>({});
  const [activeId, setActiveId]       = useState<number | null>(null);
  const [loading, setLoading]         = useState(true);
  const [editing, setEditing]         = useState<Partial<Station> | null | false>(false);
  const [switching, setSwitching]     = useState<number | null>(null);

  // ── Init DB schema ─────────────────────────────────────────

  const initSchema = useCallback(async () => {
    await execute(`CREATE TABLE IF NOT EXISTS stations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      short_name  TEXT NOT NULL,
      color       TEXT DEFAULT '#38bdf8',
      frequency   TEXT,
      format      TEXT,
      stream_url  TEXT,
      is_active   INTEGER DEFAULT 0,
      created_at  INTEGER DEFAULT (strftime('%s','now'))
    )`).catch(() => {});

    // Ensure active_station_id exists in config
    await execute(`INSERT OR IGNORE INTO station_config_kv (key, value) VALUES ('active_station_id', '1')`).catch(() => {});
  }, []);

  // ── Load ───────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await initSchema();

      const rows = await query<Station>("SELECT * FROM stations ORDER BY id");

      // If no stations exist, create default from current config
      if (rows.length === 0) {
        const nameRows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'station_name'");
        const defaultName = nameRows[0]?.value || "My Station";
        await execute(
          "INSERT INTO stations (name, short_name, color, is_active) VALUES (?, ?, ?, 1)",
          [defaultName, defaultName.slice(0, 4).toUpperCase(), "#38bdf8"]
        );
        const newRows = await query<Station>("SELECT * FROM stations ORDER BY id");
        setStations(newRows);
      } else {
        setStations(rows);
      }

      // Get active station
      const activeRows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'active_station_id'");
      const activeId = parseInt(activeRows[0]?.value || "1");
      setActiveId(activeId);

      // Load stats for each station
      const statsMap: Record<number, StationStats> = {};
      for (const s of rows.length > 0 ? rows : await query<Station>("SELECT * FROM stations ORDER BY id")) {
        const [songCount, clockCount, lastSched] = await Promise.all([
          query<{ c: number }>(`SELECT COUNT(*) as c FROM songs WHERE station_id = ${s.id} OR station_id IS NULL`),
          query<{ c: number }>(`SELECT COUNT(*) as c FROM clocks WHERE station_id = ${s.id} OR station_id IS NULL`),
          query<{ d: string }>(`SELECT MAX(log_date) as d FROM scheduled_log WHERE station_id = ${s.id} OR station_id IS NULL`),
        ]);
        statsMap[s.id] = {
          song_count:     songCount[0]?.c ?? 0,
          clock_count:    clockCount[0]?.c ?? 0,
          last_scheduled: lastSched[0]?.d ?? null,
        };
      }
      setStats(statsMap);
    } catch (e) {
      console.error("[StationManager] load error:", e);
    }
    setLoading(false);
  }, [initSchema]);

  useEffect(() => { load(); }, [load]);

  // ── Switch station ─────────────────────────────────────────

  const switchStation = async (id: number) => {
    setSwitching(id);
    try {
      // Update active flag
      await execute("UPDATE stations SET is_active = 0");
      await execute("UPDATE stations SET is_active = 1 WHERE id = ?", [id]);
      await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('active_station_id', ?)", [String(id)]);

      // Update station_name to match
      const station = stations.find(s => s.id === id);
      if (station) {
        await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('station_name', ?)", [station.name]);
        onStationSwitch?.(id, station.name);
      }

      setActiveId(id);
    } catch (e) {
      console.error("[StationManager] switch error:", e);
    }
    setSwitching(null);
  };

  // ── Save station ───────────────────────────────────────────

  const saveStation = async (data: Partial<Station>) => {
    try {
      if (data.id) {
        await execute(
          "UPDATE stations SET name=?, short_name=?, color=?, frequency=?, format=?, stream_url=? WHERE id=?",
          [data.name, data.short_name, data.color, data.frequency || null, data.format || null, data.stream_url || null, data.id]
        );
      } else {
        await execute(
          "INSERT INTO stations (name, short_name, color, frequency, format, stream_url) VALUES (?,?,?,?,?,?)",
          [data.name, data.short_name, data.color || COLORS[0], data.frequency || null, data.format || null, data.stream_url || null]
        );
      }
      setEditing(false);
      load();
    } catch (e: any) {
      alert("Failed to save station: " + e.message);
    }
  };

  // ── Delete station ─────────────────────────────────────────

  const deleteStation = async (id: number) => {
    if (!confirm("Delete this station? Its music library and clocks will remain in the database but unassigned.")) return;
    await execute("DELETE FROM stations WHERE id = ?", [id]);
    load();
  };

  // ─── Render ──────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--text-tertiary)", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid var(--border-primary)", borderTopColor: "var(--accent-cyan)", animation: "spin 0.7s linear infinite" }} />
        Loading stations...
        <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--bg-primary)" }}>

      {/* Header */}
      <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-secondary)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "#a78bfa", textTransform: "uppercase", marginBottom: 2 }}>Station Plan</div>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>Station Manager</div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
            {stations.length} station{stations.length !== 1 ? "s" : ""} configured · {stations.find(s => s.id === activeId)?.name || "None"} active
          </div>
        </div>
        <button
          onClick={() => setEditing({})}
          style={{ padding: "9px 20px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "#a78bfa", color: "#fff", border: "none", cursor: "pointer", boxShadow: "0 0 20px rgba(167,139,250,0.3)" }}
        >
          + Add Station
        </button>
      </div>

      {/* Station grid */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
        {stations.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 24px", color: "var(--text-tertiary)" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📻</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>No stations yet</div>
            <div style={{ fontSize: 12 }}>Click "Add Station" to create your first station profile.</div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
            {stations.map(station => (
              <div key={station.id} style={{ opacity: switching === station.id ? 0.6 : 1, transition: "opacity 0.2s" }}>
                <StationCard
                  station={station}
                  stats={stats[station.id] ?? { song_count: 0, clock_count: 0, last_scheduled: null }}
                  isActive={station.id === activeId}
                  onSwitch={switchStation}
                  onEdit={s => setEditing(s)}
                  onDelete={deleteStation}
                />
              </div>
            ))}

            {/* Add station card */}
            <button
              onClick={() => setEditing({})}
              style={{
                background: "transparent",
                border: "2px dashed var(--border-primary)",
                borderRadius: 0, padding: "32px 24px",
                cursor: "pointer", color: "var(--text-tertiary)",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
                transition: "all 0.15s", minHeight: 200,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#a78bfa"; (e.currentTarget as HTMLElement).style.color = "#a78bfa"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-primary)"; (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
            >
              <div style={{ fontSize: 28 }}>+</div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Add Station</div>
            </button>
          </div>
        )}

        {/* Remote console link */}
        <div style={{ marginTop: 24, padding: "16px 18px", borderRadius: 0, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 24, flexShrink: 0 }}>🌐</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 3 }}>Remote Web Console</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
              View all stations' now-playing status and send commands from anywhere.
              Available at your Railway dashboard URL.
            </div>
          </div>
          <button
            onClick={async () => {
              try {
                const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
                await invoke("open_url", { url: "https://ether-backend-production.up.railway.app/console" });
              } catch { window.open("https://ether-backend-production.up.railway.app/console", "_blank"); }
            }}
            style={{ padding: "8px 16px", borderRadius: 0, fontSize: 11, fontWeight: 700, background: "rgba(167,139,250,0.12)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.25)", cursor: "pointer", flexShrink: 0 }}
          >
            Open Console ↗
          </button>
        </div>
      </div>

      {/* Editor modal */}
      {editing !== false && (
        <StationEditor
          station={editing || null}
          onSave={saveStation}
          onClose={() => setEditing(false)}
        />
      )}

      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
    </div>
  );
}
