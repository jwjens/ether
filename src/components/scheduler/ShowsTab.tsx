// ShowsTab — which clock airs when.
// Extracted verbatim from Scheduler.tsx (Phase A, 2026-08-10) — lines 148-305 of the pre-split file.
// NO LOGIC CHANGED. Scheduler.tsx re-exports this so the tabbed panel, the three popouts
// (PopoutRenderer.tsx) and the embedded programming panel (App.tsx) behave identically.
// docs/schedule-manager-design-2026-08-10.md §8 Phase A
import { useState, useEffect } from "react";
import { queryScoped } from "../../db/stationScoped";
import { useActiveStation } from "../../hooks/useActiveStation";
import type { Show, Clock } from "./types";
import { HOURS, DAYS, fmtHour } from "./shared";

export function ShowsTab() {
  const { stationId, isReady } = useActiveStation();
  const [shows, setShows] = useState<Show[]>([]);
  const [clocks, setClocks] = useState<Clock[]>([]);
  const [editing, setEditing] = useState<Partial<Show> | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  const load = async () => {
    if (!isReady) return;
    // station_id scoping: manual JOIN — shows.station_id filters scope; clocks joined by FK
    setShows(await queryScoped<Show>(
      "SELECT s.*, c.name as clock_name FROM shows s LEFT JOIN clocks c ON c.id = s.clock_id WHERE s.station_id = ? AND s.deleted_at IS NULL ORDER BY s.start_hour",
      [stationId], stationId, { skipScoping: true }
    ));
    setClocks(await queryScoped<Clock>("SELECT * FROM clocks WHERE deleted_at IS NULL ORDER BY name", [], stationId));
  };
  useEffect(() => { load(); }, [isReady]);

  const save = async () => {
    if (!editing || !editing.name) return;
    setSaveError("");
    const days = editing.days ?? "0123456";
    const isActive = editing.is_active ?? 1;
    try {
      if (editing.id) {
        await (window as any).ether.shows.updateById(editing.id, {
          name: editing.name, start_hour: editing.start_hour || 0, end_hour: editing.end_hour || 0,
          color: editing.color || null, description: editing.description || null, days, is_active: isActive,
        });
      } else {
        await (window as any).ether.shows.create({
          station_id: stationId, name: editing.name, start_hour: editing.start_hour || 0,
          end_hour: editing.end_hour || 0, color: editing.color || null,
          description: editing.description || null, days, is_active: isActive,
        });
      }
      setSaved(true);
      load();
      setTimeout(() => { setSaved(false); setEditing(null); }, 1400);
    } catch (e: any) {
      setSaveError(e?.message || "Save failed");
    }
  };

  const assignClock = async (showId: number, clockId: number | null) => {
    await (window as any).ether.shows.updateById(showId, { clock_id: clockId });
    load();
  };

  const remove = async (id: number, name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    await (window as any).ether.shows.deleteById(id);
    load();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-zinc-300">Shows & Dayparts</h2>
        <button onClick={() => setEditing({ name: "", start_hour: 0, end_hour: 6, color: "#3b82f6" })} style={{ minHeight: 44, display: "inline-flex", alignItems: "center" }} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white">+ New Show</button>
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
                }} style={{ minWidth: 44, minHeight: 44, display: "inline-flex", alignItems: "center", justifyContent: "center" }} className={`rounded text-[10px] font-bold ${active ? "bg-blue-600 text-white" : "bg-zinc-700 text-zinc-400"}`}>{d}</button>
              );
            })}
            <label className="ml-3 flex items-center gap-1 text-[10px] text-zinc-400 cursor-pointer">
              <input type="checkbox" checked={(editing.is_active ?? 1) === 1} onChange={e => setEditing({...editing, is_active: e.target.checked ? 1 : 0})} />
              Active
            </label>
          </div>
          <div className="flex gap-2 items-center">
            <button onClick={save} disabled={saved} className={`px-3 py-1 rounded text-xs font-bold text-white transition-colors ${saved ? "bg-emerald-600" : "bg-blue-600 hover:bg-blue-500"}`}>{saved ? "✓ Saved" : "Save Show"}</button>
            <button onClick={() => { setEditing(null); setSaveError(""); }} className="px-3 py-1 bg-zinc-700 rounded text-xs text-zinc-300">Cancel</button>
            {saveError && <span style={{ fontSize: 11, color: "#ef4444", fontWeight: 600 }}>{saveError}</span>}
          </div>
        </div>
      )}
      {saved && <span style={{ fontSize: 11, color: "#34d399", fontWeight: 600 }}>✓ Saved</span>}

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
                <button onClick={() => setEditing(s)} style={{ minHeight: 44, minWidth: 52, display: "inline-flex", alignItems: "center", justifyContent: "center" }} className="px-2 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px] text-zinc-300">Edit</button>
                <button onClick={() => remove(s.id, s.name)} style={{ minHeight: 44, minWidth: 44, display: "inline-flex", alignItems: "center", justifyContent: "center" }} className="px-2 bg-zinc-800 hover:bg-red-900 rounded text-[10px] text-zinc-500 hover:text-red-400">Del</button>
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
