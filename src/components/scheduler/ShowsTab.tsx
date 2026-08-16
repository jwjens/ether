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

/** All optional. With none supplied this behaves EXACTLY as before — the tabbed panel, the popout and
 *  the embedded programming panel pass nothing and keep self-fetching. The hub supplies data and a
 *  refresh callback so three panes share one store instead of three fetchers.
 *  docs/schedule-manager-design-2026-08-10.md §4.1 */
export interface ShowsTabProps {
  shows?: Show[];
  clocks?: Clock[];
  /** Hub-hosted when present: load() reports the write upward instead of re-fetching locally. */
  onMutated?: (tables?: string[]) => void;
  selectedShowId?: number | null;
  onSelectShow?: (showId: number) => void;
}

export function ShowsTab({ shows: showsProp, clocks: clocksProp, onMutated, selectedShowId, onSelectShow }: ShowsTabProps = {}) {
  const { stationId, isReady } = useActiveStation();
  const hosted = !!onMutated;
  const [showsLocal, setShows] = useState<Show[]>([]);
  const [clocksLocal, setClocks] = useState<Clock[]>([]);
  const shows = showsProp ?? showsLocal;
  const clocks = clocksProp ?? clocksLocal;
  const [editing, setEditing] = useState<Partial<Show> | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  // ONE refresh path when hosted: every existing call site (mount + the three write callbacks) keeps
  // calling load(), and load() tells the hub instead of fetching. No write path changed.
  const load = async () => {
    if (hosted) { onMutated!(["shows", "clocks"]); return; }
    if (!isReady) return;
    // station_id scoping: manual JOIN — shows.station_id filters scope; clocks joined by FK
    setShows(await queryScoped<Show>(
      "SELECT s.*, c.name as clock_name FROM shows s LEFT JOIN clocks c ON c.id = s.clock_id WHERE s.station_id = ? AND s.deleted_at IS NULL ORDER BY s.start_hour",
      [stationId], stationId, { skipScoping: true }
    ));
    setClocks(await queryScoped<Clock>("SELECT * FROM clocks WHERE deleted_at IS NULL ORDER BY name", [], stationId));
  };
  // Hosted: the hub already loaded before this mounted; loading again would be a wasted round trip.
  useEffect(() => { if (!hosted) load(); }, [isReady, hosted]);

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

  /** Row-level action: text, 11px, bordered, flat — the toolbar voice at row scale. */
  const rowBtn: React.CSSProperties = {
    padding: "0 var(--s-2)", height: 18, borderRadius: "var(--r-0)", fontSize: "var(--t-micro)",
    fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
    background: "transparent", border: "1px solid var(--border-primary)",
    color: "var(--text-secondary)", cursor: "pointer",
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 style={{ fontSize: "var(--t-small)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-tertiary)", margin: 0 }}>Shows &amp; Dayparts</h2>
        {/* A toolbar control, not a hero. A blue 44px-tall pill was the loudest thing in a pane whose
            entire job is to list shows — it out-shouted the data underneath it. */}
        <button onClick={() => setEditing({ name: "", start_hour: 0, end_hour: 6, color: "#3b82f6" })}
          style={{ padding: "var(--s-2) var(--s-3)", borderRadius: "var(--r-0)", fontSize: "var(--t-small)",
                   fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
                   background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
                   color: "var(--text-secondary)", cursor: "pointer" }}>+ New Show</button>
      </div>

      {/* Timeline */}
      <div className="bg-zinc-900 rounded-none border border-zinc-800 p-3">
        <div className="text-[10px] text-zinc-500 uppercase mb-1">24-Hour Timeline</div>
        <div className="relative h-10 bg-zinc-800 rounded-none overflow-hidden flex">
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
            return <div key={s.id} className="absolute top-0 h-full flex items-center justify-center text-[9px] font-bold text-white" style={{ left: left + "%", width: Math.min(width, 100 - left) + "%", backgroundColor: s.color || "#444", opacity: 0.3 }}>{s.name}</div>;
          })}
        </div>
      </div>

      {/* Edit form */}
      {editing && (
        <div className="bg-zinc-900 rounded-none border border-zinc-800 p-3 space-y-2">
          <div className="grid grid-cols-4 gap-2">
            <input className="col-span-2 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-none text-xs text-zinc-100" placeholder="Show name" value={editing.name || ""} onChange={e => setEditing({...editing, name: e.target.value})} />
            <select className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-none text-xs text-zinc-100" value={editing.start_hour || 0} onChange={e => setEditing({...editing, start_hour: parseInt(e.target.value)})}>
              {HOURS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
            </select>
            <select className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-none text-xs text-zinc-100" value={editing.end_hour || 0} onChange={e => setEditing({...editing, end_hour: parseInt(e.target.value)})}>
              {HOURS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <input type="color" className="h-8 w-full bg-zinc-800 border border-zinc-700 rounded-none" value={editing.color || "#3b82f6"} onChange={e => setEditing({...editing, color: e.target.value})} />
            <input className="col-span-3 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-none text-xs text-zinc-100" placeholder="Description" value={editing.description || ""} onChange={e => setEditing({...editing, description: e.target.value})} />
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
                }} style={{ minWidth: 44, minHeight: 44, display: "inline-flex", alignItems: "center", justifyContent: "center" }} className={`rounded-none text-[10px] font-bold ${active ? "bg-blue-600 text-white" : "bg-zinc-700 text-zinc-400"}`}>{d}</button>
              );
            })}
            <label className="ml-3 flex items-center gap-1 text-[10px] text-zinc-400 cursor-pointer">
              <input type="checkbox" checked={(editing.is_active ?? 1) === 1} onChange={e => setEditing({...editing, is_active: e.target.checked ? 1 : 0})} />
              Active
            </label>
          </div>
          <div className="flex gap-2 items-center">
            <button onClick={save} disabled={saved} className={`px-3 py-1 rounded-none text-xs font-bold text-white transition-colors ${saved ? "bg-emerald-600" : "bg-blue-600 hover:bg-blue-500"}`}>{saved ? "✓ Saved" : "Save Show"}</button>
            <button onClick={() => { setEditing(null); setSaveError(""); }} className="px-3 py-1 bg-zinc-700 rounded-none text-xs text-zinc-300">Cancel</button>
            {saveError && <span style={{ fontSize: "var(--t-small)", color: "#ef4444", fontWeight: 600 }}>{saveError}</span>}
          </div>
        </div>
      )}
      {saved && <span style={{ fontSize: "var(--t-small)", color: "#34d399", fontWeight: 600 }}>✓ Saved</span>}

      {/* ── The show list: ROWS, not cards ──────────────────────────────────────────────────────
          Each show used to be a bordered card ~90px tall — a colour dot, a two-line block, two
          44px buttons, then the clock picker on a second line. Six shows filled the pane. The same
          six facts fit on one 28px line each, so the list reads as a list and the pane shows four
          times as many. Separation is a single hairline between rows, as everywhere else.
          Nothing about the behaviour moved: the same click selects, the same buttons edit and
          delete, and the same select assigns the clock. */}
      <div style={{ border: "1px solid var(--border-primary)", background: "var(--bg-secondary)" }}>
        {/* Column labels — 11px uppercase, the workspace's label voice. */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", padding: "var(--s-2) var(--s-4)",
                      borderBottom: "1px solid var(--border-primary)", fontSize: "var(--t-small)", fontWeight: 700,
                      letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>
          <span style={{ width: 8, flexShrink: 0 }} />
          <span style={{ flex: "1 1 40%" }}>Show</span>
          <span style={{ flex: "0 0 96px" }}>Hours</span>
          <span style={{ flex: "1 1 34%" }}>Clock</span>
          <span style={{ flex: "0 0 62px" }} />
        </div>
        {shows.map(s => (
          <div key={s.id}
            onClick={onSelectShow ? () => onSelectShow(s.id) : undefined}
            style={{
              display: "flex", alignItems: "center", gap: "var(--s-3)", height: 28, padding: "0 var(--s-4)",
              borderBottom: "1px solid var(--border-primary)",
              borderLeft: `2px solid ${selectedShowId === s.id ? "var(--accent-purple)" : "transparent"}`,
              background: selectedShowId === s.id ? "var(--bg-tertiary)" : "transparent",
              cursor: onSelectShow ? "pointer" : undefined,
            }}>
            {/* Colour is DATA here — it is the show's own colour, the one drawn on the timeline. */}
            <span style={{ width: 8, height: 8, borderRadius: "var(--r-full)", flexShrink: 0, background: s.color || "var(--text-tertiary)" }} />
            <span style={{ flex: "1 1 40%", fontSize: "var(--t-body)", color: "var(--text-primary)", fontWeight: 500,
                           overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={s.description || undefined}>{s.name}</span>
            <span style={{ flex: "0 0 96px", fontSize: "var(--t-small)", color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>
              {fmtHour(s.start_hour)}–{fmtHour(s.end_hour)}
            </span>
            <select value={s.clock_id || ""} onClick={e => e.stopPropagation()}
              onChange={e => assignClock(s.id, e.target.value ? parseInt(e.target.value) : null)}
              style={{ flex: "1 1 34%", minWidth: 0, height: 20, padding: "0 var(--s-2)", borderRadius: "var(--r-0)",
                       background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
                       color: s.clock_name ? "var(--text-secondary)" : "var(--text-tertiary)", fontSize: "var(--t-small)" }}>
              <option value="">— none —</option>
              {clocks.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <span style={{ flex: "0 0 62px", display: "flex", gap: "var(--s-1)", justifyContent: "flex-end" }}>
              <button onClick={e => { e.stopPropagation(); setEditing(s); }} title="Edit this show"
                style={rowBtn}>Edit</button>
              <button onClick={e => { e.stopPropagation(); remove(s.id, s.name); }} title="Delete this show"
                style={{ ...rowBtn, color: "var(--text-tertiary)" }}>Del</button>
            </span>
          </div>
        ))}
        {/* One quiet line. No illustration, no centred italic block. */}
        {shows.length === 0 && (
          <div style={{ padding: "var(--s-4)", fontSize: "var(--t-body)", color: "var(--text-tertiary)" }}>
            No shows yet — “+ New Show” creates a daypart.
          </div>
        )}
      </div>
    </div>
  );
}
