import { useState, useEffect } from "react";
import { query, execute, queryOne } from "../db/client";

interface Show {
  id: number; name: string; start_hour: number; end_hour: number;
  days: string; color: string | null; description: string | null;
  is_active: number; clock_id: number | null; clock_name: string | null;
}

interface Category {
  id: number; code: string; name: string; color: string | null;
  spins_per_hour: number; priority: number; song_count?: number;
}

interface Clock {
  id: number; name: string; show_id: number | null;
  description: string | null; color: string | null;
}

interface ClockSlot {
  id: number; clock_id: number; position: number;
  slot_type: string; category_id: number | null;
  label: string | null; duration_min: number;
  category_code?: string; category_color?: string;
  song_title?: string | null; song_artist?: string | null;
}

const HOURS = Array.from({length: 24}, (_, i) => i);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SLOT_TYPES = ["music", "spot_break", "liner", "sweeper", "news", "talkset", "jingle"];

function fmtHour(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? h + " AM" : (h - 12) + " PM";
}

export default function Scheduler() {
  const [tab, setTab] = useState<"shows" | "categories" | "clocks">("shows");
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-bold">Show Scheduler</h1>
      <div className="flex gap-1">
        {(["shows", "categories", "clocks"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={tab === t ? "px-3 py-1.5 rounded text-xs font-bold bg-blue-600 text-white" : "px-3 py-1.5 rounded text-xs font-bold bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}
          >{t === "shows" ? "Shows & Dayparts" : t === "categories" ? "Music Categories" : "Format Clocks"}</button>
        ))}
      </div>
      {tab === "shows" && <ShowsTab />}
      {tab === "categories" && <CategoriesTab />}
      {tab === "clocks" && <ClocksTab />}
    </div>
  );
}

// ============================================================
// SHOWS TAB — with clock dropdown
// ============================================================

function ShowsTab() {
  const [shows, setShows] = useState<Show[]>([]);
  const [clocks, setClocks] = useState<Clock[]>([]);
  const [editing, setEditing] = useState<Partial<Show> | null>(null);

  const load = async () => {
    setShows(await query<Show>("SELECT s.*, c.name as clock_name FROM shows s LEFT JOIN clocks c ON c.id = s.clock_id ORDER BY s.start_hour"));
    setClocks(await query<Clock>("SELECT * FROM clocks ORDER BY name"));
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing || !editing.name) return;
    const days = editing.days ?? "0123456";
    const isActive = editing.is_active ?? 1;
    if (editing.id) {
      await execute(
        "UPDATE shows SET name=?, start_hour=?, end_hour=?, color=?, description=?, days=?, is_active=? WHERE id=?",
        [editing.name, editing.start_hour || 0, editing.end_hour || 0, editing.color || null, editing.description || null, days, isActive, editing.id]
      );
    } else {
      await execute(
        "INSERT INTO shows (name, start_hour, end_hour, color, description, days, is_active) VALUES (?,?,?,?,?,?,?)",
        [editing.name, editing.start_hour || 0, editing.end_hour || 0, editing.color || null, editing.description || null, days, isActive]
      );
    }
    setEditing(null); load();
  };

  const assignClock = async (showId: number, clockId: number | null) => {
    await execute("UPDATE shows SET clock_id = ? WHERE id = ?", [clockId, showId]);
    load();
  };

  const remove = async (id: number) => { await execute("DELETE FROM shows WHERE id=?", [id]); load(); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-zinc-300">Shows & Dayparts</h2>
        <button onClick={() => setEditing({ name: "", start_hour: 0, end_hour: 6, color: "#3b82f6" })} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white">+ New Show</button>
      </div>

      {/* Timeline */}
      <div className="bg-zinc-900 rounded-none border border-zinc-800 p-3">
        <div className="text-[10px] text-zinc-500 uppercase mb-1">24-Hour Timeline</div>
        <div className="relative h-10 bg-zinc-800 rounded overflow-hidden flex">
          {HOURS.map(h => (
            <div key={h} className="flex-1 border-r border-zinc-700 relative">
              {h % 6 === 0 && <span className="absolute -top-4 left-0 text-[8px] text-zinc-600">{fmtHour(h)}</span>}
            </div>
          ))}
          {shows.map(s => {
            const start = s.start_hour;
            const end = s.end_hour <= s.start_hour ? s.end_hour + 24 : s.end_hour;
            const width = ((end - start) / 24) * 100;
            const left = (start / 24) * 100;
            return <div key={s.id} className="absolute top-0 h-full flex items-center justify-center text-[9px] font-bold text-white" style={{ left: left + "%", width: Math.min(width, 100 - left) + "%", backgroundColor: s.color || "#444", opacity: 0.8 }}>{s.name}</div>;
          })}
        </div>
      </div>

      {/* Edit form */}
      {editing && (
        <div className="bg-zinc-900 rounded-none border border-zinc-800 p-3 space-y-2">
          <div className="grid grid-cols-4 gap-2">
            <input className="col-span-2 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Show name" value={editing.name || ""} onChange={e => setEditing({...editing, name: e.target.value})} />
            <select className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={editing.start_hour || 0} onChange={e => setEditing({...editing, start_hour: parseInt(e.target.value)})}>
              {HOURS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
            </select>
            <select className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={editing.end_hour || 0} onChange={e => setEditing({...editing, end_hour: parseInt(e.target.value)})}>
              {HOURS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <input type="color" className="h-8 w-full bg-zinc-800 border border-zinc-700 rounded" value={editing.color || "#3b82f6"} onChange={e => setEditing({...editing, color: e.target.value})} />
            <input className="col-span-3 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Description" value={editing.description || ""} onChange={e => setEditing({...editing, description: e.target.value})} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Days:</span>
            {DAYS.map((d, i) => {
              const dayStr = String(i);
              const active = (editing.days ?? "0123456").includes(dayStr);
              return (
                <button key={i} onClick={() => {
                  const cur = editing.days ?? "0123456";
                  const next = active ? cur.replace(dayStr, "") : (cur + dayStr).split("").sort().join("");
                  setEditing({...editing, days: next});
                }} className={`px-2 py-0.5 rounded text-[10px] font-bold ${active ? "bg-blue-600 text-white" : "bg-zinc-700 text-zinc-400"}`}>{d}</button>
              );
            })}
            <label className="ml-3 flex items-center gap-1 text-[10px] text-zinc-400 cursor-pointer">
              <input type="checkbox" checked={(editing.is_active ?? 1) === 1} onChange={e => setEditing({...editing, is_active: e.target.checked ? 1 : 0})} />
              Active
            </label>
          </div>
          <div className="flex gap-2">
            <button onClick={save} className="px-3 py-1 bg-blue-600 rounded text-xs font-bold text-white">Save</button>
            <button onClick={() => setEditing(null)} className="px-3 py-1 bg-zinc-700 rounded text-xs text-zinc-300">Cancel</button>
          </div>
        </div>
      )}

      {/* Show list with clock dropdowns */}
      <div className="space-y-1.5">
        {shows.map(s => (
          <div key={s.id} className="bg-zinc-900 rounded-none border border-zinc-800 p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-4 h-4 rounded-full shrink-0" style={{ backgroundColor: s.color || "#444" }}></div>
                <div>
                  <div className="text-sm text-zinc-100 font-medium">{s.name}</div>
                  <div className="text-[11px] text-zinc-500">{fmtHour(s.start_hour)} - {fmtHour(s.end_hour)}{s.description ? " — " + s.description : ""}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setEditing(s)} className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px] text-zinc-300">Edit</button>
                <button onClick={() => remove(s.id)} className="px-2 py-1 bg-zinc-800 hover:bg-red-900 rounded text-[10px] text-zinc-500 hover:text-red-400">Del</button>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] text-zinc-500">Format Clock:</span>
              <select value={s.clock_id || ""} onChange={e => assignClock(s.id, e.target.value ? parseInt(e.target.value) : null)}
                className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-200">
                <option value="">-- No clock assigned --</option>
                {clocks.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {s.clock_name && <span className="text-[11px] text-emerald-400 font-bold">Active</span>}
            </div>
          </div>
        ))}
        {shows.length === 0 && <div className="text-xs text-zinc-600 italic text-center py-4">No shows yet. Click + New Show to create dayparts.</div>}
      </div>
    </div>
  );
}

