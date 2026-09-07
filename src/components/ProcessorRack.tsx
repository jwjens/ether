// src/components/ProcessorRack.tsx
// The program processor, as an instrument you can play. Opened from Master Out beside the EQ rack —
// as a REAL POP-OUT (its own BrowserWindow via openPopoutWindow, #popout/processor), so it can be
// dragged onto a second monitor and left open beside the decks. It renders bare: PopoutShell supplies
// the titlebar and close button, the same as every other pop-out panel.
//
// Its state comes from useProcessorParams(stationId) — shared with the PROCESSOR row on Master Out so
// the two cannot disagree. See that hook for the bypass honesty rule.
//
// WHAT THIS REPLACES: eight numbers compiled into Rust and one target field in Settings. The chain
// (loudness ride → −1 dBTP true-peak limiter) has always run; nothing about it could be seen or changed.
//
// THE RULES THIS PANEL OBEYS
//   · Every value renders as the CURRENT value. A number with nothing stored shows the shipped value
//     greyed — never a blank box, never a component default pretending to be a setting.
//   · The four NUMBERS persist per station (station_config_kv, synced). The two BYPASSES do not: they
//     are a test tool, they reach the engine live, and they die with the process, so a restart always
//     ends with the ceiling held. Jeff's ruling, 2026-09-07.
//   · Look-ahead, attack, the ×1.15 detection headroom and the 4× oversampling are NOT controls. The
//     first three would change the delay-line size or let peaks past the ceiling; the last is a
//     CPU/quality tradeoff, not a sound anyone chooses. They are shown read-only so the chain is legible.
import { useEffect, useRef, useState } from "react";

// THE SHIPPED CHAIN. These are the values ProgramProcessor::new uses, mirrored here so an unstored
// setting can render its real current value. Keep in step with native/src/program_processor.rs and the
// defaults in audiod/engine.js — three places, one chain.
export const SHIPPED = {
  targetLufs: -14,
  ceilingDbtp: -1.0,
  releaseMs: 120,
  rideRate: 1.5,
  rideClamp: 12,
} as const;

export type ProcParams = {
  targetLufs: number; ceilingDbtp: number; releaseMs: number; rideRate: number; rideClamp: number;
};
export type Preset = { name: string; params: ProcParams; builtIn?: boolean };

/** The first preset: the shipped chain, captured as-is, so it can be A/B'd against anything else. */
export const ETHER_V1: Preset = { name: "Ether v1 (shipped)", params: { ...SHIPPED }, builtIn: true };

export const paramsEqual = (a: ProcParams, b: ProcParams) =>
  (["targetLufs", "ceilingDbtp", "releaseMs", "rideRate", "rideClamp"] as const)
    .every(k => Math.abs(a[k] - b[k]) < 1e-6);

type Meters = { inLufs: number; outLufs: number; grDb: number; rideGainDb: number; inPeakDb: number; outPeakDb: number } | null;

interface Props {
  params: ProcParams;
  stored: Partial<Record<keyof ProcParams, boolean>>;   // which values are actually stored vs shipped
  onChange: (patch: Partial<ProcParams>) => void;
  presets: Preset[];
  activePreset: string | null;
  onSelectPreset: (name: string) => void;
  onSavePreset: (name: string) => void;
  rideBypass: boolean; limiterBypass: boolean;
  onBypass: (which: "ride" | "limiter", on: boolean) => void;
  meters: Meters;
  /** What the ride WOULD apply, derived from the observed input and the operator's target/clamp.
   *  Rendered greyed and labelled as a projection — never in the place the applied gain goes. */
  wouldRideDb: number | null;
}

const LABEL: React.CSSProperties = { fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" };
const CARD: React.CSSProperties = { background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "12px 14px", flex: 1, minWidth: 0 };

function Row({ label, value, unit, min, max, step, shipped, onChange, hint }: {
  label: string; value: number; unit: string; min: number; max: number; step: number;
  shipped: boolean; onChange: (v: number) => void; hint: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9 }} title={hint}>
      <span style={{ ...LABEL, width: 78, flexShrink: 0 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: shipped ? "var(--text-tertiary)" : "#8868D8", cursor: "pointer" }} />
      <span style={{
        fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12, fontWeight: 700,
        minWidth: 64, textAlign: "right",
        // GREYED = the shipped value, shown as the current value. Not a blank, not a placeholder.
        color: shipped ? "var(--text-tertiary)" : "#8868D8",
      }}>{value}{unit}</span>
    </div>
  );
}

