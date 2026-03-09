import { useState, useEffect } from "react";
import { query, execute, queryOne } from "../db/client";

interface Show {
  id: number; name: string; start_hour: number; end_hour: number;
  days: string; color: string | null; description: string | null; is_active: number;
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
  const [tab, setTab] = useState<"shows" | "categories" | "clocks" | "grid">("shows");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Show Scheduler</h1>
      </div>
      <div className="flex gap-1">
        {(["shows", "categories", "clocks", "grid"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={tab === t ? "px-3 py-1.5 rounded text-xs font-bold bg-blue-600 text-white" : "px-3 py-1.5 rounded text-xs font-bold bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}
          >{t === "shows" ? "Shows / Dayparts" : t === "categories" ? "Categories" : t === "clocks" ? "Format Clocks" : "Schedule Grid"}</button>
        ))}
      </div>
      {tab === "shows" && <ShowsTab />}
      {tab === "categories" && <CategoriesTab />}
      {tab === "clocks" && <ClocksTab />}
      {tab === "grid" && <GridTab />}
    </div>
  );
}

// ============================================================
// SHOWS / DAYPARTS TAB
// ============================================================

function ShowsTab() {
  const [shows, setShows] = useState<Show[]>([]);
  const [editing, setEditing] = useState<Partial<Show> | null>(null);

  const load = async () => { setShows(await query<Show>("SELECT * FROM shows ORDER BY start_hour")); };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing || !editing.name) return;
    if (editing.id) {
      await execute("UPDATE shows SET name=?, start_hour=?, end_hour=?, color=?, description=? WHERE id=?",
        [editing.name, editing.start_hour || 0, editing.end_hour || 0, editing.color || null, editing.description || null, editing.id]);
    } else {
      await execute("INSERT INTO shows (name, start_hour, end_hour, color, description) VALUES (?,?,?,?,?)",
        [editing.name, editing.start_hour || 0, editing.end_hour || 0, editing.color || null, editing.description || null]);
    }
    setEditing(null); load();
  };

  const remove = async (id: number) => { await execute("DELETE FROM shows WHERE id=?", [id]); load(); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-zinc-300">Shows / Dayparts</h2>
        <button onClick={() => setEditing({ name: "", start_hour: 0, end_hour: 6, color: "#3b82f6" })} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white">+ New Show</button>
      </div>

      {/* 24-hour timeline visualization */}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3">
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

      {editing && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 space-y-2">
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
          <div className="flex gap-2">
            <button onClick={save} className="px-3 py-1 bg-blue-600 rounded text-xs font-bold text-white">Save</button>
            <button onClick={() => setEditing(null)} className="px-3 py-1 bg-zinc-700 rounded text-xs text-zinc-300">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        {shows.map(s => (
          <div key={s.id} className="flex items-center justify-between px-3 py-2 bg-zinc-900 rounded border border-zinc-800 hover:bg-zinc-800">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: s.color || "#444" }}></div>
              <span className="text-sm text-zinc-100 font-medium">{s.name}</span>
              <span className="text-xs text-zinc-500">{fmtHour(s.start_hour)} - {fmtHour(s.end_hour)}</span>
            </div>
            <div className="flex gap-1">
              <button onClick={() => setEditing(s)} className="px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px] text-zinc-300">Edit</button>
              <button onClick={() => remove(s.id)} className="px-2 py-0.5 bg-zinc-800 hover:bg-red-900 rounded text-[10px] text-zinc-500 hover:text-red-400">Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// CATEGORIES TAB — A/B/C/D rotation setup
// ============================================================

function CategoriesTab() {
  const [cats, setCats] = useState<Category[]>([]);
  const [editing, setEditing] = useState<Partial<Category> | null>(null);

  const load = async () => {
    const rows = await query<Category & { song_count: number }>("SELECT c.*, (SELECT COUNT(*) FROM songs WHERE category_id = c.id) as song_count FROM categories c ORDER BY c.code");
    setCats(rows);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing || !editing.code) return;
    if (editing.id) {
      await execute("UPDATE categories SET code=?, name=?, color=?, spins_per_hour=?, priority=? WHERE id=?",
        [editing.code, editing.name || editing.code, editing.color || null, editing.spins_per_hour || 0, editing.priority || 0, editing.id]);
    } else {
      await execute("INSERT INTO categories (code, name, color, spins_per_hour, priority) VALUES (?,?,?,?,?)",
        [editing.code, editing.name || editing.code, editing.color || null, editing.spins_per_hour || 0, editing.priority || 0]);
    }
    setEditing(null); load();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-zinc-300">Rotation Categories</h2>
        <button onClick={() => setEditing({ code: "", name: "", color: "#3b82f6", spins_per_hour: 0, priority: 0 })} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white">+ New Category</button>
      </div>

      <div className="text-xs text-zinc-500 bg-zinc-900 rounded p-2 border border-zinc-800">
        <strong>How rotation works:</strong> A = Power Current (heavy rotation, newest hits). B = Secondary (medium rotation). C = Recurrent (familiar favorites). D = Gold (classic library). Higher priority + more spins per hour = plays more often.
      </div>

      {editing && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 space-y-2">
          <div className="grid grid-cols-5 gap-2">
            <input className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Code (A)" value={editing.code || ""} onChange={e => setEditing({...editing, code: e.target.value})} />
            <input className="col-span-2 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Name" value={editing.name || ""} onChange={e => setEditing({...editing, name: e.target.value})} />
            <input type="number" className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Spins/hr" value={editing.spins_per_hour || ""} onChange={e => setEditing({...editing, spins_per_hour: parseInt(e.target.value) || 0})} />
            <input type="color" className="h-8 w-full bg-zinc-800 border border-zinc-700 rounded" value={editing.color || "#3b82f6"} onChange={e => setEditing({...editing, color: e.target.value})} />
          </div>
          <div className="flex gap-2">
            <button onClick={save} className="px-3 py-1 bg-blue-600 rounded text-xs font-bold text-white">Save</button>
            <button onClick={() => setEditing(null)} className="px-3 py-1 bg-zinc-700 rounded text-xs text-zinc-300">Cancel</button>
          </div>
        </div>
      )}

      <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
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
              <td className="px-3 py-2 text-right text-zinc-400">{c.spins_per_hour || "—"}</td>
              <td className="px-3 py-2 text-right">
                <button onClick={() => setEditing(c)} className="px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px] text-zinc-300">Edit</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// CLOCKS TAB — format clock builder
// ============================================================

function ClocksTab() {
  const [clocks, setClocks] = useState<Clock[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [slots, setSlots] = useState<ClockSlot[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [newName, setNewName] = useState("");

  const loadClocks = async () => {
    setClocks(await query<Clock>("SELECT * FROM clocks ORDER BY name"));
    setCats(await query<Category>("SELECT * FROM categories ORDER BY code"));
  };
  const loadSlots = async (clockId: number) => {
    const s = await query<ClockSlot>("SELECT cs.*, c.code as category_code, c.color as category_color FROM clock_slots cs LEFT JOIN categories c ON c.id = cs.category_id WHERE cs.clock_id = ? ORDER BY cs.position", [clockId]);
    setSlots(s);
  };

  useEffect(() => { loadClocks(); }, []);
  useEffect(() => { if (selected) loadSlots(selected); else setSlots([]); }, [selected]);

  const createClock = async () => {
    if (!newName.trim()) return;
    const r = await execute("INSERT INTO clocks (name) VALUES (?)", [newName.trim()]);
    setNewName(""); loadClocks(); setSelected(r.lastInsertId);
  };

  const addSlot = async (type: string, catId: number | null) => {
    if (!selected) return;
    const pos = slots.length;
    await execute("INSERT INTO clock_slots (clock_id, position, slot_type, category_id) VALUES (?,?,?,?)", [selected, pos, type, catId]);
    loadSlots(selected);
  };

  const removeSlot = async (id: number) => {
    await execute("DELETE FROM clock_slots WHERE id=?", [id]);
    if (selected) loadSlots(selected);
  };

  const totalMin = slots.reduce((sum, s) => sum + s.duration_min, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-zinc-300">Format Clocks</h2>
        <div className="flex gap-1">
          <input className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100 w-40" placeholder="New clock name" value={newName} onChange={e => setNewName(e.target.value)} />
          <button onClick={createClock} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white">Create</button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {/* Clock list */}
        <div className="space-y-1">
          {clocks.map(c => (
            <button key={c.id} onClick={() => setSelected(c.id)}
              className={selected === c.id ? "w-full px-3 py-2 text-left bg-blue-900 border border-blue-700 rounded text-xs text-white font-medium" : "w-full px-3 py-2 text-left bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-300 hover:bg-zinc-800"}
            >{c.name}</button>
          ))}
          {clocks.length === 0 && <div className="text-xs text-zinc-600 italic p-2">No clocks yet. Create one above.</div>}
        </div>

        {/* Clock editor */}
        <div className="col-span-3">
          {selected ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-400">{totalMin} min / 60 min hour</span>
                <div className="flex gap-1 flex-wrap">
                  {cats.map(c => (
                    <button key={c.id} onClick={() => addSlot("music", c.id)} className="px-2 py-0.5 rounded text-[9px] font-bold text-white" style={{ backgroundColor: c.color || "#444" }}>+ {c.code}</button>
                  ))}
                  <button onClick={() => addSlot("spot_break", null)} className="px-2 py-0.5 bg-zinc-700 rounded text-[9px] font-bold text-zinc-300">+ Break</button>
                  <button onClick={() => addSlot("liner", null)} className="px-2 py-0.5 bg-zinc-700 rounded text-[9px] font-bold text-zinc-300">+ Liner</button>
                  <button onClick={() => addSlot("sweeper", null)} className="px-2 py-0.5 bg-zinc-700 rounded text-[9px] font-bold text-zinc-300">+ Sweep</button>
                </div>
              </div>

              {/* Visual clock wheel */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <div className="flex flex-wrap gap-1">
                    {slots.map((s, i) => (
                      <div key={s.id} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold text-white cursor-pointer hover:opacity-80"
                        style={{ backgroundColor: s.category_color || (s.slot_type === "spot_break" ? "#991b1b" : s.slot_type === "liner" ? "#854d0e" : "#374151") }}
                        onClick={() => removeSlot(s.id)}>
                        <span>{i + 1}</span>
                        <span>{s.category_code || s.slot_type}</span>
                        <span className="text-[8px] opacity-70">{s.duration_min}m</span>
                      </div>
                    ))}
                  </div>
                  {slots.length > 0 && <div className="text-[9px] text-zinc-600 mt-1">Click a slot to remove it</div>}
                </div>

                {/* Mini pie chart */}
                <div className="w-32 h-32 shrink-0">
                  <ClockWheel slots={slots} />
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-zinc-600 italic p-4 text-center">Select a clock from the left or create a new one.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ClockWheel({ slots }: { slots: ClockSlot[] }) {
  const total = slots.reduce((s, sl) => s + sl.duration_min, 0) || 60;
  let angle = -90;

  const arcs = slots.map(s => {
    const sweep = (s.duration_min / total) * 360;
    const startAngle = angle;
    angle += sweep;
    const rad1 = (startAngle * Math.PI) / 180;
    const rad2 = ((startAngle + sweep) * Math.PI) / 180;
    const r = 55;
    const cx = 64, cy = 64;
    const x1 = cx + r * Math.cos(rad1);
    const y1 = cy + r * Math.sin(rad1);
    const x2 = cx + r * Math.cos(rad2);
    const y2 = cy + r * Math.sin(rad2);
    const large = sweep > 180 ? 1 : 0;
    const color = s.category_color || (s.slot_type === "spot_break" ? "#991b1b" : "#374151");
    return { d: "M " + cx + " " + cy + " L " + x1 + " " + y1 + " A " + r + " " + r + " 0 " + large + " 1 " + x2 + " " + y2 + " Z", color, id: s.id };
  });

  return (
    <svg viewBox="0 0 128 128" className="w-full h-full">
      <circle cx="64" cy="64" r="58" fill="none" stroke="#27272a" strokeWidth="1" />
      {arcs.map(a => <path key={a.id} d={a.d} fill={a.color} stroke="#09090b" strokeWidth="0.5" opacity="0.85" />)}
      <circle cx="64" cy="64" r="12" fill="#18181b" />
      <text x="64" y="67" textAnchor="middle" fill="#71717a" fontSize="8">{total}m</text>
    </svg>
  );
}

// ============================================================
// SCHEDULE GRID — 7x24 assignment
// ============================================================

function GridTab() {
  const [clocks, setClocks] = useState<Clock[]>([]);
  const [grid, setGrid] = useState<Record<string, number | null>>({});

  const load = async () => {
    setClocks(await query<Clock>("SELECT * FROM clocks ORDER BY name"));
    const rows = await query<{ day_of_week: number; hour: number; clock_id: number }>("SELECT * FROM schedule_grid");
    const g: Record<string, number | null> = {};
    rows.forEach(r => { g[r.day_of_week + "-" + r.hour] = r.clock_id; });
    setGrid(g);
  };
  useEffect(() => { load(); }, []);

  const assign = async (day: number, hour: number, clockId: number | null) => {
    const key = day + "-" + hour;
    if (clockId) {
      await execute("INSERT OR REPLACE INTO schedule_grid (day_of_week, hour, clock_id) VALUES (?,?,?)", [day, hour, clockId]);
    } else {
      await execute("DELETE FROM schedule_grid WHERE day_of_week=? AND hour=?", [day, hour]);
    }
    setGrid(prev => ({ ...prev, [key]: clockId }));
  };

  const clockMap = new Map(clocks.map(c => [c.id, c]));

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-bold text-zinc-300">Schedule Grid — 7 x 24</h2>
      <div className="text-xs text-zinc-500">Click a cell to cycle through clocks. The schedule determines which format clock plays at each hour.</div>
      <div className="overflow-auto">
        <table className="text-[9px] border-collapse">
          <thead>
            <tr>
              <th className="px-1 py-1 text-zinc-500"></th>
              {HOURS.map(h => <th key={h} className="px-1 py-1 text-zinc-500 w-8 text-center">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((day, di) => (
              <tr key={di}>
                <td className="px-2 py-1 text-zinc-400 font-bold">{day}</td>
                {HOURS.map(h => {
                  const key = di + "-" + h;
                  const clockId = grid[key] || null;
                  const clock = clockId ? clockMap.get(clockId) : null;
                  return (
                    <td key={h} className="border border-zinc-800 cursor-pointer hover:bg-zinc-700 text-center"
                      style={{ backgroundColor: clock?.color || "#18181b" }}
                      onClick={() => {
                        const ids = [null, ...clocks.map(c => c.id)];
                        const curr = ids.indexOf(clockId);
                        const next = ids[(curr + 1) % ids.length];
                        assign(di, h, next);
                      }}>
                      <span className="text-white font-bold">{clock?.name?.charAt(0) || ""}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {clocks.length > 0 && (
        <div className="flex gap-2 text-[10px]">
          {clocks.map(c => <span key={c.id} className="flex items-center gap-1"><span className="w-3 h-3 rounded" style={{ backgroundColor: c.color || "#444" }}></span>{c.name}</span>)}
        </div>
      )}
    </div>
  );
}