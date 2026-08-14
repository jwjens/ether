// ── HealthTimeline — the last events, newest first ──────────────────────────────────────────────
//
// Health Monitor redesign, Phase 3. Reads the honest ledger (health-events.jsonl) through the
// existing `health:recent-events` IPC added in 4.4.195 — bounded by tail bytes, because that file
// has no rotation and reading it whole would eventually stall the panel.
//
// NOT the Live Activity terminal. That tails the DAEMON's log (ether-audiod.log) and shows playout
// chatter; this shows what the MAIN PROCESS recorded — generates, designation changes, log edits,
// sync failures. Main-process events have never had an on-screen home until now.
import { memo, useCallback, useEffect, useState } from "react";
import { eventLevel, eventTitle, eventSummary, eventTime, levelColor } from "./healthUtils";

const LIMIT = 20;
const POLL_MS = 15_000;

interface LedgerEvent { t?: string; kind?: string; [k: string]: any; }

function EventRow({ e }: { e: LedgerEvent }) {
  const [open, setOpen] = useState(false);
  const level = eventLevel(e.kind);
  const color = levelColor(level);
  const summary = eventSummary(e);
  // Everything except the two fields already on the line — that is what "more details" means.
  const rest = Object.fromEntries(Object.entries(e).filter(([k]) => k !== "t" && k !== "kind"));
  const hasDetail = Object.keys(rest).length > 0;

  return (
    <div style={{ borderBottom: "1px solid var(--border-primary)" }}>
      <div
        onClick={hasDetail ? () => setOpen(o => !o) : undefined}
        role={hasDetail ? "button" : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        onKeyDown={hasDetail ? (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setOpen(o => !o); } } : undefined}
        title={hasDetail ? "Click for the full record" : undefined}
        style={{ display: "flex", alignItems: "baseline", gap: "var(--s-3, 6px)", padding: "3px 0",
                 cursor: hasDetail ? "pointer" : "default" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0,
                       alignSelf: "center" }} />
        <span style={{ width: 62, flexShrink: 0, fontSize: 10, fontFamily: "'DM Mono', monospace",
                       color: "var(--text-tertiary)" }}>
          {eventTime(e.t)}
        </span>
        <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, color: "var(--text-secondary)",
                       whiteSpace: "nowrap" }}>
          {eventTitle(e.kind)}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text-tertiary)",
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary}
        </span>
        {hasDetail && (
          <span style={{ flexShrink: 0, fontSize: 9, color: "var(--text-tertiary)" }}>{open ? "▾" : "▸"}</span>
        )}
      </div>
      {open && (
        <pre style={{ margin: "0 0 6px 75px", padding: "6px 8px", background: "var(--bg-tertiary)",
                      border: "1px solid var(--border-primary)", fontSize: 10, lineHeight: 1.5,
                      fontFamily: "'DM Mono', monospace", color: "var(--text-secondary)",
                      whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto" }}>
          {JSON.stringify(rest, null, 2)}
        </pre>
      )}
    </div>
  );
}

function HealthTimelineImpl() {
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await (window as any).ether?.invoke?.("health:recent-events", { limit: LIMIT });
      if (r && r.ok) {
        setEvents(Array.isArray(r.rows) ? r.rows : []);   // the handler already returns newest-first
        setErr(null);
        setNote(r.note || null);
      } else {
        // Surfaced, not swallowed — an unreadable ledger is itself worth seeing.
        setErr((r && r.error) || "could not read the health ledger");
      }
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div style={{ marginTop: "var(--s-3, 6px)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    marginBottom: "var(--s-2, 4px)" }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em",
                      color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>
          Live events
        </div>
        <button onClick={load} title="Re-read the health ledger. A plain read — it changes nothing."
          style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.08em", padding: "2px 8px",
                   background: "transparent", border: "1px solid var(--border-primary)",
                   color: "var(--text-tertiary)", cursor: "pointer", borderRadius: 0 }}>RELOAD</button>
      </div>

      {err && <div style={{ fontSize: 10, color: "var(--accent-red)", marginBottom: 4 }}>{err}</div>}

      {events.length === 0 && !err ? (
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
          {note === "no ledger yet"
            ? "No events recorded yet. Generates, designation changes, log edits and sync failures appear here as they happen."
            : "No events in the recent window."}
        </div>
      ) : (
        <div>{events.map((e, i) => <EventRow key={`${e.t}-${e.kind}-${i}`} e={e} />)}</div>
      )}
    </div>
  );
}

export const HealthTimeline = memo(HealthTimelineImpl);
export default HealthTimeline;
