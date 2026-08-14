// ── HealthMeters — deck levels and the loudness chain ───────────────────────────────────────────
//
// Health Monitor v2, the meters.
//
// THE LEVELS CHANNEL NEVER TOUCHES REACT STATE. `audio:levels` runs ~90 frames/sec and main.js:670
// records it as "implicated in a renderer OOM". Driving setState from it would re-render this
// subtree ninety times a second inside a panel that is already heavy. Every frame is written
// STRAIGHT TO THE DOM through a ref — one style.width assignment per deck — so React renders this
// component once and then gets out of the way.
//
// Two meters, two scales, because there are two measurements (see meterScale.ts):
//   DECKS   — audio:levels, linear amplitude → dBFS. Answers "am I about to clip?"; monotonic ramp.
//   PROGRAM — audio:proc-meters, LUFS against target. Answers "am I on target?"; band around it,
//             because too quiet is as wrong as too loud.
import { memo, useEffect, useRef, useState } from "react";
import { HealthSection } from "./HealthSection";
import {
  ampToDbfs, dbToPercent, peakLevel, loudnessLevel, peakHold,
  METER_COLOR, METER_WORD, fmtDb, type PeakHoldState,
} from "./meterScale";

const DECKS = ["A", "B", "C"] as const;
type Deck = typeof DECKS[number];

interface ProcMeters {
  local?: boolean; stream?: boolean; target?: number;
  inLufs?: number; outLufs?: number; grDb?: number; rideGainDb?: number;
  inPeakDb?: number; outPeakDb?: number;
}

/** One deck's row. Everything that moves is written by ref; this renders once. */
function DeckMeter({ deck, refs }: {
  deck: Deck;
  refs: { fill: (el: HTMLDivElement | null) => void; peak: (el: HTMLDivElement | null) => void;
          text: (el: HTMLSpanElement | null) => void };
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3, 6px)", padding: "var(--s-2, 4px) 0" }}>
      <span style={{ width: 52, flexShrink: 0, fontSize: "var(--t-body, 12px)", fontWeight: 700,
                     color: "var(--text-secondary)" }}>Deck {deck}</span>
      <div style={{ flex: 1, minWidth: 60, height: 14, background: "var(--bg-primary)",
                    border: "1px solid var(--border-primary)", position: "relative", overflow: "hidden" }}>
        <div ref={refs.fill} style={{ height: "100%", width: "0%", background: "var(--text-tertiary)",
                                      transition: "width 90ms linear" }} />
        {/* Peak-hold marker: rides the peak, holds 1.2s, then falls at 20 dB/s. */}
        <div ref={refs.peak} style={{ position: "absolute", top: 0, height: "100%", width: 2,
                                      left: "0%", background: "var(--text-primary)", opacity: 0.85 }} />
        {/* The -6 dBFS mark, so "hot" has a visible reference on the bar itself. */}
        <div style={{ position: "absolute", top: 0, height: "100%", width: 1, opacity: 0.35,
                      left: `${dbToPercent(-6)}%`, background: "var(--accent-amber)" }} />
      </div>
      <span ref={refs.text} style={{ width: 92, flexShrink: 0, textAlign: "right" as const,
                                     fontSize: "var(--t-small, 10px)", fontFamily: "'DM Mono', monospace",
                                     fontVariantNumeric: "tabular-nums", color: "var(--text-tertiary)" }}>—</span>
    </div>
  );
}

