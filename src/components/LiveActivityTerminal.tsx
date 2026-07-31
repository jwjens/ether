// ── LIVE ACTIVITY TERMINAL ────────────────────────────────────────────────────────────────────────
// The operator's window onto what Ether is doing right now. It TAILS the log the daemon already
// writes (ether-audiod.log) — no new event system, no new instrumentation, nothing added to the
// daemon. Display-only: this pane reads, it never acts.
//
// Efficiency: `activity:tail` follows the file from a byte offset (main.js) and we hold the cursor
// here, so each poll transfers only what was appended. Rotation is signalled back as `reset`.
import { useCallback, useEffect, useRef, useState } from "react";

// Keep the buffer bounded — an always-on pane must never grow without limit.
const MAX_LINES = 800;
const POLL_MS = 1000;

type Level = "routine" | "decision" | "warning";

export type ActivityLine = {
  key: number;
  ts: string;          // HH:MM:SS, from the log's own ISO stamp
  station: number | null;
  level: Level;
  text: string;        // the message, source tags stripped
  raw: string;
};

// ── classification ────────────────────────────────────────────────────────────────────────────────
// WARNING  — something the operator should look at: the liveDeck observer, stalls, forced stops,
//            guards, errors, log-reader "behind".
// DECISION — the engine changed what is on air: rotate/segue/stop/top-of-hour/jingle fire/skip.
// ROUTINE  — everything else, dominated by the 250 ms `[mix sN]` heartbeat and drain lines.
// Matched against the RAW line so the source tag (`[engine s4]`, `[RUST]`) counts too.
// NOTE on the observer: only "TWO DECKS ON AIR" is a warning. `liveDeck OBSERVER — foreign deck
// cleared` fires on ordinary segue overlaps too (the daemon sets its start-marker before the grace and
// logs the clear regardless), so it is NOT a warning — treating it as one would flag every rotation.
//
// 2026-07-30 — the LOG-READER lines were all landing in `routine` and therefore HIDDEN by default,
// including `LOG-READER FLOOR` (the log ran dry and the emergency fill took over — dead-air-adjacent)
// and the behind/missed catch-up. `LOG-READER FLOOR` and `LOG-READER: behind` are warnings; everything
// else the reader decides is a DECISION and belongs beside rotates and stops.
const WARNING_RE = /liveDeck OBSERVER — TWO DECKS|watchdog: STALL|Bug-A guard|play-skip GUARD|FORCE stop|\[ERROR\]|\[WARN\]|advance ✗|\berrors?\b|\bfailed\b|SHADOW\] behind|LOG-READER FLOOR|LOG-READER: behind|autofit: window .* NO FIT|autofit: .*hard cut will trim|emergency floor|dead-file|unresolvable|logreader-(missed|floor)/i;
const DECISION_RE = /deck [A-F] LIVE|segue overlap|advance → (handleRotate|stop:|top-of-hour|jingle-fire|skip)|top-of-hour|jingle (FIRE|FIRING|ARMED|BRIDGING)|automationStart|automationStop|deck [A-F] ended|clean spot edge|refill:|engine-state →|resume-playout|liveDeck (OBSERVER|GUARD)|LOG-READER|logreader|nearest-anchor|autofit/i;

function classify(raw: string): Level {
  if (WARNING_RE.test(raw)) return "warning";
  if (DECISION_RE.test(raw)) return "decision";
  return "routine";
}

// Log shape: `2026-07-30T14:19:10.374Z [INFO] [engine s4] message`
// Station also appears as `[mix s4]` and `[RUST] Station 4 drain: …`.
const LINE_RE = /^(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})[.\d]*Z)?\s*(\[[A-Z]+\]\s*)?(.*)$/;
const STATION_RE = /\[(?:engine|mix|stream) s(\d+)\]|Station (\d+)/;

let _seq = 0;

export function parseActivityLine(raw: string): ActivityLine {
  const m = LINE_RE.exec(raw);
  const hhmmss = m?.[2] || "";
  let body = (m?.[4] ?? raw).trim();
  const sm = STATION_RE.exec(raw);
  const station = sm ? parseInt(sm[1] || sm[2], 10) : null;
  // Strip the source tag from the display text — the station is shown as its own column.
  body = body.replace(/^\[(?:engine|mix|stream) s\d+\]\s*/, "").replace(/^\[RUST\]\s*/, "");
  return { key: _seq++, ts: hhmmss, station, level: classify(raw), text: body, raw };
}

// Per-station colour. Deliberately not the brand purple — these are data hues, and purple is the
// app's own accent (see the brand rule); reusing it would read as "selected", not "station 1".
const STATION_COLOR: Record<number, string> = {
  1: "#4ea1ff",   // blue
  2: "#f0a020",   // amber
  3: "#3fbf7f",   // green
  4: "#e2568d",   // pink
};
const LEVEL_COLOR: Record<Level, string> = {
  routine: "var(--text-tertiary)",
  decision: "var(--text-secondary)",
  warning: "#f87171",
};