function Bypass({ on, onClick, what }: { on: boolean; onClick: () => void; what: string }) {
  return (
    <button onClick={onClick} title={`${what} bypass — a TEST TOOL. Not saved: it resets when Ether restarts.`}
      style={{
        padding: "3px 10px", fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", cursor: "pointer",
        border: `1px solid ${on ? "#f59e0b" : "var(--border-primary)"}`,
        background: on ? "rgba(245,158,11,0.18)" : "transparent",
        color: on ? "#f59e0b" : "var(--text-tertiary)",
      }}>{on ? "BYPASSED" : "BYPASS"}</button>
  );
}

export default function ProcessorRack(p: Props) {
  const anyBypass = p.rideBypass || p.limiterBypass;
  const active = p.presets.find(x => x.name === p.activePreset) || null;
  const modified = !!active && !paramsEqual(active.params, p.params);
  const [saveName, setSaveName] = useState("");
  const grPeak = useRef(0);
  const [grHold, setGrHold] = useState(0);
  const grWindow = useRef<{ t: number; v: number }[]>([]);
  const [gr10s, setGr10s] = useState(0);

  // Peak-hold with decay, and MAX GR OVER 10s as a number. A 5-second seam on a 15 Hz needle is not
  // something anyone can read while it happens; the held number is what you look at afterwards.
  useEffect(() => {
    const gr = p.meters?.grDb ?? 0;
    grPeak.current = Math.max(gr, grPeak.current * 0.97);
    setGrHold(grPeak.current);
    const now = Date.now();
    grWindow.current.push({ t: now, v: gr });
    grWindow.current = grWindow.current.filter(x => now - x.t <= 10_000);
    setGr10s(grWindow.current.reduce((m, x) => Math.max(m, x.v), 0));
  }, [p.meters]);

  return (
    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12, height: "100%", boxSizing: "border-box", overflowY: "auto" }}>

        {/* Preset bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={LABEL}>Preset</span>
          <select value={p.activePreset ?? ""} onChange={e => p.onSelectPreset(e.target.value)}
            style={{ background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", padding: "4px 8px", fontSize: 12 }}>
            {p.presets.map(x => <option key={x.name} value={x.name}>{x.name}</option>)}
          </select>
          {/* DERIVED, never a flag. The badge compares the live values to the preset's stored ones, so a
              panel can never claim a preset it is not running — the same rule as the EQ's active dot. */}
          {modified && <span style={{ fontSize: 11, fontWeight: 700, color: "#f59e0b" }}>· modified</span>}
          <div style={{ flex: 1 }} />
          <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Save as…"
            style={{ width: 130, background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", padding: "4px 8px", fontSize: 12 }} />
          <button disabled={!saveName.trim()} onClick={() => { p.onSavePreset(saveName.trim()); setSaveName(""); }}
            style={{ padding: "4px 10px", fontSize: 11, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: saveName.trim() ? "pointer" : "default", opacity: saveName.trim() ? 1 : 0.4 }}>Save</button>
        </div>

        {/* THE BYPASS BANNER. Visually obvious while engaged, as ruled — a bypassed limiter means nothing
            is holding the ceiling on the processed path, and that is distortion you cannot hear locally. */}
        {anyBypass && (
          <div style={{ padding: "7px 11px", background: "rgba(245,158,11,0.15)", border: "1px solid #f59e0b", color: "#f59e0b", fontSize: 12, fontWeight: 700 }}>
            ⚠ {p.limiterBypass && p.rideBypass ? "RIDE AND LIMITER BYPASSED" : p.limiterBypass ? "LIMITER BYPASSED — nothing is holding the ceiling" : "LOUDNESS RIDE BYPASSED"} · test only, resets on restart
          </div>
        )}

        <div style={{ display: "flex", gap: 12 }}>
          <div style={CARD}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <span style={{ ...LABEL, fontWeight: 800, color: "var(--text-secondary)" }}>Loudness ride</span>
              <div style={{ flex: 1 }} />
              <Bypass on={p.rideBypass} onClick={() => p.onBypass("ride", !p.rideBypass)} what="Loudness ride" />
            </div>
            <Row label="Target" value={p.params.targetLufs} unit=" LUFS" min={-30} max={-6} step={1}
              shipped={!p.stored.targetLufs} onChange={v => p.onChange({ targetLufs: v })}
              hint="The programme loudness the ride walks toward." />
            <Row label="Rate" value={p.params.rideRate} unit=" dB/s" min={0.3} max={6} step={0.1}
              shipped={!p.stored.rideRate} onChange={v => p.onChange({ rideRate: v })}
              hint="How fast it moves. Faster pumps audibly across a seam; slower leaves a quiet track quiet for longer." />
            <Row label="Clamp" value={p.params.rideClamp} unit=" dB" min={3} max={18} step={1}
              shipped={!p.stored.rideClamp} onChange={v => p.onChange({ rideClamp: v })}
              hint="How far it may travel. A large clamp on quiet material lifts the noise floor with it." />
          </div>

          <div style={CARD}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <span style={{ ...LABEL, fontWeight: 800, color: "var(--text-secondary)" }}>Limiter</span>
              <div style={{ flex: 1 }} />
              <Bypass on={p.limiterBypass} onClick={() => p.onBypass("limiter", !p.limiterBypass)} what="Limiter" />
            </div>
            <Row label="Ceiling" value={p.params.ceilingDbtp} unit=" dBTP" min={-3} max={-0.1} step={0.1}
              shipped={!p.stored.ceilingDbtp} onChange={v => p.onChange({ ceilingDbtp: v })}
              hint="Never reaches 0. Above about −0.3 dBTP the stream's encoder makes inter-sample overs that clip on the listener's decoder — distortion you cannot hear locally." />
            <Row label="Release" value={p.params.releaseMs} unit=" ms" min={30} max={500} step={10}
              shipped={!p.stored.releaseMs} onChange={v => p.onChange({ releaseMs: v })}
              hint="How quickly it lets go after a peak. Short distorts bass and pumps; long leaves the programme ducked after a transient." />
            {/* NOT CONTROLS — shown so the chain is legible, and so nobody goes looking for them. */}
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", lineHeight: 1.6, marginTop: 8, borderTop: "1px solid var(--border-primary)", paddingTop: 7 }}>
              Look-ahead 1.5 ms · attack completes within it · 4× oversampled true-peak<br />
              <span style={{ opacity: 0.75 }}>Fixed: look-ahead is the processing latency, and attack governs whether peaks pass the ceiling at all.</span>
            </div>
          </div>
        </div>

        {/* Meters — observed at the stage taps, never inferred. */}
        <div style={{ ...CARD, flex: "0 0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12 }}>
            <span><span style={LABEL}>IN </span>{p.meters ? p.meters.inLufs.toFixed(1) : "—"}</span>
            {/* APPLIED gain, always — the engine pins it at 0 while the ride is bypassed, so this
                number can never describe a correction that is not happening. The projection beside it
                is greyed and says "would", because it is a different kind of fact. */}
            <span>
              <span style={LABEL}>RIDE </span>
              {p.meters ? (p.meters.rideGainDb >= 0 ? "+" : "") + p.meters.rideGainDb.toFixed(1) : "—"} dB
              {p.rideBypass && p.wouldRideDb != null && (
                <span style={{ color: "var(--text-tertiary)", marginLeft: 7 }}
                      title="What the ride would apply at this input loudness if it were not bypassed. A projection from the target and clamp — not a measurement of anything happening.">
                  (would ride {p.wouldRideDb >= 0 ? "+" : ""}{p.wouldRideDb.toFixed(1)} dB)
                </span>
              )}
            </span>
            <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 7 }}>
              <span style={LABEL}>GR</span>
              <span style={{ flex: 1, height: 9, background: "var(--bg-tertiary)", position: "relative", minWidth: 70 }}>
                <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, (p.meters?.grDb ?? 0) / 12 * 100)}%`, background: "#8868D8" }} />
                <span style={{ position: "absolute", top: -1, bottom: -1, left: `${Math.min(100, grHold / 12 * 100)}%`, width: 2, background: "#f59e0b" }} />
              </span>
              <span style={{ minWidth: 38, textAlign: "right" }}>{(p.meters?.grDb ?? 0).toFixed(1)}</span>
            </span>
            <span title="The deepest gain reduction in the last 10 seconds — a seam lasts about five, and a 15 Hz needle cannot be read while it happens.">
              <span style={LABEL}>MAX 10s </span>{gr10s.toFixed(1)} dB
            </span>
            <span><span style={LABEL}>OUT </span>{p.meters ? p.meters.outLufs.toFixed(1) : "—"}</span>
          </div>
          {!p.meters && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6 }}>waiting for audio — meters run only while processing is on</div>}
      </div>
    </div>
  );
}
