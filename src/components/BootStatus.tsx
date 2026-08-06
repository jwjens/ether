import { useEffect, useState } from "react";

// What startup actually did — shown in the app, dismissable, never a decision.
//
// WHY THIS EXISTS: a pause with no explanation reads as a freeze. Even a fast database repair, done
// silently, looks like the app hung or is eating the machine — the same panic the Generate progress bar
// fixed. The splash says what is happening WHILE it happens; this says what happened, with timings, so
// an engineer can see "Repaired station database — 0.3s" instead of guessing, and an operator who does
// not care closes it with the X. The work is already complete either way.
//
// Shows itself only when there is something worth saying: a repair, or startup work slow enough to be
// noticed. A clean, fast launch stays out of the way entirely.

interface Step { label: string; ms: number; ok: boolean; error?: string; repair?: boolean }

const NOTICEABLE_MS = 400;   // below this nobody wonders what happened
const AUTO_HIDE_MS  = 12000; // a repair stays long enough to be read, then gets out of the way

export default function BootStatus() {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [open, setOpen]   = useState(true);

  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const onReport = (p: any) => {
      const all: Step[] = Array.isArray(p?.steps) ? p.steps : [];
      const repaired = all.some(s => s.repair);
      const failed   = all.some(s => !s.ok);
      const slow     = all.some(s => (s.ms || 0) >= NOTICEABLE_MS);
      // Nothing notable → say nothing. Silence is correct when the launch was clean and quick.
      if (!repaired && !failed && !slow) return;
      setSteps(all);
      setOpen(true);
      if (!failed) hideTimer = setTimeout(() => setOpen(false), AUTO_HIDE_MS);
    };
    const handle = (window as any).ether?.on?.("boot:report", onReport);
    return () => {
      try { (window as any).ether?.off?.("boot:report", handle); } catch { /* ignore */ }
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  if (!steps || !open) return null;

  const repaired = steps.some(s => s.repair);
  const failed   = steps.filter(s => !s.ok);
  const total    = steps.reduce((n, s) => n + (s.ms || 0), 0);
  const accent   = failed.length ? "#fca5a5" : repaired ? "var(--accent-green)" : "var(--accent-blue)";
  const title    = failed.length
    ? "Startup finished with a problem"
    : repaired
      ? "Ether repaired your station database"
      : "Startup";

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed", bottom: 58, left: 10, zIndex: 255,
        width: 340, maxWidth: "44vw",
        background: "rgba(18,18,26,0.97)",
        border: "1px solid var(--border-primary)", borderLeft: `3px solid ${accent}`,
        boxShadow: "0 6px 22px rgba(0,0,0,0.45)",
        padding: "9px 11px 10px",
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 700, color: accent,
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
        <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-tertiary)",
                       fontFamily: "'DM Mono', monospace" }}>
          {(total / 1000).toFixed(1)}s
        </span>
        <button
          onClick={() => setOpen(false)}
          title="Dismiss — everything is already done"
          aria-label="Dismiss"
          style={{
            flexShrink: 0, width: 18, height: 18, lineHeight: "16px",
            background: "transparent", color: "var(--text-tertiary)",
            border: "1px solid var(--border-primary)", borderRadius: 0,
            fontSize: 11, cursor: "pointer", padding: 0,
          }}
        >×</button>
      </div>

      {repaired && (
        <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.45, marginBottom: 6 }}>
          Your library, schedule and airplay history are exactly as you left them.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 10 }}>
            <span style={{ flex: 1, minWidth: 0, color: s.ok ? "var(--text-tertiary)" : "#fca5a5",
                           overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.ok ? "" : "⚠ "}{s.label}
            </span>
            <span style={{ flexShrink: 0, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>
              {s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)}s` : `${s.ms}ms`}
            </span>
          </div>
        ))}
      </div>

      {failed.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 10, color: "var(--text-tertiary)", lineHeight: 1.4 }}>
          {failed[0].error}
        </div>
      )}
    </div>
  );
}
