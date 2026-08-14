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
import { eventLevel, eventTitle, eventSummary, eventTime, levelColor, isRoutine } from "./healthUtils";
import { HealthSection } from "./HealthSection";

const SHOW = 20;
// Fetch WIDER than we show, because the routine senses are ~85% of the ledger: asking for 20 raw
// rows returns 20 heartbeats and nothing else. 240 in, filtered down to 20 notable.
const FETCH = 240;
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
        style={{ display: "flex", alignItems: "center", gap: "var(--s-4, 8px)",
                 padding: "var(--s-3, 6px) var(--s-2, 4px)",
                 cursor: hasDetail ? "pointer" : "default" }}>

        {/* The dot sits in a tinted well. A bare 7px dot next to 10px grey text disappears; the well
            gives the severity a shape the eye can scan down the column. */}
        <span style={{ width: 18, height: 18, flexShrink: 0, borderRadius: "var(--r-full, 999px)",
                       background: `color-mix(in srgb, ${color} 16%, transparent)`,
                       display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ width: 7, height: 7, borderRadius: "var(--r-full, 999px)", background: color }} />
        </span>

        <span style={{ width: 66, flexShrink: 0, fontSize: 11, fontFamily: "'DM Mono', monospace",
                       fontVariantNumeric: "tabular-nums", color: "var(--text-tertiary)" }}>
          {eventTime(e.t)}
        </span>
        <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, color: "var(--text-primary)",
                       whiteSpace: "nowrap" }}>
          {eventTitle(e.kind)}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text-tertiary)",
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary}
        </span>
        {hasDetail && (
          <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-tertiary)" }}>{open ? "▾" : "▸"}</span>
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
  const [raw, setRaw] = useState<LedgerEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await (window as any).ether?.invoke?.("health:recent-events", { limit: FETCH });
      if (r && r.ok) {
        setRaw(Array.isArray(r.rows) ? r.rows : []);      // the handler already returns newest-first
        setErr(null);
        setNote(r.note || null);
      } else {
        // Surfaced, not swallowed — an unreadable ledger is itself worth seeing.
        setErr((r && r.error) || "could not read the health ledger");
      }
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, []);

  const routineCount = raw.filter(e => isRoutine(e.kind)).length;
  const events = (showAll ? raw : raw.filter(e => !isRoutine(e.kind))).slice(0, SHOW);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <HealthSection
      title="Live events"
      pad={false}
      right={
        <span style={{ display: "flex", alignItems: "center", gap: "var(--s-2, 4px)" }}>
          {/* NOTHING IS HIDDEN, it is only deprioritised. The count says exactly how many routine
              rows are being held back, so the filter can never be mistaken for an empty ledger. */}
          {routineCount > 0 && (
            <button onClick={() => setShowAll(v => !v)}
              title={showAll
                ? "Hide the periodic senses (library health, queue lint) and show only notable events"
                : `Also show the ${routineCount} periodic sense entries — heartbeats recorded every couple of minutes`}
              style={{ fontSize: "var(--t-micro, 9px)", fontWeight: 800, letterSpacing: "0.08em",
                       padding: "2px 8px", cursor: "pointer", borderRadius: "var(--r-0, 0px)",
                       background: showAll ? "var(--bg-active)" : "transparent",
                       border: "1px solid var(--border-primary)",
                       color: showAll ? "var(--text-secondary)" : "var(--text-tertiary)" }}>
              {showAll ? "NOTABLE ONLY" : `ALL (+${routineCount})`}
            </button>
          )}
          <button onClick={load} title="Re-read the health ledger. A plain read — it changes nothing."
            style={{ fontSize: "var(--t-micro, 9px)", fontWeight: 800, letterSpacing: "0.08em",
                     padding: "2px 8px", background: "transparent",
                     border: "1px solid var(--border-primary)", color: "var(--text-tertiary)",
                     cursor: "pointer", borderRadius: "var(--r-0, 0px)" }}>RELOAD</button>
        </span>
      }>
      {err && (
        <div style={{ fontSize: 11, color: "var(--accent-red)", padding: "var(--s-3, 6px) var(--s-5, 12px)" }}>{err}</div>
      )}

      {events.length === 0 && !err ? (
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.6,
                      padding: "var(--s-4, 8px) var(--s-5, 12px)" }}>
          {note === "no ledger yet"
            ? "No events recorded yet. Generates, designation changes, log edits and sync failures appear here as they happen."
            : routineCount > 0
              ? `Nothing notable in the recent window — only ${routineCount} routine health checks. That is the quiet you want. Press ALL to see them.`
              : "No events in the recent window."}
        </div>
      ) : (
        // Bounded height with its own scroll: 20 rows should not push the rest of the panel down.
        <div style={{ maxHeight: 300, overflowY: "auto", padding: "0 var(--s-4, 8px)" }}>
          {events.map((e, i) => <EventRow key={`${e.t}-${e.kind}-${i}`} e={e} />)}
        </div>
      )}
    </HealthSection>
  );
}

export const HealthTimeline = memo(HealthTimelineImpl);
export default HealthTimeline;