export function LiveActivityTerminal() {
  const [lines, setLines] = useState<ActivityLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [station, setStation] = useState<number | "all">("all");
  const [showRoutine, setShowRoutine] = useState(false);   // default: decisions + warnings only
  const [warnOnly, setWarnOnly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stations, setStations] = useState<number[]>([]);

  const offsetRef = useRef<number>(-1);          // -1 seeds from the tail on the first call
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // ── the tail loop ───────────────────────────────────────────────────────────────────────────────
  // Runs regardless of `paused` so no activity is lost while the operator reads; pausing only stops
  // the view from auto-scrolling. The buffer is trimmed on every append.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await (window as any).ether?.activity?.tail(offsetRef.current);
        if (stop || !r) return;
        if (!r.ok) { setErr(r.error || "cannot read the daemon log"); return; }
        setErr(null);
        offsetRef.current = r.offset;
        if (r.reset) setLines(prev => [...prev, parseActivityLine("— log rotated —")]);
        if (r.lines?.length) {
          const parsed = r.lines.map(parseActivityLine);
          setLines(prev => {
            const next = prev.concat(parsed);
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
          setStations(prev => {
            const seen = new Set(prev);
            for (const p of parsed) if (p.station != null) seen.add(p.station);
            return seen.size === prev.length ? prev : Array.from(seen).sort((a, b) => a - b);
          });
        }
      } catch { /* bridge absent (browser/dev) — the pane just stays empty */ }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { stop = true; clearInterval(id); };
  }, []);

  const visible = lines.filter(l => {
    if (station !== "all" && l.station !== station) return false;
    if (warnOnly) return l.level === "warning";
    if (!showRoutine && l.level === "routine") return false;
    return true;
  });

  // Auto-scroll to newest unless the operator has paused (scroll-lock).
  useEffect(() => {
    if (paused) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, paused]);

  // Scrolling away from the bottom engages the lock automatically — reading shouldn't fight the feed.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || pausedRef.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 40) setPaused(true);
  }, []);

  const jumpToLive = () => {
    setPaused(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const btn = (active: boolean) => ({
    background: active ? "var(--bg-tertiary, rgba(255,255,255,0.09))" : "none",
    border: "1px solid var(--border-primary)",
    color: active ? "var(--text-secondary)" : "var(--text-tertiary)",
    fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase" as const,
    padding: "2px 7px", cursor: "pointer", borderRadius: 0, fontWeight: 700,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, height: "100%", minHeight: 0 }}>
      {/* header + controls */}
      <div style={{ flexShrink: 0, padding: "16px 20px 10px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>
            Live Activity
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: paused ? "var(--text-tertiary)" : "var(--accent-green)",
              animation: paused ? "none" : "nominal-pulse 2.4s ease-in-out infinite",
            }} />
            <button onClick={paused ? jumpToLive : () => setPaused(true)} style={btn(paused)}>
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4, marginBottom: 6 }}>
          <button onClick={() => setStation("all")} style={btn(station === "all")}>All</button>
          {stations.map(s => (
            <button key={s} onClick={() => setStation(s)} style={{ ...btn(station === s), color: station === s ? (STATION_COLOR[s] || "var(--text-secondary)") : "var(--text-tertiary)" }}>
              s{s}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4 }}>
          <button onClick={() => { setWarnOnly(false); setShowRoutine(false); }} style={btn(!warnOnly && !showRoutine)}>Decisions</button>
          <button onClick={() => { setWarnOnly(false); setShowRoutine(true); }} style={btn(!warnOnly && showRoutine)}>All activity</button>
          <button onClick={() => setWarnOnly(true)} style={btn(warnOnly)}>Warnings</button>
        </div>
        <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 7, fontStyle: "italic" }}>
          {err
            ? err
            : `${visible.length} shown of ${lines.length} buffered${paused ? " · scroll-locked" : ""}`}
        </div>
      </div>

      {/* the terminal */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          flex: 1, minHeight: 0, overflowY: "auto" as const,
          margin: "0 20px 20px", padding: "8px 10px",
          background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
          fontFamily: "'DM Mono', ui-monospace, monospace", fontSize: 10, lineHeight: 1.55,
        }}
      >
        {visible.length === 0 ? (
          <div style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>
            {err
              ? "The daemon log is not readable yet. It appears once the audio daemon has started."
              : lines.length === 0
                ? "Waiting for activity from the audio daemon…"
                : "Nothing matches this filter — try All activity."}
          </div>
        ) : visible.map(l => (
          <div key={l.key} style={{ display: "flex", gap: 7, whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const }}>
            <span style={{ color: "var(--text-tertiary)", opacity: 0.7, flexShrink: 0 }}>{l.ts}</span>
            {l.station != null && (
              <span style={{ color: STATION_COLOR[l.station] || "var(--text-tertiary)", fontWeight: 700, flexShrink: 0 }}>
                s{l.station}
              </span>
            )}
            <span style={{
              color: LEVEL_COLOR[l.level],
              fontWeight: l.level === "warning" ? 700 : 400,
              opacity: l.level === "routine" ? 0.6 : 1,
            }}>
              {l.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
