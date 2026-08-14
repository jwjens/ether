// ── SpotTimeline — where the breaks fall, and how far off they are ─────────────────────────────
//
// This section was a four-column table of timestamps. Every question an operator actually asks it is
// spatial — are the breaks bunched, is there a gap, is the next one close — and a column of
// "1:19:50 PM" answers none of them without being read line by line.
//
// TWO VIEWS, because one cannot carry both scales honestly:
//
//   The LANES answer "where are the breaks". One lane per hour, full width = 60 minutes, so a
//   marker's position IS its minute. Drift cannot be shown here: 60 seconds of drift is 1.6% of an
//   hour, a sub-pixel nudge. Drawing it would imply a precision the lane does not have.
//
//   The DRIFT BARS answer "how far off". Centred on the anchor at ±90s, where 60 seconds is a third
//   of the bar. Same rows, second scale, stated as such.
//
// Display-only, like the table it replaces: reads projected spots, issues nothing, writes nothing.
import { useEffect, useState } from "react";
import { driftLevel, fmtDrift, fmtClock, type ProjectedSpot } from "../../lib/spotProjection";
import { PanelMeter } from "./sectionChrome";

const HOUR = 3600;
/** Full-scale of the drift bars. 90s puts the red threshold (60s) two thirds out, so "late" is
 *  visible well before it is terminal — the whole point of the projected column. */
const DRIFT_SPAN = 90;

function driftColor(lvl: ReturnType<typeof driftLevel>): string {
  return lvl === "ok" ? "var(--accent-green)"
       : lvl === "warn" ? "var(--accent-amber)"
       : lvl === "error" ? "var(--accent-red)"
       : "var(--text-tertiary)";
}

/** "1 PM" — the lane's name. */
function hourName(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString([], { hour: "numeric", hour12: true });
}
/** ":07" — a marker's minute, which is the only part of the time the lane is showing. */
function minuteName(sec: number): string {
  return `:${String(new Date(sec * 1000).getMinutes()).padStart(2, "0")}`;
}

/** A clock that ticks on its own. The spot poll is slower than a minute, and the NOW line drifting
 *  behind the real time would make the panel quietly wrong about the one thing it is for. */
function useNowSec(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function SpotTimeline({ rows }: { rows: ProjectedSpot[] }) {
  const now = useNowSec();

  const anchors = rows.map(r => r.scheduledAt).filter(n => Number.isFinite(n));
  if (anchors.length === 0) return null;

  // The window always contains NOW as well as every anchor, so "no breaks for the next 40 minutes"
  // is visible as empty track rather than by the section starting an hour from now.
  const first = Math.floor(Math.min(now, ...anchors) / HOUR) * HOUR;
  const last = Math.floor(Math.max(now, ...anchors) / HOUR) * HOUR;
  const lanes: number[] = [];
  for (let h = first; h <= last && lanes.length < 6; h += HOUR) lanes.push(h);

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3, 6px)" }}>
        {lanes.map(h => {
          const inLane = rows.filter(r => r.scheduledAt >= h && r.scheduledAt < h + HOUR);
          const nowHere = now >= h && now < h + HOUR;
          return (
            <div key={h} style={{ display: "flex", alignItems: "center", gap: "var(--s-3, 6px)" }}>
              <span style={{ width: 52, flexShrink: 0, fontSize: "var(--t-body, 12px)", fontWeight: 700,
                             color: "var(--text-secondary)" }}>{hourName(h)}</span>
              <div style={{ flex: 1, minWidth: 120, height: 30, position: "relative",
                            background: "var(--bg-primary)", border: "1px solid var(--border-primary)" }}>
                {/* Quarter-hour rules — enough to read a marker's minute off the track, few enough
                    not to compete with the markers themselves. */}
                {[25, 50, 75].map(p => (
                  <div key={p} style={{ position: "absolute", left: `${p}%`, top: 0, bottom: 0,
                                        width: 1, background: "var(--border-primary)", opacity: 0.6 }} />
                ))}
                {nowHere && (
                  <div title="now" style={{
                    position: "absolute", left: `${((now - h) / HOUR) * 100}%`, top: -2, bottom: -2,
                    width: 2, background: "var(--text-primary)", opacity: 0.9,
                  }} />
                )}
                {inLane.map((s, i) => {
                  const lvl = driftLevel(s.driftSec);
                  const played = s.state === "played" || !!s.playedAt;
                  const left = ((s.scheduledAt - h) / HOUR) * 100;
                  return (
                    <div
                      key={`${s.scheduledAt}-${i}`}
                      title={[
                        `anchor ${fmtClock(s.scheduledAt)}`,
                        played ? `fired ${fmtClock(s.playedAt)}` : `projected ${s.beyondQueue ? "≥ " : ""}${fmtClock(s.projectedAt)}`,
                        `drift ${fmtDrift(s.driftSec)}`,
                        s.hardCutOwned ? "top-of-hour hard cut" : null,
                      ].filter(Boolean).join(" · ")}
                      style={{
                        position: "absolute", left: `${left}%`, top: 3, bottom: 3, width: 5,
                        marginLeft: -2,
                        background: driftColor(lvl),
                        // Pending breaks are hollow, aired ones solid: the timeline says what has
                        // happened and what is still to come without needing a legend for it.
                        opacity: played ? 1 : 0.45,
                        border: played ? "none" : `1px solid ${driftColor(lvl)}`,
                      }}
                    />
                  );
                })}
              </div>
              <span style={{ width: 92, flexShrink: 0, textAlign: "right" as const,
                             fontSize: "var(--t-small, 10px)", fontFamily: "'DM Mono', monospace",
                             color: "var(--text-tertiary)" }}>
                {inLane.length === 0 ? "no breaks" : `${inLane.length} break${inLane.length === 1 ? "" : "s"}`}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 13, color: "var(--text-tertiary)", margin: "var(--s-5, 12px) 0 var(--s-4, 8px)", lineHeight: 1.45 }}>
        Drift from anchor — centre is on time, right is late. Green ≤15s · amber ≤60s · red beyond.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3, 6px)" }}>
        {rows.map((s, i) => {
          const lvl = driftLevel(s.driftSec);
          const played = s.state === "played" || !!s.playedAt;
          const d = s.driftSec;
          const mag = d == null || !Number.isFinite(d) ? 0 : Math.min(50, (Math.abs(d) / DRIFT_SPAN) * 50);
          const late = (d ?? 0) >= 0;
          return (
            <PanelMeter
              key={`${s.scheduledAt}-${i}`}
              label={minuteName(s.scheduledAt)}
              from={late ? 50 : 50 - mag}
              pct={mag}
              tickPct={50}
              tickColor="var(--border-secondary)"
              color={driftColor(lvl)}
              read={(!played && s.beyondQueue && d !== null ? "≥ " : "") + fmtDrift(d)}
              readTone={lvl === "error" ? "var(--accent-red)" : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
