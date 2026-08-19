// ── ProcessingMeters — the loudness chain's three meters, in ONE place ──────────────────────────
//
// IN LOUDNESS · OUT LOUDNESS · RIDE GAIN. The trio an operator reads to answer three questions:
// what went in, what came out, and what the processor did to get there.
//
// MOVED, NOT REWRITTEN (2026-08-18). This is the implementation that has been living inside
// SettingsPanel's Audio Processing section since 2026-08-01 — `Meter`, the ride-gain bar and
// `dbfsPct`, lifted verbatim so Preferences and the Health Monitor render the SAME component on the
// SAME scales with the SAME labels. It is deliberately not a second implementation: the Health
// Monitor previously carried a lesser version of this readout (one bar plus text), which is how the
// panel came to disagree with Preferences about what "the meters" were.
//
// It is fed by the existing `audio:proc-meters` frame and knows nothing about where its numbers came
// from, so the same component serves a STATION's program processor and a DECK's aux processor — one
// grammar, two sections.

/** dBFS → 0..100% across a -60..0 dBFS span. */
export function dbfsPct(db?: number): number {
  if (db == null || !Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

export interface ProcTrioMeters {
  inLufs?: number; outLufs?: number;
  grDb?: number; rideGainDb?: number;
  inPeakDb?: number; outPeakDb?: number;
}

export function Meter({ label, lufs, peakDb, accent }: { label: string; lufs?: number; peakDb?: number; accent?: boolean }) {
  const fmt = (v?: number) => (v == null || v <= -70 ? "—" : v.toFixed(1));
  // A LEVEL BAR, not just a number (2026-08-01). The IN and OUT peaks are the actual signal and they
  // move with the audio — that is what tells an operator the chain is passing and what it is doing to
  // the level. Amber above -6 dBFS, red at -1 and up (the limiter's ceiling).
  const pct = dbfsPct(peakDb);
  const col = (peakDb ?? -70) >= -1 ? "#f87171" : (peakDb ?? -70) >= -6 ? "var(--accent-amber, #fbbf24)"
            : accent ? "var(--accent-blue)" : "var(--accent-green)";
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 2 }}>{label} LOUDNESS</div>
      <div style={{ fontSize: 20, fontVariantNumeric: "tabular-nums", color: accent ? "var(--accent-blue)" : "var(--text-primary)" }}>
        {fmt(lufs)}<span style={{ fontSize: 11, color: "var(--text-tertiary)" }}> LUFS</span>
      </div>
      <div style={{ height: 6, background: "var(--bg-tertiary)", borderRadius: 3, marginTop: 6, overflow: "hidden", position: "relative" as const }}>
        <div style={{ height: "100%", width: `${pct}%`, background: col, transition: "width .08s linear" }} />
      </div>
      <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>peak {fmt(peakDb)} dBFS</div>
    </div>
  );
}

/** RIDE GAIN — the number that MOVES, and the third meter. Bidirectional from unity: right/green when
 *  boosting quiet material toward target, left/amber when pulling loud material down. Limiter GR is
 *  reported underneath rather than as the bar, because it sits at 0 at steady state BY DESIGN and a bar
 *  bound to it read as broken (2026-08-01). */
export function RideMeter({ meters }: { meters?: ProcTrioMeters | null }) {
  const ride = meters?.rideGainDb ?? 0;
  const gr = Math.abs(meters?.grDb ?? 0);
  const SPAN = 12;                                    // ±12 dB across the bar
  const pct = Math.min(50, (Math.abs(ride) / SPAN) * 50);
  const boosting = ride >= 0;
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 2 }}>RIDE GAIN</div>
      <div style={{ fontSize: 20, fontVariantNumeric: "tabular-nums", color: !meters ? "var(--text-primary)" : Math.abs(ride) > 0.3 ? (boosting ? "var(--accent-green)" : "var(--accent-amber, #fbbf24)") : "var(--text-primary)" }}>
        {meters ? `${ride >= 0 ? "+" : "−"}${Math.abs(ride).toFixed(1)}` : "—"}<span style={{ fontSize: 11, color: "var(--text-tertiary)" }}> dB</span>
      </div>
      <div style={{ position: "relative" as const, height: 6, background: "var(--bg-tertiary)", borderRadius: 3, marginTop: 6, overflow: "hidden" }}>
        <div style={{ position: "absolute" as const, left: "50%", top: 0, bottom: 0, width: 1, background: "var(--border-secondary)", zIndex: 1 }} />
        <div style={{
          position: "absolute" as const, top: 0, bottom: 0,
          left: boosting ? "50%" : `${50 - pct}%`, width: `${pct}%`,
          background: boosting ? "var(--accent-green)" : "var(--accent-amber, #fbbf24)",
          transition: "left .1s, width .1s",
        }} />
      </div>
      <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 4 }}>
        limiter{" "}
        <span style={{ color: gr > 0.1 ? "var(--accent-blue)" : "var(--text-tertiary)", fontWeight: gr > 0.1 ? 700 : 400 }}>
          {gr > 0.1 ? `clamping −${gr.toFixed(1)} dB` : "idle"}
        </span>
      </div>
    </div>
  );
}

/** The three meters as one row: ORIGINAL (in) → PROCESSED (out) → what the processor did (ride +
 *  limiter). `waiting` renders the same layout with dashes, so an operator can tell "no audio yet"
 *  from "not measuring" without the row changing shape underneath them. */
export function ProcessingTrio({ meters }: { meters?: ProcTrioMeters | null }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
      <Meter label="IN" lufs={meters?.inLufs} peakDb={meters?.inPeakDb} />
      <Meter label="OUT" lufs={meters?.outLufs} peakDb={meters?.outPeakDb} accent />
      <RideMeter meters={meters} />
    </div>
  );
}

export default ProcessingTrio;
