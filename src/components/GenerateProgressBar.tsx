import { useState, useEffect, useRef } from "react";

// Bottom-left generate progress — the operator-facing half of the 2026-08-06 freeze work.
// docs/generate-freeze-and-calendar-history-2026-08-06.md
//
// WHY IT LIVES HERE AND NOT IN THE CALENDAR: a generate can be started from the month view and then
// the operator navigates somewhere else. A bar owned by BroadcastCalendar disappears with it, and the
// run goes silent again. This is mounted at App top-level, driven purely by main's own start/hour/end
// events, so it is correct no matter which panel is open — and it cannot re-render the calendar's
// 1000-row day list, because it does not live inside it.
//
// THROTTLE: main emits one event per HOUR (168 across a week). Painting all of them is pointless —
// the eye cannot read 168 updates. Events are coalesced into a ref and flushed on a 250ms timer
// (~4/sec), so the bar moves smoothly while React commits 4 times a second instead of 168 times.

const FLUSH_MS = 250;
const HIDE_AFTER_MS = 4000;

interface Progress {
  dayIdx: number;
  dayTotal: number;
  day: string;
  hoursDone: number;
  hoursTotal: number;
  finished: boolean;
  cancelled: boolean;
  count: number;
  error?: string;
}

const START: Progress = {
  dayIdx: 0, dayTotal: 0, day: "", hoursDone: 0, hoursTotal: 24,
  finished: false, cancelled: false, count: 0,
};

export default function GenerateProgressBar() {
  const [state, setState] = useState<Progress | null>(null);
  const pending = useRef<Progress | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let flush: ReturnType<typeof setInterval> | null = null;
    const clearHide = () => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; } };

    const startFlush = () => {
      if (flush) return;
      flush = setInterval(() => {
        if (pending.current) { setState(pending.current); pending.current = null; }
      }, FLUSH_MS);
    };
    const stopFlush = () => { if (flush) { clearInterval(flush); flush = null; } };

    const onProgress = (p: any) => {
      if (!p) return;
      if (p.phase === "start") {
        clearHide();
        setCancelling(false);
        pending.current = { ...START, dayTotal: p.dayTotal || 1, day: p.day || "" };
        setState(pending.current);          // paint the first frame immediately — no 250ms dead time
        pending.current = null;
        startFlush();
        return;
      }
      if (p.phase === "hour") {
        pending.current = {
          ...(pending.current || state || START),
          dayIdx: p.dayIdx ?? 0,
          dayTotal: p.dayTotal || (state?.dayTotal ?? 1),
          day: p.day || (state?.day ?? ""),
          hoursDone: p.hoursDone ?? 0,
          hoursTotal: p.hoursTotal ?? 24,
          finished: false, cancelled: false,
          count: p.rows ?? 0,
        };
        return;
      }
      if (p.phase === "day-committed") {
        pending.current = {
          ...(pending.current || state || START),
          dayIdx: (p.dayIdx ?? 0) + 1,
          dayTotal: p.dayTotal || (state?.dayTotal ?? 1),
          day: p.day || (state?.day ?? ""),
          hoursDone: 24, hoursTotal: 24,
          finished: false, cancelled: false,
        };
        return;
      }
      if (p.phase === "end") {
        stopFlush();
        pending.current = null;
        setState(prev => ({
          ...(prev || START),
          dayTotal: p.dayTotal || prev?.dayTotal || 1,
          dayIdx: p.daysCommitted ?? prev?.dayIdx ?? 0,
          finished: true,
          cancelled: !!p.cancelled,
          count: p.count ?? prev?.count ?? 0,
          error: p.error,
        }));
        clearHide();
        hideTimer.current = setTimeout(() => setState(null), HIDE_AFTER_MS);
      }
    };

    const handle = (window as any).ether?.on?.("schedule:generate-progress", onProgress);
    return () => {
      try { (window as any).ether?.off?.("schedule:generate-progress", handle); } catch { /* ignore */ }
      stopFlush(); clearHide();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state) return null;

  const dayTotal = Math.max(1, state.dayTotal);
  // Day-by-day progress with the in-flight day's hours as the fractional part, so the bar keeps
  // creeping during a long day instead of sitting still for ~100s.
  const withinDay = state.finished ? 0 : Math.min(1, (state.hoursDone || 0) / (state.hoursTotal || 24));
  const pct = state.finished
    ? 100
    : Math.min(100, 100 * (Math.min(state.dayIdx, dayTotal) + withinDay) / dayTotal);

  const label = state.error
    ? `Generate failed — ${state.error}`
    : state.cancelled
      ? `Canceled · ${state.dayIdx} of ${dayTotal} day${dayTotal === 1 ? "" : "s"} kept`
      : state.finished
        ? `Generated ${state.count.toLocaleString()} item${state.count === 1 ? "" : "s"} · ${dayTotal} day${dayTotal === 1 ? "" : "s"}`
        : `Generating ${state.day || "schedule"} · day ${Math.min(state.dayIdx + 1, dayTotal)} of ${dayTotal}`;

  const accent = state.error ? "#fca5a5" : state.cancelled ? "#fbbf24" : "var(--accent-green)";

  const cancel = async () => {
    setCancelling(true);
    try { await (window as any).ether.invoke("schedule:generateCancel"); } catch { /* ignore */ }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        // Sits directly above the 52px footer (station badge), hugging the left edge.
        bottom: 58, left: 10,
        zIndex: 260,
        width: 320, maxWidth: "42vw",
        background: "rgba(18,18,26,0.97)",
        border: "1px solid var(--border-primary)",
        borderLeft: `3px solid ${accent}`,
        boxShadow: "0 6px 22px rgba(0,0,0,0.45)",
        padding: "9px 11px 10px",
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 700, color: accent,
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "0.01em" }}>
          {label}
        </span>
        {!state.finished && (
          <button
            onClick={cancel}
            disabled={cancelling}
            title="Stop generating. Days already finished are kept."
            style={{
              flexShrink: 0, padding: "3px 9px", borderRadius: 0,
              fontSize: 10, fontWeight: 800, letterSpacing: "0.06em",
              background: "transparent", color: cancelling ? "var(--text-tertiary)" : "#fca5a5",
              border: `1px solid ${cancelling ? "var(--border-primary)" : "rgba(252,165,165,0.45)"}`,
              cursor: cancelling ? "default" : "pointer",
            }}
          >
            {cancelling ? "STOPPING…" : "CANCEL"}
          </button>
        )}
      </div>
      <div style={{ height: 5, background: "var(--bg-tertiary)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: accent, transition: "width 0.25s linear" }} />
      </div>
      {!state.finished && (
        <div style={{ marginTop: 5, fontSize: 9, color: "var(--text-tertiary)", letterSpacing: "0.04em" }}>
          The app stays usable while this runs.
        </div>
      )}
    </div>
  );
}
