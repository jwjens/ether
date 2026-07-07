import { useEffect, useRef, useState } from "react";

// Scheduler Health — a MOVABLE, non-blocking panel (opened from Tools, never a locked modal). Three
// readouts: (1) CATEGORY HEALTH — distinct-artist headroom per category (the binding constraint on
// artist separation), so you see which categories are near running the scheduler out of options;
// (2) RUNWAY — how far ahead the log reaches for the active station (layer #2); (3) LAST GENERATE — the
// structured diagnostics (named gaps by type + relaxed picks), clickable to jump the calendar to a day.
type CatRow = { id: number; code: string; name: string; songs: number; artists: number; status: "healthy" | "tight" | "at_risk"; inRotation: boolean };
type GapRange = { label: string; startHour: number };
type GapDay = {
  date: string; dateTs: number;
  noShow: GapRange[]; noClock: GapRange[]; emptyCats: string[]; emptyClocks: string[];
  relaxed: { hourLabel: string; title: string; artist: string; category: string }[];
};
type GenReport = { station: string; count: number; days: GapDay[] };

export default function SchedulerHealthPanel({ onClose }: { onClose: () => void }) {
  const ether = (window as any).ether;
  const [tab, setTab] = useState<"health" | "generate">("health");
  const [cats, setCats] = useState<CatRow[]>([]);
  const [sepMin, setSepMin] = useState(60);
  const [runwayDays, setRunwayDays] = useState<number | null>(null);
  const [report, setReport] = useState<GenReport | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: Math.max(20, window.innerWidth - 470), y: 84 });
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const refresh = async () => {
    try { const r = await ether.invoke("schedule:categoryHealth"); if (r?.ok) { setCats(r.rows || []); setSepMin(r.artistSepMin || 60); } } catch { /* ignore */ }
    try { const r = await ether.invoke("schedule:runway"); if (r?.ok) setRunwayDays(r.runwayDays); } catch { /* ignore */ }
  };
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onGen = (e: any) => { setReport(e.detail); setTab("generate"); };
    window.addEventListener("ether:gen-report", onGen);
    return () => window.removeEventListener("ether:gen-report", onGen);
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    const move = (ev: MouseEvent) => { if (drag.current) setPos({ x: ev.clientX - drag.current.dx, y: ev.clientY - drag.current.dy }); };
    const up = () => { drag.current = null; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const jump = (dateTs: number) => window.dispatchEvent(new CustomEvent("ether:calendar-open-day", { detail: { dateTs } }));

  const statusColor = (s: string) => s === "healthy" ? "var(--accent-green)" : s === "tight" ? "#e0a020" : "var(--accent-red)";
  const sorted = [...cats].sort((a, b) => (Number(b.inRotation) - Number(a.inRotation)) || (a.artists - b.artists));
  const daysWithGaps = report?.days.filter(d => d.noShow.length || d.noClock.length || d.emptyCats.length || d.emptyClocks.length) || [];
  const daysWithRelaxed = report?.days.filter(d => d.relaxed.length) || [];

  return (
    <div style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 9500, width: 440, maxHeight: "78vh",
      display: "flex", flexDirection: "column", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
      boxShadow: "0 20px 60px rgba(0,0,0,0.55)", fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Draggable header */}
      <div onMouseDown={startDrag} style={{ cursor: "move", display: "flex", alignItems: "center", gap: 8, padding: "9px 12px",
        background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)", userSelect: "none" }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: "var(--text-primary)", flex: 1 }}>Scheduler Health</span>
        <button onClick={refresh} title="Refresh" style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13 }}>⟳</button>
        <button onClick={onClose} title="Close" style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14 }}>✕</button>
      </div>

      {/* Runway strip */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-primary)", fontSize: 11.5, color: "var(--text-secondary)" }}>
        Active-station runway: <b style={{ color: runwayDays == null ? "var(--text-secondary)" : runwayDays < 2 ? "var(--accent-red)" : runwayDays < 4 ? "#e0a020" : "var(--accent-green)" }}>
          {runwayDays == null ? "—" : `${runwayDays} day${runwayDays === 1 ? "" : "s"}`}</b>
        <span style={{ opacity: 0.7 }}> · auto-extend keeps it ≥ 48h</span>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border-primary)" }}>
        {(["health", "generate"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "8px 0", fontSize: 11.5, fontWeight: 700, cursor: "pointer",
            background: tab === t ? "var(--bg-secondary)" : "var(--bg-tertiary)", color: tab === t ? "var(--text-primary)" : "var(--text-secondary)",
            border: "none", borderBottom: tab === t ? "2px solid var(--accent-blue)" : "2px solid transparent" }}>
            {t === "health" ? "Category health" : "Last generate"}
          </button>
        ))}
      </div>

      <div style={{ overflowY: "auto", padding: 12 }}>
        {tab === "health" ? (
          <>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 10 }}>
              Distinct artists is the headroom before {sepMin}-min artist separation runs the scheduler out of compliant songs. Target 10+ per hourly category.
            </div>
            {sorted.length === 0 ? <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>No categories with songs yet.</div>
              : sorted.map(c => {
                const pct = Math.min(100, Math.round((c.artists / 12) * 100));
                return (
                  <div key={c.id} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 12 }}>
                      <b style={{ color: "var(--text-primary)" }}>{c.code || c.name}</b>
                      {c.inRotation && <span style={{ fontSize: 9, fontWeight: 700, color: "var(--accent-blue)", border: "1px solid var(--accent-blue)", padding: "0 4px" }}>ON AIR</span>}
                      <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: 11 }}>{c.artists} artists · {c.songs} songs</span>
                      {c.status === "at_risk" && <span style={{ color: "var(--accent-red)", fontSize: 10, fontWeight: 700 }}>ADD SONGS</span>}
                    </div>
                    <div style={{ height: 6, background: "var(--bg-tertiary)", marginTop: 3, borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: statusColor(c.status) }} />
                    </div>
                  </div>
                );
              })}
          </>
        ) : (
          <>
            {!report ? <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Run Generate on the Calendar and the results appear here.</div>
              : (
                <>
                  <div style={{ fontSize: 12, color: "var(--text-primary)", marginBottom: 10 }}>
                    <b>{report.count}</b> item{report.count === 1 ? "" : "s"} placed{report.station ? <> for <b>{report.station}</b></> : null}.
                    {daysWithGaps.length === 0 && daysWithRelaxed.length === 0 ? " No gaps, no relaxed picks — clean." : ""}
                  </div>
                  {daysWithGaps.length > 0 && (
                    <Section title="Hours with no show scheduled" color="var(--accent-red)">
                      {daysWithGaps.filter(d => d.noShow.length).map(d => (
                        <div key={d.dateTs} style={{ fontSize: 12, marginBottom: 4 }}>
                          <b>{d.date}</b> ·{" "}
                          {d.noShow.map((r, i) => (
                            <a key={i} onClick={() => jump(d.dateTs)} style={{ color: "var(--accent-blue)", cursor: "pointer", marginRight: 8 }}>{r.label}</a>
                          ))}
                        </div>
                      ))}
                    </Section>
                  )}
                  {daysWithGaps.some(d => d.noClock.length) && (
                    <Section title="Show has no clock assigned" color="#e0a020">
                      {daysWithGaps.filter(d => d.noClock.length).map(d => (
                        <div key={d.dateTs} style={{ fontSize: 12, marginBottom: 4 }}>
                          <b>{d.date}</b> · {d.noClock.map(r => r.label).join(", ")}
                        </div>
                      ))}
                    </Section>
                  )}
                  {daysWithGaps.some(d => d.emptyCats.length || d.emptyClocks.length) && (
                    <Section title="Couldn't fill (empty / over-filtered)" color="#e0a020">
                      {[...new Set(daysWithGaps.flatMap(d => [...d.emptyCats, ...d.emptyClocks]))].map((n, i) => (
                        <div key={i} style={{ fontSize: 12, marginBottom: 3 }}>{n}</div>
                      ))}
                    </Section>
                  )}
                  {daysWithRelaxed.length > 0 && (
                    <Section title="Relaxed picks (a rule was bent to avoid a gap)" color="var(--accent-blue)">
                      {daysWithRelaxed.map(d => (
                        <div key={d.dateTs} style={{ marginBottom: 6 }}>
                          <div style={{ fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }} onClick={() => jump(d.dateTs)}>{d.date}</div>
                          {d.relaxed.slice(0, 12).map((r, i) => (
                            <div key={i} style={{ fontSize: 11.5, color: "var(--text-primary)", paddingLeft: 8 }}>
                              {r.hourLabel} · {r.title} <span style={{ color: "var(--text-secondary)" }}>({r.category})</span>
                            </div>
                          ))}
                          {d.relaxed.length > 12 && <div style={{ fontSize: 11, color: "var(--text-secondary)", paddingLeft: 8 }}>+{d.relaxed.length - 12} more</div>}
                        </div>
                      ))}
                    </Section>
                  )}
                </>
              )}
          </>
        )}
      </div>
    </div>
  );
}

// Self-mounting host: render once at the app root. Opens when the Tools menu dispatches
// "ether:open-scheduler-health" — so the panel floats over whatever view is up, movable, non-blocking.
export function SchedulerHealthHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("ether:open-scheduler-health", on);
    return () => window.removeEventListener("ether:open-scheduler-health", on);
  }, []);
  return open ? <SchedulerHealthPanel onClose={() => setOpen(false)} /> : null;
}

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color, marginBottom: 6, borderBottom: `1px solid ${color}`, paddingBottom: 3 }}>{title}</div>
      {children}
    </div>
  );
}