// ============================================================
// CATEGORIES TAB
// ============================================================

function CategoriesTab() {
  const [cats, setCats] = useState<Category[]>([]);
  const [editing, setEditing] = useState<Partial<Category> | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState("");
  const [saveError, setSaveError] = useState("");

  const load = async () => {
    const rows = await query<Category & { song_count: number }>("SELECT c.*, (SELECT COUNT(*) FROM songs WHERE category_id = c.id) as song_count FROM categories c ORDER BY c.code");
    setCats(rows);
  };
  useEffect(() => { load(); }, []);

  const scanDurations = async () => {
    setScanning(true);
    setScanStatus("Finding songs...");
    try {
      const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
      const songs = await query<{ id: number; file_path: string; title: string }>(
        "SELECT id, file_path, title FROM songs WHERE duration_ms IS NULL OR duration_ms < 1000"
      );
      if (songs.length === 0) { setScanStatus("✓ All songs have duration data"); setScanning(false); return; }
      setScanStatus(`Scanning ${songs.length} songs...`);
      let fixed = 0; let failed = 0;
      for (let i = 0; i < songs.length; i++) {
        const song = songs[i];
        try {
          // Rust command takes native file path, returns seconds as f64
          const durSec = await invoke<number>("get_file_duration", { filePath: song.file_path });
          const durMs = Math.round(durSec * 1000);
          if (durMs > 1000) {
            await execute("UPDATE songs SET duration_ms=? WHERE id=?", [durMs, song.id]);
            fixed++;
          } else { failed++; }
        } catch { failed++; }
        if (i % 5 === 0) setScanStatus(`Scanning... ${i+1}/${songs.length} (${fixed} fixed, ${failed} failed)`);
      }
      setScanStatus(`✓ Done — ${fixed} updated, ${failed} failed`);
    } catch (e) {
      setScanStatus(`✗ Error: ${e}`);
    }
    setScanning(false);
  };

  const save = async () => {
    if (!editing || !editing.code) return;
    setSaveError("");
    try {
      if (editing.id) {
        await execute("UPDATE categories SET code=?, name=?, color=?, spins_per_hour=?, priority=? WHERE id=?",
          [editing.code, editing.name || editing.code, editing.color || null, editing.spins_per_hour || 0, editing.priority || 0, editing.id]);
      } else {
        await execute("INSERT INTO categories (code, name, color, spins_per_hour, priority) VALUES (?,?,?,?,?)",
          [editing.code, editing.name || editing.code, editing.color || null, editing.spins_per_hour || 0, editing.priority || 0]);
      }
      setEditing(null); load();
    } catch (e: any) {
      setSaveError(e?.message || "Save failed");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-zinc-300">Rotation Categories</h2>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {scanStatus && <span style={{ fontSize: 10, color: scanStatus.startsWith("✓") ? "#34d399" : scanStatus.startsWith("✗") ? "#ef4444" : "#94a3b8" }}>{scanStatus}</span>}
          <button
            onClick={scanDurations}
            disabled={scanning}
            style={{ padding: "4px 10px", borderRadius: 0, fontSize: 11, fontWeight: 700, cursor: scanning ? "default" : "pointer", background: "rgba(251,191,36,0.12)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)", opacity: scanning ? 0.6 : 1 }}
          >
            {scanning ? "Scanning..." : "⏱ Scan Durations"}
          </button>
          <button onClick={() => setEditing({ code: "", name: "", color: "#3b82f6", spins_per_hour: 0, priority: 0 })} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white">+ New Category</button>
        </div>
      </div>
      <div className="text-xs text-zinc-500 bg-zinc-900 rounded p-2 border border-zinc-800">
        <strong>How rotation works:</strong> A = Power Current (heavy rotation, newest hits). B = Secondary (medium rotation). C = Recurrent (familiar favorites). D = Gold (classic library).
      </div>
      {editing && (
        <div className="bg-zinc-900 rounded-none border border-zinc-800 p-3 space-y-2">
          <div className="grid grid-cols-5 gap-2">
            <input className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Code (A)" value={editing.code || ""} onChange={e => setEditing({...editing, code: e.target.value})} />
            <input className="col-span-2 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Name" value={editing.name || ""} onChange={e => setEditing({...editing, name: e.target.value})} />
            <input type="number" className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Spins/hr" value={editing.spins_per_hour || ""} onChange={e => setEditing({...editing, spins_per_hour: parseInt(e.target.value) || 0})} />
            <input type="color" className="h-8 w-full bg-zinc-800 border border-zinc-700 rounded" value={editing.color || "#3b82f6"} onChange={e => setEditing({...editing, color: e.target.value})} />
          </div>
          <div className="flex items-center gap-2">
            <button onClick={save} className="px-3 py-1 bg-blue-600 rounded text-xs font-bold text-white">Save</button>
            <button onClick={() => { setEditing(null); setSaveError(""); }} className="px-3 py-1 bg-zinc-700 rounded text-xs text-zinc-300">Cancel</button>
            {saveError && <span className="text-xs text-red-400">{saveError}</span>}
          </div>
        </div>
      )}
      <div className="bg-zinc-900 rounded-none border border-zinc-800 overflow-hidden">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-[10px] text-zinc-500 uppercase border-b border-zinc-800">
            <th className="px-3 py-2 w-8">Color</th>
            <th className="px-3 py-2 w-12">Code</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2 text-right">Songs</th>
            <th className="px-3 py-2 text-right">Spins/hr</th>
            <th className="px-3 py-2 text-right w-16"></th>
          </tr></thead>
          <tbody>{cats.map(c => (
            <tr key={c.id} className="border-b border-zinc-800 hover:bg-zinc-800">
              <td className="px-3 py-2"><div className="w-4 h-4 rounded" style={{ backgroundColor: c.color || "#444" }}></div></td>
              <td className="px-3 py-2 font-bold text-zinc-100">{c.code}</td>
              <td className="px-3 py-2 text-zinc-300">{c.name}</td>
              <td className="px-3 py-2 text-right text-zinc-400">{c.song_count || 0}</td>
              <td className="px-3 py-2 text-right text-zinc-400">{c.spins_per_hour || "--"}</td>
              <td className="px-3 py-2 text-right"><button onClick={() => setEditing(c)} className="px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px] text-zinc-300">Edit</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// CLOCKS TAB
// ============================================================

// ── Slot colors ──────────────────────────────────────────────
function slotColor(s: ClockSlot): string {
  if (s.category_color) return s.category_color;
  if (s.slot_type === "talk_break") return "#7c3aed";
  if (s.slot_type === "spot_break") return "#b91c1c";
  if (s.slot_type === "liner") return "#92400e";
  if (s.slot_type === "sweeper") return "#065f46";
  return "#374151";
}

function slotLabel(s: ClockSlot): string {
  if (s.slot_type === "talk_break") return s.label || "Talk Break";
  if (s.slot_type === "spot_break") return s.label || "Commercial";
  if (s.slot_type === "liner") return "Liner";
  if (s.slot_type === "sweeper") return "Sweeper";
  return s.category_code || "Song";
}

// ── Live clock wheel — proper radio programming clock ──────────
function ClockWheel({ slots, totalTarget = 60 }: { slots: ClockSlot[]; totalTarget?: number }) {
  const SIZE = 340;
  const CX = SIZE / 2; const CY = SIZE / 2;
  const R_OUT = SIZE / 2 - 8;   // outer radius
  const R_IN  = SIZE * 0.26;    // inner radius — thick ring
  const R_MID = R_IN + (R_OUT - R_IN) / 2;

  const filled = slots.reduce((s, sl) => s + sl.duration_min, 0);
  const remaining = Math.max(0, totalTarget - filled);
  let angle = -Math.PI / 2;

  // Build segment arcs
  const arcs: { path: string; color: string; id: number; label: string; artist: string; midAngle: number; sweep: number; durMin: number }[] = [];
  slots.forEach((s, i) => {
    const dur = Math.max(s.duration_min, 0.01); // prevent zero-sweep
    const sweep = (dur / totalTarget) * Math.PI * 2;
    const midAngle = angle + sweep / 2;
    const x1o = CX + R_OUT * Math.cos(angle);         const y1o = CY + R_OUT * Math.sin(angle);
    const x2o = CX + R_OUT * Math.cos(angle + sweep); const y2o = CY + R_OUT * Math.sin(angle + sweep);
    const x1i = CX + R_IN  * Math.cos(angle + sweep); const y1i = CY + R_IN  * Math.sin(angle + sweep);
    const x2i = CX + R_IN  * Math.cos(angle);         const y2i = CY + R_IN  * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    const path = `M ${x1o.toFixed(2)} ${y1o.toFixed(2)} A ${R_OUT} ${R_OUT} 0 ${large} 1 ${x2o.toFixed(2)} ${y2o.toFixed(2)} L ${x1i.toFixed(2)} ${y1i.toFixed(2)} A ${R_IN} ${R_IN} 0 ${large} 0 ${x2i.toFixed(2)} ${y2i.toFixed(2)} Z`;
    arcs.push({ path, color: slotColor(s), id: i, label: (s as any).song_title || slotLabel(s), artist: (s as any).song_artist || "", midAngle, sweep, durMin: dur });
    angle += sweep;
  });

  // Unfilled portion of ring
  const filledSweep = (Math.min(filled, totalTarget) / totalTarget) * Math.PI * 2;
  const emptyStart = -Math.PI / 2 + filledSweep;
  const emptyAngle = Math.PI * 2 - filledSweep;
  const ex1 = CX + R_OUT * Math.cos(emptyStart);       const ey1 = CY + R_OUT * Math.sin(emptyStart);
  const ex2 = CX + R_OUT * Math.cos(emptyStart + emptyAngle); const ey2 = CY + R_OUT * Math.sin(emptyStart + emptyAngle);
  const ei1 = CX + R_IN  * Math.cos(emptyStart + emptyAngle); const ei2_y = CY + R_IN * Math.sin(emptyStart + emptyAngle);
  const ei2 = CX + R_IN  * Math.cos(emptyStart);       const ei2y = CY + R_IN * Math.sin(emptyStart);
  const emptyLarge = emptyAngle > Math.PI ? 1 : 0;
  const emptyPath = emptyAngle > 0.01
    ? `M ${ex1.toFixed(2)} ${ey1.toFixed(2)} A ${R_OUT} ${R_OUT} 0 ${emptyLarge} 1 ${ex2.toFixed(2)} ${ey2.toFixed(2)} L ${ei1.toFixed(2)} ${ei2_y.toFixed(2)} A ${R_IN} ${R_IN} 0 ${emptyLarge} 0 ${ei2.toFixed(2)} ${ei2y.toFixed(2)} Z`
    : "";

  // Hour markers (12 ticks for 5-min intervals)
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const a = -Math.PI / 2 + (i / 12) * Math.PI * 2;
    const r1 = R_OUT + 6; const r2 = R_OUT + 14;
    return { x1: CX + r1 * Math.cos(a), y1: CY + r1 * Math.sin(a), x2: CX + r2 * Math.cos(a), y2: CY + r2 * Math.sin(a), main: i === 0 };
  });

  const fmtTime = (min: number) => `${Math.floor(min)}:${String(Math.round((min % 1) * 60)).padStart(2, "0")}`;

  return (
    <div style={{ position: "relative" as const, width: SIZE, height: SIZE, flexShrink: 0 }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {/* Outer tick ring */}
        <circle cx={CX} cy={CY} r={R_OUT + 10} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        {ticks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke={t.main ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.2)"}
            strokeWidth={t.main ? "2" : "1"} strokeLinecap="round" />
        ))}

        {/* Empty ring background */}
        {emptyPath && <path d={emptyPath} fill="rgba(255,255,255,0.04)" />}

        {/* Filled segments */}
        {arcs.map((a, i) => (
          <g key={a.id}>
            <path d={a.path} fill={a.color} stroke="#080810" strokeWidth="1.5" opacity="0.92" />
            {/* Separator line at start of each segment */}
            {i > 0 && <line
              x1={CX + R_IN * Math.cos(arcs[i].midAngle - a.sweep / 2)}
              y1={CY + R_IN * Math.sin(arcs[i].midAngle - a.sweep / 2)}
              x2={CX + R_OUT * Math.cos(arcs[i].midAngle - a.sweep / 2)}
              y2={CY + R_OUT * Math.sin(arcs[i].midAngle - a.sweep / 2)}
              stroke="#080810" strokeWidth="1.5"
            />}
            {/* Label text — only if segment is wide enough */}
            {a.sweep > 0.18 && (
              <text
                x={CX + R_MID * Math.cos(a.midAngle)}
                y={CY + R_MID * Math.sin(a.midAngle)}
                textAnchor="middle" dominantBaseline="middle"
                fill="#fff" fontSize={a.sweep > 0.4 ? "9" : "7"} fontWeight="700"
                fontFamily="Inter,sans-serif"
                style={{ pointerEvents: "none" as const }}
                transform={`rotate(${(a.midAngle * 180 / Math.PI) + 90}, ${CX + R_MID * Math.cos(a.midAngle)}, ${CY + R_MID * Math.sin(a.midAngle)})`}
              >
                {a.label.length > 12 ? a.label.slice(0, 10) + "…" : a.label}
              </text>
            )}
          </g>
        ))}

        {/* 12 o'clock marker */}
        <line x1={CX} y1={CY - R_OUT - 4} x2={CX} y2={CY - R_OUT + 8}
          stroke="rgba(255,255,255,0.9)" strokeWidth="2.5" strokeLinecap="round" />

        {/* Inner circle */}
        <circle cx={CX} cy={CY} r={R_IN - 2} fill="#080810" />
        <circle cx={CX} cy={CY} r={R_IN - 2} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />

        {/* Center content */}
        <text x={CX} y={CY - 22} textAnchor="middle" fill="rgba(255,255,255,0.25)" fontSize="9" letterSpacing="3" fontFamily="Inter,sans-serif">HOUR CLOCK</text>
        <text x={CX} y={CY + 4} textAnchor="middle" fill="rgba(255,255,255,0.95)" fontSize="28" fontWeight="800" fontFamily="Inter,sans-serif">{fmtTime(filled)}</text>
        <text x={CX} y={CY + 20} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="9" fontFamily="Inter,sans-serif">of 60 min</text>
        <text x={CX} y={CY + 36} textAnchor="middle"
          fill={remaining < 0.5 ? "#34d399" : remaining < 10 ? "#fbbf24" : "rgba(255,255,255,0.2)"}
          fontSize="10" fontWeight="700" fontFamily="Inter,sans-serif">
          {remaining < 0.1 ? "● HOUR FULL" : fmtTime(remaining) + " left"}
        </text>

        {/* Slot count ring label */}
        <text x={CX} y={CY - 36} textAnchor="middle" fill="rgba(255,255,255,0.15)" fontSize="8" fontFamily="Inter,sans-serif">{slots.length} segments</text>
      </svg>
    </div>
  );
}


// ── Talk break duration picker ────────────────────────────────
function TalkPicker({ onAdd, onBack }: {
  onAdd: (type: string, catId: number | null, durationMin: number, label: string) => void;
  onBack: () => void;
}) {
  const [customMin, setCustomMin] = useState("");
  const [customSec, setCustomSec] = useState("");

  const fire = (min: number, label: string) => onAdd("talk_break", null, min, label);

  const fireCustom = () => {
    const m = parseFloat(customMin) || 0;
    const s = parseFloat(customSec) || 0;
    const total = m + s / 60;
    if (total <= 0) return;
    const label = m > 0 && s > 0 ? `${m}:${String(Math.round(s)).padStart(2,"0")} talk`
                : m > 0            ? `${m}:00 talk`
                :                    `:${String(Math.round(s)).padStart(2,"0")} talk`;
    fire(total, label);
  };

  return (
    <div>
      {/* Preset buttons */}
      <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
        {[
          { l: ":15", m: 0.25 }, { l: ":30", m: 0.5 },
          { l: "1:00", m: 1 },   { l: "1:30", m: 1.5 },
          { l: "2:00", m: 2 },   { l: "3:00", m: 3 },
        ].map(({ l, m }) => (
          <button key={l} onClick={() => fire(m, l + " talk")} style={{
            flex: 1, padding: "8px 4px", borderRadius: 0, fontSize: 11, fontWeight: 700,
            cursor: "pointer", background: "rgba(124,58,237,0.2)",
            border: "1px solid rgba(124,58,237,0.4)", color: "#c4b5fd",
            transition: "all 0.1s",
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(124,58,237,0.4)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "rgba(124,58,237,0.2)"; }}
          >{l}</button>
        ))}
      </div>

      {/* Custom duration row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderRadius: 0, background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.2)" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "rgba(167,139,250,0.7)", letterSpacing: "0.08em", flexShrink: 0 }}>CUSTOM</span>
        <input
          type="number" min="0" max="59" placeholder="0"
          value={customMin}
          onChange={e => setCustomMin(e.target.value)}
          style={{ width: 44, padding: "5px 8px", borderRadius: 0, fontSize: 13, fontWeight: 700, textAlign: "center", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'DM Mono', monospace" }}
        />
        <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 700 }}>m</span>
        <input
          type="number" min="0" max="59" placeholder="0"
          value={customSec}
          onChange={e => setCustomSec(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") fireCustom(); }}
          style={{ width: 44, padding: "5px 8px", borderRadius: 0, fontSize: 13, fontWeight: 700, textAlign: "center", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'DM Mono', monospace" }}
        />
        <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 700 }}>s</span>
        <button
          onClick={fireCustom}
          disabled={!customMin && !customSec}
          style={{ marginLeft: 4, padding: "5px 14px", borderRadius: 0, fontSize: 11, fontWeight: 700, cursor: "pointer", background: "#a78bfa", border: "none", color: "#000", opacity: (!customMin && !customSec) ? 0.4 : 1, transition: "opacity 0.1s" }}
        >Add</button>
      </div>

      <button onClick={onBack} style={{ marginTop: 8, fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer" }}>← Back</button>
    </div>
  );
}

// ── Segment picker — shows ALL categories from DB ────────────
function SegmentPicker({ cats, onAdd, onClose }: {
  cats: Category[];
  onAdd: (type: string, catId: number | null, durationMin: number, label: string) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"type" | "song" | "commercial" | "talk">("type");

  return (
    <div style={{
      position: "absolute" as const, bottom: "calc(100% + 8px)", left: 0, right: 0,
      zIndex: 100, background: "var(--bg-secondary)",
      border: "1px solid var(--border-primary)", borderRadius: 0,
      padding: 14, boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)" }}>
          {step === "type" ? "ADD SEGMENT" : step === "song" ? "PICK CATEGORY" : step === "commercial" ? "COMMERCIAL" : "TALK BREAK"}
        </span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14 }}>✕</button>
      </div>

      {step === "type" && (
        <div style={{ display: "flex", gap: 6 }}>
          {[
            { label: "Song", color: "#38bdf8", next: "song" as const },
            { label: "Commercial", color: "#ef4444", next: "commercial" as const },
            { label: "Talk Break", color: "#a78bfa", next: "talk" as const },
          ].map(b => (
            <button key={b.label} onClick={() => setStep(b.next)} style={{
              flex: 1, padding: "10px 6px", borderRadius: 0, fontSize: 12, fontWeight: 700,
              cursor: "pointer", background: b.color + "18", border: "1px solid " + b.color + "40", color: b.color,
            }}>{b.label}</button>
          ))}
        </div>
      )}

      {step === "song" && (
        <div>
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 5, marginBottom: 8 }}>
            {cats.map(c => (
              <button key={c.id} onClick={() => onAdd("music", c.id, 3.5, c.name || c.code)} style={{
                padding: "5px 10px", borderRadius: 0, fontSize: 11, fontWeight: 700, cursor: "pointer",
                background: (c.color || "#444") + "25", border: "1px solid " + (c.color || "#444") + "55",
                color: "#fff",
              }}>
                <span style={{ color: c.color || "#fff", marginRight: 4 }}>{c.code}</span>{c.name}
              </button>
            ))}
            {cats.length === 0 && <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>No categories — add them in the Categories tab.</span>}
          </div>
          <button onClick={() => setStep("type")} style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer" }}>← Back</button>
        </div>
      )}

      {step === "commercial" && (
        <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {[{l:":30",m:0.5},{l:"1:00",m:1},{l:"2:00",m:2},{l:"3:00",m:3}].map(({l,m}) => (
              <button key={l} onClick={() => onAdd("spot_break", null, m, l + " break")} style={{
                flex: 1, padding: "8px 4px", borderRadius: 0, fontSize: 12, fontWeight: 700,
                cursor: "pointer", background: "rgba(185,28,28,0.2)", border: "1px solid rgba(185,28,28,0.4)", color: "#fca5a5",
              }}>{l}</button>
            ))}
          </div>
          <button onClick={() => setStep("type")} style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer" }}>← Back</button>
        </div>
      )}

      {step === "talk" && (
        <TalkPicker onAdd={onAdd} onBack={() => setStep("type")} />
      )}
    </div>
  );
}

// ── Clock skeleton ────────────────────────────────────────────
function ClockSkeleton() {
  const SIZE = 300; const CX = SIZE/2; const CY = SIZE/2;
  const R_OUT = SIZE/2 - 8; const R_IN = SIZE * 0.26;
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ opacity: 0.4 }}>
      <circle cx={CX} cy={CY} r={R_OUT} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1"/>
      <circle cx={CX} cy={CY} r={R_IN} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1"/>
      <text x={CX} y={CY+6} textAnchor="middle" fill="rgba(255,255,255,0.15)" fontSize="11" fontFamily="Inter,sans-serif">Add segments →</text>
    </svg>
  );
}

// ── Format time as MM:SS ──────────────────────────────────────
function fmtClockPos(totalMin: number): string {
  const m = Math.floor(totalMin);
  const s = Math.round((totalMin - m) * 60);
  return `:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

// ── ClocksTab — professional spreadsheet with clock positions ─
function ClocksTab() {
  const [clocks, setClocks]       = useState<Clock[]>([]);
  const [selected, setSelected]   = useState<number | null>(null);
  const [slots, setSlots]         = useState<ClockSlot[]>([]);
  const [cats, setCats]           = useState<Category[]>([]);
  const [newName, setNewName]     = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [showTalkPicker, setShowTalkPicker] = useState(false);
  const [dragIdx, setDragIdx]     = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<number | null>(null);
  const [copiedSlot, setCopiedSlot] = useState<ClockSlot | null>(null);

  // ── Fix: reload cats every time the tab is active ────────────
  const loadAll = async () => {
    setClocks(await query<Clock>("SELECT * FROM clocks ORDER BY name"));
    setCats(await query<Category>("SELECT * FROM categories ORDER BY priority, code"));
  };

  const loadSlots = async (clockId: number) => {
    const raw = await query<ClockSlot>(
      `SELECT cs.*, c.code as category_code, c.color as category_color
       FROM clock_slots cs
       LEFT JOIN categories c ON c.id = cs.category_id
       WHERE cs.clock_id = ? ORDER BY cs.position`,
      [clockId]
    );
    // Enrich music slots with a representative song
    const enriched = await Promise.all(raw.map(async s => {
      if (s.slot_type === "music" && s.category_id) {
        try {
          const songs = await query<{ id: number; title: string; artist_name: string | null; duration_ms: number; file_path: string }>(
            `SELECT s.id, s.title, a.name as artist_name, s.duration_ms, s.file_path
             FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
             WHERE s.category_id = ? ORDER BY RANDOM() LIMIT 1`,
            [s.category_id]
          );
          if (songs.length > 0) {
            let durMs = songs[0].duration_ms;
            if ((!durMs || durMs < 1000) && songs[0].file_path) {
              try {
                const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
                const durSec = await invoke<number>("get_file_duration", { filePath: songs[0].file_path });
                durMs = Math.round(durSec * 1000);
                if (durMs > 0) await execute("UPDATE songs SET duration_ms=? WHERE id=?", [durMs, songs[0].id]);
              } catch {}
            }
            const durMin = durMs > 0
              ? Math.round((durMs / 60000) * 100) / 100
              : 3.5; // safe fallback
            return { ...s, song_title: songs[0].title, song_artist: songs[0].artist_name, duration_min: durMin };
          }
        } catch {}
      }
      return s;
    }));
    setSlots(enriched);
  };

  useEffect(() => { loadAll(); }, []);
  useEffect(() => { if (selected) loadSlots(selected); else setSlots([]); }, [selected]);

  const createClock = async () => {
    if (!newName.trim()) return;
    const r = await execute("INSERT INTO clocks (name) VALUES (?)", [newName.trim()]);
    setNewName(""); loadAll(); setSelected(r.lastInsertRowid as number);
  };

  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const deleteClock = async (id: number) => {
    try {
      await execute("UPDATE shows SET clock_id = NULL WHERE clock_id = ?", [id]);
      await execute("DELETE FROM clock_slots WHERE clock_id=?", [id]);
      await execute("DELETE FROM clocks WHERE id=?", [id]);
      if (selected === id) { setSelected(null); setSlots([]); }
      setConfirmDelete(null);
      loadAll();
    } catch (e) {
      console.error("Delete clock failed:", e);
    }
  };

  const handleAdd = async (type: string, catId: number | null, durationMin: number, label: string) => {
    if (!selected) return;
    let dur = durationMin;
    if (type === "music" && catId) {
      try {
        const avg = await query<{ d: number }>(
          "SELECT AVG(duration_ms)/60000.0 as d FROM songs WHERE category_id=? AND duration_ms > 0",
          [catId]
        );
        if (avg[0]?.d && avg[0].d > 0) dur = Math.round(avg[0].d * 100) / 100;
      } catch {}
    }
    await execute(
      "INSERT INTO clock_slots (clock_id, position, slot_type, category_id, duration_min, label) VALUES (?,?,?,?,?,?)",
      [selected, slots.length, type, catId, dur, label]
    );
    setShowPicker(false);
    loadSlots(selected);
  };

  const removeSlot = async (id: number) => {
    await execute("DELETE FROM clock_slots WHERE id=?", [id]);
    if (selected) loadSlots(selected);
  };

  const duplicateSlot = async (s: ClockSlot) => {
    if (!selected) return;
    await execute(
      "INSERT INTO clock_slots (clock_id, position, slot_type, category_id, duration_min, label) VALUES (?,?,?,?,?,?)",
      [selected, slots.length, s.slot_type, s.category_id, s.duration_min, s.label]
    );
    loadSlots(selected);
  };

  // ── Keyboard copy/paste ───────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "c") {
        const slot = slots.find(s => s.id === selectedSlotId);
        if (slot) { setCopiedSlot(slot); }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "v") {
        if (copiedSlot && selected) {
          execute(
            "INSERT INTO clock_slots (clock_id, position, slot_type, category_id, duration_min, label) VALUES (?,?,?,?,?,?)",
            [selected, slots.length, copiedSlot.slot_type, copiedSlot.category_id, copiedSlot.duration_min, copiedSlot.label]
          ).then(() => loadSlots(selected));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedSlotId, copiedSlot, slots, selected]);

  const handleDrop = async (toIdx: number) => {
    if (dragIdx === null || dragIdx === toIdx) { setDragIdx(null); setDragOverIdx(null); return; }
    const reordered = [...slots];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(toIdx, 0, moved);
    await Promise.all(reordered.map((s, i) => execute("UPDATE clock_slots SET position=? WHERE id=?", [i, s.id])));
    setDragIdx(null); setDragOverIdx(null);
    if (selected) loadSlots(selected);
  };

  // Compute cumulative clock positions
  const positions: number[] = [];
  let cum = 0;
  slots.forEach(s => { positions.push(cum); cum += s.duration_min; });
  const totalMin = cum;
  const remaining = Math.max(0, 60 - totalMin);
  const overrun = totalMin > 60;

  // Color per slot type
  const slotColor = (s: ClockSlot) => {
    if (s.slot_type === "music") return s.category_color || "#38bdf8";
    if (s.slot_type === "spot_break") return "#ef4444";
    if (s.slot_type === "talk_break") return "#a78bfa";
    return "#94a3b8";
  };

  const typeLabel = (s: ClockSlot) => {
    if (s.slot_type === "music") return s.category_code || "SONG";
    if (s.slot_type === "spot_break") return "BREAK";
    if (s.slot_type === "talk_break") return "TALK";
    return s.slot_type.toUpperCase();
  };

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: "var(--text-primary)", margin: 0, fontFamily: "'Syne', sans-serif", letterSpacing: "-0.03em" }}>
            Format Clocks
          </h2>
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", margin: "3px 0 0" }}>
            Build your hour — positions update live as you add segments
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input placeholder="New clock name..." value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && createClock()}
            style={{ padding: "7px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", width: 160 }}
          />
          <button onClick={createClock} style={{ padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
            Create
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16 }}>

        {/* Clock list sidebar */}
        <div style={{ width: 160, flexShrink: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", marginBottom: 8 }}>SAVED CLOCKS</div>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 3 }}>
            {clocks.map(c => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                {confirmDelete === c.id ? (
                  // Inline confirm row
                  <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 0, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)" }}>
                    <span style={{ fontSize: 10, color: "#ef4444", flex: 1 }}>Delete?</span>
                    <button onClick={() => deleteClock(c.id)} style={{ fontSize: 10, fontWeight: 700, color: "#ef4444", background: "none", border: "none", cursor: "pointer", padding: "1px 4px" }}>Yes</button>
                    <button onClick={() => setConfirmDelete(null)} style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: "1px 4px" }}>No</button>
                  </div>
                ) : (
                  <>
                    <button onClick={() => setSelected(c.id)} style={{
                      flex: 1, padding: "7px 10px", borderRadius: 0, fontSize: 12,
                      fontWeight: selected === c.id ? 700 : 400, textAlign: "left" as const, cursor: "pointer",
                      background: selected === c.id ? "rgba(56,189,248,0.12)" : "var(--bg-secondary)",
                      border: selected === c.id ? "1px solid rgba(56,189,248,0.3)" : "1px solid var(--border-primary)",
                      color: selected === c.id ? "var(--accent-blue)" : "var(--text-secondary)",
                    }}>{c.name}</button>
                    <button onClick={() => setConfirmDelete(c.id)} style={{ padding: "5px 6px", background: "transparent", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 12 }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
                    >✕</button>
                  </>
                )}
              </div>
            ))}
            {clocks.length === 0 && <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic", padding: "6px 4px" }}>No clocks yet</div>}
          </div>
        </div>

        {/* Main area */}
        {selected ? (
          <div style={{ flex: 1, minWidth: 0 }}>

            {/* Time bar */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, padding: "7px 12px", background: "var(--bg-secondary)", borderRadius: 0, border: "1px solid var(--border-primary)" }}>
              <div style={{ flex: 1, height: 5, background: "var(--bg-tertiary)", borderRadius: 0, overflow: "hidden" }}>
                <div style={{ height: "100%", width: Math.min(totalMin/60*100, 100)+"%", background: overrun ? "#ef4444" : totalMin >= 55 ? "#34d399" : "var(--accent-blue)", borderRadius: 0, transition: "width 0.2s" }} />
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" as const }}>
                {totalMin.toFixed(1)} / 60 min
              </span>
              <span style={{ fontSize: 10, color: overrun ? "#ef4444" : remaining < 1 ? "#34d399" : "var(--text-tertiary)", whiteSpace: "nowrap" as const }}>
                {overrun ? `+${(totalMin-60).toFixed(1)}m over` : remaining < 0.1 ? "Hour full ✓" : remaining.toFixed(1)+"m left"}
              </span>
              {copiedSlot && (
                <span style={{ fontSize: 9, color: "#a78bfa", whiteSpace: "nowrap" as const }}>
                  ⎘ "{copiedSlot.label}" copied — Ctrl+V to paste
                </span>
              )}
            </div>

            {/* ── Spreadsheet table ── */}
            <div style={{ border: "1px solid var(--border-primary)", borderRadius: 0, overflow: "hidden", marginBottom: 8 }}>

              {/* Column headers */}
              <div style={{
                display: "grid", gridTemplateColumns: "28px 52px 36px 1fr 1fr 52px 52px 64px",
                padding: "5px 10px", background: "var(--bg-tertiary)",
                borderBottom: "1px solid var(--border-primary)",
                fontSize: 9, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-secondary)",
                textTransform: "uppercase" as const,
              }}>
                <span></span>
                <span>POSITION</span>
                <span>#</span>
                <span>TITLE</span>
                <span>ARTIST</span>
                <span>TYPE</span>
                <span style={{ textAlign: "right" as const }}>DURATION</span>
                <span></span>
              </div>

              {/* Rows */}
              <div style={{ maxHeight: 480, overflowY: "auto" as const }}>
                {slots.map((s, i) => {
                  const isSelected = selectedSlotId === s.id;
                  return (
                  <div
                    key={s.id}
                    draggable
                    onClick={() => setSelectedSlotId(isSelected ? null : s.id)}
                    onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDragIdx(i); }}
                    onDragOver={e => { e.preventDefault(); setDragOverIdx(i); }}
                    onDragEnter={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); handleDrop(i); }}
                    onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "28px 52px 36px 1fr 1fr 52px 52px 64px",
                      padding: "0 10px",
                      minHeight: 32,
                      alignItems: "center",
                      cursor: "grab",
                      background: isSelected
                        ? "rgba(167,139,250,0.12)"
                        : dragOverIdx === i
                        ? "rgba(56,189,248,0.06)"
                        : i % 2 === 0 ? "var(--bg-secondary)" : "rgba(255,255,255,0.01)",
                      borderBottom: "1px solid rgba(255,255,255,0.03)",
                      borderLeft: `3px solid ${isSelected ? "#a78bfa" : slotColor(s)}`,
                      outline: isSelected ? "1px solid rgba(167,139,250,0.3)" : "none",
                      opacity: dragIdx === i ? 0.4 : 1,
                      transition: "background 0.1s",
                    }}
                  >
                    {/* Grip */}
                    <svg width="8" height="10" viewBox="0 0 8 10" fill="var(--text-tertiary)" style={{ opacity: 0.3 }}>
                      <circle cx="2" cy="2" r="1.1"/><circle cx="6" cy="2" r="1.1"/>
                      <circle cx="2" cy="5" r="1.1"/><circle cx="6" cy="5" r="1.1"/>
                      <circle cx="2" cy="8" r="1.1"/><circle cx="6" cy="8" r="1.1"/>
                    </svg>

                    {/* Clock position */}
                    <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--text-secondary)", letterSpacing: "0.03em", fontWeight: 600 }}>
                      {fmtClockPos(positions[i])}
                    </span>

                    {/* Row number */}
                    <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontWeight: 600 }}>{i + 1}</span>

                    {/* Title */}
                    <span style={{ fontSize: 12, fontWeight: 600,
                      color: s.slot_type === "music" ? "var(--text-primary)" : slotColor(s),
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
                      paddingRight: 8,
                    }}>
                      {s.song_title || s.label || typeLabel(s)}
                    </span>

                    {/* Artist */}
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, paddingRight: 8 }}>
                      {s.song_artist || ""}
                    </span>

                    {/* Type badge */}
                    <span style={{
                      fontSize: 9, fontWeight: 800, letterSpacing: "0.07em",
                      padding: "2px 5px", borderRadius: 0,
                      background: slotColor(s) + "20", color: slotColor(s),
                      whiteSpace: "nowrap" as const,
                    }}>
                      {typeLabel(s)}
                    </span>

                    {/* Duration — editable when selected */}
                    {isSelected ? (
                      <input
                        type="number" min="0.08" step="0.25"
                        defaultValue={s.duration_min}
                        onClick={e => e.stopPropagation()}
                        onBlur={async e => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val) && val > 0 && val !== s.duration_min) {
                            await execute("UPDATE clock_slots SET duration_min=? WHERE id=?", [val, s.id]);
                            if (selected) loadSlots(selected);
                          }
                        }}
                        onKeyDown={async e => {
                          if (e.key === "Enter") {
                            const val = parseFloat((e.target as HTMLInputElement).value);
                            if (!isNaN(val) && val > 0) {
                              await execute("UPDATE clock_slots SET duration_min=? WHERE id=?", [val, s.id]);
                              if (selected) loadSlots(selected);
                            }
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                        style={{ width: 48, padding: "2px 5px", borderRadius: 0, fontSize: 11, textAlign: "right" as const, background: "var(--bg-tertiary)", border: "1px solid #a78bfa", color: "var(--text-primary)", outline: "none", fontFamily: "'DM Mono', monospace", fontWeight: 700 }}
                      />
                    ) : (
                      <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", fontWeight: 600, color: "var(--text-secondary)", textAlign: "right" as const }}>
                        {s.duration_min < 1 ? Math.round(s.duration_min * 60) + "s" : s.duration_min.toFixed(1) + "m"}
                      </span>
                    )}

                    {/* Actions */}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 2 }}>
                      <button onClick={() => duplicateSlot(s)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 11, padding: "2px 4px" }}
                        title="Duplicate slot"
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#34d399"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
                      >⎘</button>
                      <button onClick={() => removeSlot(s.id)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 11, padding: "2px 4px" }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
                      >✕</button>
                    </div>
                  </div>
                );})}

                {slots.length === 0 && (
                  <div style={{ padding: "28px 16px", textAlign: "center" as const, color: "var(--text-tertiary)", fontSize: 12, fontStyle: "italic" }}>
                    Clock is empty — click "+ Add Segment" to start building your hour
                  </div>
                )}
              </div>

              {/* Footer row — end of hour */}
              {slots.length > 0 && (
                <div style={{
                  display: "grid", gridTemplateColumns: "28px 52px 36px 1fr 1fr 52px 52px 64px",
                  padding: "5px 10px", background: "var(--bg-tertiary)",
                  borderTop: "1px solid var(--border-primary)",
                  fontSize: 9, color: overrun ? "#ef4444" : "#34d399",
                  fontFamily: "'DM Mono', monospace", fontWeight: 700,
                }}>
                  <span></span>
                  <span>{fmtClockPos(totalMin)}</span>
                  <span></span>
                  <span style={{ color: "var(--text-tertiary)", fontFamily: "'Inter', sans-serif", fontWeight: 400 }}>
                    {overrun ? `⚠ ${(totalMin-60).toFixed(1)}m over — remove segments` : remaining < 0.1 ? "✓ Hour complete" : `${remaining.toFixed(1)} min remaining`}
                  </span>
                  <span></span><span></span>
                  <span style={{ textAlign: "right" as const }}>{totalMin.toFixed(1)}m</span>
                  <span></span>
                </div>
              )}
            </div>

            {/* Quick-add category bar */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-tertiary)", marginBottom: 5 }}>
                QUICK ADD
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const }}>
                {cats.map(cat => (
                  <button
                    key={cat.id}
                    onClick={() => handleAdd("music", cat.id, 3.5, cat.name || cat.code)}
                    title={cat.name}
                    style={{
                      padding: "5px 10px", borderRadius: 0, fontSize: 11, fontWeight: 800,
                      cursor: "pointer", letterSpacing: "0.05em",
                      background: (cat.color || "#444") + "22",
                      border: "1px solid " + (cat.color || "#444") + "55",
                      color: cat.color || "#fff",
                      transition: "all 0.1s",
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLElement).style.background = (cat.color || "#444") + "44";
                      (e.currentTarget as HTMLElement).style.borderColor = (cat.color || "#444") + "99";
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLElement).style.background = (cat.color || "#444") + "22";
                      (e.currentTarget as HTMLElement).style.borderColor = (cat.color || "#444") + "55";
                    }}
                  >
                    {cat.code}
                  </button>
                ))}
                <button
                  onClick={() => handleAdd("spot_break", null, 2, "2:00 break")}
                  style={{ padding: "5px 10px", borderRadius: 0, fontSize: 11, fontWeight: 800, cursor: "pointer", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444" }}
                >
                  BRK
                </button>
                <div style={{ position: "relative" as const }}>
                  <button
                    onClick={() => { setShowTalkPicker(p => !p); setShowPicker(false); }}
                    style={{ padding: "5px 10px", borderRadius: 0, fontSize: 11, fontWeight: 800, cursor: "pointer", background: showTalkPicker ? "rgba(167,139,250,0.3)" : "rgba(167,139,250,0.12)", border: `1px solid ${showTalkPicker ? "rgba(167,139,250,0.6)" : "rgba(167,139,250,0.3)"}`, color: "#a78bfa" }}
                  >
                    TALK
                  </button>
                  {showTalkPicker && (
                    <div style={{ position: "absolute" as const, bottom: "calc(100% + 6px)", left: 0, zIndex: 200, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: 12, minWidth: 320, boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
                      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", marginBottom: 8 }}>TALK BREAK DURATION</div>
                      <TalkPicker
                        onAdd={(type, catId, dur, label) => { handleAdd(type, catId, dur, label); setShowTalkPicker(false); }}
                        onBack={() => setShowTalkPicker(false)}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Add segment */}
            <div style={{ position: "relative" as const }}>
              {showPicker && (
                <SegmentPicker cats={cats} onAdd={handleAdd} onClose={() => setShowPicker(false)} />
              )}
              <button
                onClick={() => { setShowPicker(p => !p); if (!showPicker) loadAll(); }}
                style={{
                  width: "100%", padding: "9px", borderRadius: 0, fontSize: 12, fontWeight: 700,
                  background: showPicker ? "rgba(56,189,248,0.1)" : "var(--bg-secondary)",
                  border: "1px dashed " + (showPicker ? "var(--accent-blue)" : "var(--border-secondary)"),
                  color: showPicker ? "var(--accent-blue)" : "var(--text-tertiary)", cursor: "pointer",
                }}
              >
                {showPicker ? "✕ Cancel" : "+ More Options"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)", fontSize: 12, fontStyle: "italic" }}>
            Select a clock or create a new one
          </div>
        )}
      </div>
    </div>
  );
}