function HealthMetersImpl({ stationUuid }: { stationUuid?: string | null }) {
  const fills = useRef<Record<string, HTMLDivElement | null>>({});
  const peaks = useRef<Record<string, HTMLDivElement | null>>({});
  const texts = useRef<Record<string, HTMLSpanElement | null>>({});
  const holds = useRef<Record<string, PeakHoldState | null>>({});
  // Whether any level frame has arrived. State, but it flips once — not per frame.
  const [live, setLive] = useState(false);
  const [proc, setProc] = useState<ProcMeters | null>(null);

  // ── deck levels — ref-driven, never setState ──────────────────────────────────────────────────
  useEffect(() => {
    const eth = (window as any).ether;
    if (!eth?.audio?.onLevels) return;
    let sawFrame = false;

    const handler = (lvl: any) => {
      if (!lvl) return;
      // Station scoping, mirroring electron/levels-scope.js matchesStation: a frame carrying another
      // station's uuid must not drive this station's meters (the VU crosstalk bug, 2026-07-08).
      if (stationUuid && lvl.stationUuid != null && lvl.stationUuid !== stationUuid) return;
      if (!sawFrame) { sawFrame = true; setLive(true); }

      const now = performance.now();
      for (const d of DECKS) {
        const amp = lvl[d.toLowerCase()];
        const db = ampToDbfs(amp);
        const lvlName = peakLevel(db);
        const color = METER_COLOR[lvlName];

        const fill = fills.current[d];
        if (fill) { fill.style.width = `${dbToPercent(db)}%`; fill.style.background = color; }

        const h = peakHold(holds.current[d] ?? null, db, now);
        holds.current[d] = h;
        const pk = peaks.current[d];
        if (pk) { pk.style.left = `${Math.max(0, dbToPercent(h.db) - 0.3)}%`; }

        const t = texts.current[d];
        if (t) {
          t.textContent = db <= -69 ? "—" : `${fmtDb(db)} dBFS`;
          t.style.color = lvlName === "quiet" ? "var(--text-tertiary)" : color;
        }
      }
    };

    const h = eth.audio.onLevels(handler);
    return () => { try { eth.audio.offLevels?.(h); } catch { /* teardown must not throw */ } };
  }, [stationUuid]);

  // ── processing meters — 15 Hz and only while a toggle is on, so state is fine here ────────────
  useEffect(() => {
    const eth = (window as any).ether;
    if (!eth?.audio?.onProcMeters) return;
    const h = eth.audio.onProcMeters((m: any) => { if (m) setProc(m); });
    return () => { try { eth.audio.offProcMeters?.(h); } catch {} };
  }, []);

  const target = proc?.target ?? -14;
  const outLevel = loudnessLevel(proc?.outLufs, target);
  const outColor = METER_COLOR[outLevel];
  const peakDb = proc?.outPeakDb;
  const peakLvl = peakLevel(peakDb);

  return (
    <HealthSection title="Audio levels">
      {DECKS.map(d => (
        <DeckMeter key={d} deck={d}
          refs={{ fill: (el) => { fills.current[d] = el; },
                  peak: (el) => { peaks.current[d] = el; },
                  text: (el) => { texts.current[d] = el; } }} />
      ))}

      {!live && (
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: "var(--s-2, 4px)" }}>
          No level frames yet — the meters move when audio is playing on this station.
        </div>
      )}

      {/* ── PROGRAM LOUDNESS ────────────────────────────────────────────────────────────────────
          A separate measurement on a separate scale. OFF is stated rather than shown as silence:
          the emitter is quiet unless a processing toggle is on, so a blank row would be
          indistinguishable from a dead feed. */}
      <div style={{ marginTop: "var(--s-4, 8px)", paddingTop: "var(--s-3, 6px)",
                    borderTop: "1px solid var(--border-primary)" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between",
                      marginBottom: "var(--s-2, 4px)" }}>
          <span style={{ fontSize: "var(--t-micro, 9px)", fontWeight: 700, letterSpacing: "0.12em",
                         textTransform: "uppercase" as const, color: "var(--text-tertiary)" }}>
            Program loudness
          </span>
          <span style={{ fontSize: "var(--t-micro, 9px)", color: "var(--text-tertiary)" }}>
            target {target} LUFS
          </span>
        </div>

        {!proc || !(proc.local || proc.stream) ? (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
            Loudness processing is off — nothing is measuring the program bus.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3, 6px)",
                          padding: "var(--s-2, 4px) 0" }}>
              <span style={{ width: 52, flexShrink: 0, fontSize: "var(--t-body, 12px)", fontWeight: 700,
                             color: "var(--text-secondary)" }}>Out</span>
              <div style={{ flex: 1, minWidth: 60, height: 14, background: "var(--bg-primary)",
                            border: "1px solid var(--border-primary)", position: "relative", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${dbToPercent(proc.outLufs ?? -70)}%`,
                              background: outColor, transition: "width 120ms linear" }} />
                {/* THE TARGET, drawn on the bar. Without it the operator compares to a number in
                    their head, and the whole point of a loudness meter is the distance to target. */}
                <div style={{ position: "absolute", top: 0, height: "100%", width: 2,
                              left: `${dbToPercent(target)}%`, background: "var(--text-primary)", opacity: 0.8 }} />
              </div>
              <span style={{ width: 92, flexShrink: 0, textAlign: "right" as const, fontSize: "var(--t-small, 10px)",
                             fontFamily: "'DM Mono', monospace", fontVariantNumeric: "tabular-nums", color: outColor }}>
                {fmtDb(proc.outLufs)} LUFS
              </span>
            </div>

            {/* Numbers that do not need a bar. Ride gain is bidirectional from unity — the thing that
                actually moves; limiter GR sits at 0 at steady state by design (2026-08-01). */}
            <div style={{ display: "flex", gap: "var(--s-5, 12px)", flexWrap: "wrap" as const,
                          fontSize: "var(--t-small, 10px)", fontFamily: "'DM Mono', monospace",
                          color: "var(--text-tertiary)", marginTop: "var(--s-1, 2px)" }}>
              <span>in {fmtDb(proc.inLufs)} LUFS</span>
              <span>ride {(proc.rideGainDb ?? 0) >= 0 ? "+" : ""}{(proc.rideGainDb ?? 0).toFixed(1)} dB</span>
              <span>limiter {(proc.grDb ?? 0).toFixed(1)} dB</span>
              {/* CLIP KEYS OFF PEAK, NOT LOUDNESS — you can clip at -18 LUFS. Separate measurement,
                  separate indicator, and it is the one that latches red. */}
              <span style={{ color: METER_COLOR[peakLvl], fontWeight: peakLvl === "clip" ? 800 : 400 }}>
                peak {fmtDb(peakDb)} dBFS{peakLvl === "clip" ? " · OVER" : ""}
              </span>
              {/* Status is not carried by colour alone. */}
              <span style={{ color: outColor }}>{METER_WORD[outLevel]}</span>
            </div>
          </>
        )}
      </div>
    </HealthSection>
  );
}

export const HealthMeters = memo(HealthMetersImpl);
export default HealthMeters;
