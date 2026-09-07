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

export type Branch = "local" | "stream";
const BRANCH_LABEL: Record<Branch, string> = { local: "Monitor", stream: "Stream" };

interface Props {
  /** Which branch the controls are editing. The meters show BOTH, always. */
  branch: Branch;
  onBranch: (b: Branch) => void;
  /** False = the two branches are linked and carry identical parameters (the default, and
   *  bit-identical to the chain before the split existed). */
  split: boolean;
  onSplit: (on: boolean) => void;
  params: Record<Branch, ProcParams>;
  stored: Record<Branch, Partial<Record<keyof ProcParams, boolean>>>;
  onChange: (branch: Branch, patch: Partial<ProcParams>) => void;
  presets: Preset[];
  activePreset: string | null;
  onSelectPreset: (name: string) => void;
  onSavePreset: (name: string) => void;
  bypass: Record<Branch, { ride: boolean; limiter: boolean }>;
  onBypass: (branch: Branch, which: "ride" | "limiter", on: boolean) => void;
  meters: Record<Branch, Meters>;
  /** True when the running daemon predates the split and reports no stream branch. */
  streamBranchUnreported?: boolean;
  /** What the ride WOULD apply, derived from the observed input and the operator's target/clamp.
   *  Rendered greyed and labelled as a projection — never in the place the applied gain goes. */
  wouldRideDb: Record<Branch, number | null>;
  /** Set when the last command did not reach the engine. A control that did nothing must say so. */
  sendError?: string | null;
  /** The operator engaged a bypass the engine has not confirmed. Never left silent. */
  bypassPending?: boolean;
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
  // The controls edit ONE branch; the meters below show both. While linked, editing either writes the
  // monitor's values and the daemon mirrors them, so the stream tab is a read-through, not a second copy.
  const b = p.split ? p.branch : "local";
  const prm = p.params[b];
  const st  = p.stored[b];
  const byp = p.bypass[b];
  const anyBypass = p.bypass.local.ride || p.bypass.local.limiter ||
                    p.bypass.stream.ride || p.bypass.stream.limiter;
  const active = p.presets.find(x => x.name === p.activePreset) || null;
  const modified = !!active && !paramsEqual(active.params, prm);
  const [saveName, setSaveName] = useState("");
  const grPeak = useRef(0);
  const [grHold, setGrHold] = useState(0);
  const grWindow = useRef<{ t: number; v: number }[]>([]);
  const [gr10s, setGr10s] = useState(0);

  // Peak-hold with decay, and MAX GR OVER 10s as a number. A 5-second seam on a 15 Hz needle is not
  // something anyone can read while it happens; the held number is what you look at afterwards.
  useEffect(() => {
    const gr = p.meters[b]?.grDb ?? 0;
    grPeak.current = Math.max(gr, grPeak.current * 0.97);
    setGrHold(grPeak.current);
    const now = Date.now();
    grWindow.current.push({ t: now, v: gr });
    grWindow.current = grWindow.current.filter(x => now - x.t <= 10_000);
    setGr10s(grWindow.current.reduce((m, x) => Math.max(m, x.v), 0));
  }, [p.meters, b]);

  return (
    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12, height: "100%", boxSizing: "border-box", overflowY: "auto" }}>

        {/* THE TWO BRANCHES. The monitor is the room; the stream is what listeners get through an
            encoder. LINKED (the default) means one set of numbers driving both instances — the chain
            every station ran before the split, bit-identical. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {(["local", "stream"] as Branch[]).map(x => {
            const on = (p.split ? p.branch : "local") === x;
            const bp = p.bypass[x].ride || p.bypass[x].limiter;
            return (
              <button key={x} onClick={() => p.onBranch(x)} disabled={!p.split && x === "stream"}
                title={!p.split && x === "stream"
                  ? "Linked to the monitor - split them to give the stream its own chain"
                  : `Edit the ${BRANCH_LABEL[x].toLowerCase()} chain`}
                style={{
                  padding: "4px 12px", fontSize: 11, fontWeight: 800, letterSpacing: "0.08em",
                  textTransform: "uppercase" as const,
                  background: on ? "rgba(136,104,216,0.2)" : "transparent",
                  border: `1px solid ${on ? "#8868D8" : "var(--border-primary)"}`,
                  color: on ? "#8868D8" : "var(--text-tertiary)",
                  cursor: (!p.split && x === "stream") ? "default" : "pointer",
                  opacity: (!p.split && x === "stream") ? 0.45 : 1,
                }}>
                {BRANCH_LABEL[x]}{bp ? " ·" : ""}
              </button>
            );
          })}
          <button onClick={() => p.onSplit(!p.split)}
            title={p.split
              ? "Re-link: the stream goes back to running the monitor's chain"
              : "Split: give the stream its own target, ceiling, release and ride. Splitting changes nothing by itself - the stream keeps the values it is already running."}
            style={{
              padding: "4px 12px", fontSize: 11, fontWeight: 800, letterSpacing: "0.08em",
              background: p.split ? "rgba(136,104,216,0.12)" : "transparent",
              border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer",
            }}>{p.split ? "SPLIT" : "LINKED"}</button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
            {p.split ? "two chains" : "one chain, both outputs"}
          </span>
        </div>

        {p.streamBranchUnreported && (
          <div style={{ padding: "6px 11px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", fontSize: 11 }}>
            The running audio daemon predates the split and reports no stream branch. It does not reload on
            auto-update - fully close and reopen Ether to see stream meters.
          </div>
        )}

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

        {/* A COMMAND THAT DID NOT LAND SAYS SO. The BYPASS button was dead for two releases and looked
            identical to a working one, because every failure on this path was swallowed. */}
        {p.sendError && (
          <div style={{ padding: "7px 11px", background: "rgba(239,68,68,0.15)", border: "1px solid #ef4444", color: "#ef4444", fontSize: 12, fontWeight: 700 }}>
            ⚠ The engine did not accept that — {p.sendError}
          </div>
        )}
        {p.bypassPending && !p.sendError && (
          <div style={{ padding: "6px 11px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", fontSize: 11 }}>
            Waiting for the engine to confirm the bypass… if this does not clear, the audio daemon is
            older than this build — fully close and reopen Ether.
          </div>
        )}

        {/* THE BYPASS BANNER. Visually obvious while engaged, as ruled — a bypassed limiter means nothing
            is holding the ceiling on the processed path, and that is distortion you cannot hear locally. */}
        {anyBypass && (
          <div style={{ padding: "7px 11px", background: "rgba(245,158,11,0.15)", border: "1px solid #f59e0b", color: "#f59e0b", fontSize: 12, fontWeight: 700 }}>
            {/* NAMED PER BRANCH. With the split on, "limiter bypassed" without saying WHICH output is
                exactly the kind of half-true a bypass warning cannot afford: the stream reaching
                listeners with nothing holding the ceiling is a different emergency from the monitor. */}
            {(["local", "stream"] as Branch[]).filter(x => p.bypass[x].ride || p.bypass[x].limiter).map(x => (
              <div key={x}>
                ⚠ {BRANCH_LABEL[x].toUpperCase()}: {p.bypass[x].limiter && p.bypass[x].ride
                  ? "RIDE AND LIMITER BYPASSED"
                  : p.bypass[x].limiter
                    ? (x === "stream" ? "LIMITER BYPASSED — nothing is holding the ceiling on air" : "LIMITER BYPASSED — nothing is holding the ceiling")
                    : "LOUDNESS RIDE BYPASSED"}
              </div>
            ))}
            <div style={{ fontWeight: 500, marginTop: 3 }}>test only, resets on restart</div>
          </div>
        )}

        <div style={{ display: "flex", gap: 12 }}>
          <div style={CARD}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <span style={{ ...LABEL, fontWeight: 800, color: "var(--text-secondary)" }}>Loudness ride</span>
              <div style={{ flex: 1 }} />
              <Bypass on={byp.ride} onClick={() => p.onBypass(b, "ride", !byp.ride)} what="Loudness ride" />
            </div>
            <Row label="Target" value={prm.targetLufs} unit=" LUFS" min={-30} max={-6} step={1}
              shipped={!st.targetLufs} onChange={v => p.onChange(b, { targetLufs: v })}
              hint="The programme loudness the ride walks toward." />
            <Row label="Rate" value={prm.rideRate} unit=" dB/s" min={0.3} max={6} step={0.1}
              shipped={!st.rideRate} onChange={v => p.onChange(b, { rideRate: v })}
              hint="How fast it moves. Faster pumps audibly across a seam; slower leaves a quiet track quiet for longer." />
            <Row label="Clamp" value={prm.rideClamp} unit=" dB" min={3} max={18} step={1}
              shipped={!st.rideClamp} onChange={v => p.onChange(b, { rideClamp: v })}
              hint="How far it may travel. A large clamp on quiet material lifts the noise floor with it." />
          </div>

          <div style={CARD}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <span style={{ ...LABEL, fontWeight: 800, color: "var(--text-secondary)" }}>Limiter</span>
              <div style={{ flex: 1 }} />
              <Bypass on={byp.limiter} onClick={() => p.onBypass(b, "limiter", !byp.limiter)} what="Limiter" />
            </div>
            <Row label="Ceiling" value={prm.ceilingDbtp} unit=" dBTP" min={-3} max={-0.1} step={0.1}
              shipped={!st.ceilingDbtp} onChange={v => p.onChange(b, { ceilingDbtp: v })}
              hint="Never reaches 0. Above about −0.3 dBTP the stream's encoder makes inter-sample overs that clip on the listener's decoder — distortion you cannot hear locally." />
            <Row label="Release" value={prm.releaseMs} unit=" ms" min={30} max={500} step={10}
              shipped={!st.releaseMs} onChange={v => p.onChange(b, { releaseMs: v })}
              hint="How quickly it lets go after a peak. Short distorts bass and pumps; long leaves the programme ducked after a transient." />
            {/* NOT CONTROLS — shown so the chain is legible, and so nobody goes looking for them. */}
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", lineHeight: 1.6, marginTop: 8, borderTop: "1px solid var(--border-primary)", paddingTop: 7 }}>
              Look-ahead 1.5 ms · attack completes within it · 4× oversampled true-peak<br />
              <span style={{ opacity: 0.75 }}>Fixed: look-ahead is the processing latency, and attack governs whether peaks pass the ceiling at all.</span>
            </div>
          </div>
        </div>

        {/* METERS, ONE ROW PER BRANCH — observed at each instance's own taps, never inferred and never
            shared. With the split on these two ride to different targets and reduce by different amounts
            at the same instant; a single row would have to lie about one of them. */}
        <div style={{ ...CARD, flex: "0 0 auto" }}>
          {(["local", "stream"] as Branch[]).map((x, idx) => {
            const m = p.meters[x];
            const bp = p.bypass[x];
            const wr = p.wouldRideDb[x];
            return (
              <div key={x} style={{
                display: "flex", alignItems: "center", gap: 14,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12,
                paddingTop: idx ? 7 : 0, marginTop: idx ? 7 : 0,
                borderTop: idx ? "1px solid var(--border-primary)" : "none",
                opacity: m ? 1 : 0.5,
              }}>
                <span style={{ ...LABEL, width: 58, flexShrink: 0, fontWeight: 800,
                               color: (p.split ? p.branch : "local") === x ? "#8868D8" : "var(--text-tertiary)" }}>
                  {BRANCH_LABEL[x]}
                </span>
                <span><span style={LABEL}>IN </span>{m ? m.inLufs.toFixed(1) : "—"}</span>
                <span>
                  <span style={LABEL}>RIDE </span>
                  {m ? (m.rideGainDb >= 0 ? "+" : "") + m.rideGainDb.toFixed(1) : "—"} dB
                  {bp.ride && wr != null && (
                    <span style={{ color: "var(--text-tertiary)", marginLeft: 7 }}
                          title="What this branch's ride would apply at this input loudness if it were not bypassed. A projection from the target and clamp - not a measurement of anything happening.">
                      (would ride {wr >= 0 ? "+" : ""}{wr.toFixed(1)} dB)
                    </span>
                  )}
                </span>
                <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 7, minWidth: 90 }}>
                  <span style={LABEL}>GR</span>
                  <span style={{ flex: 1, height: 9, background: "var(--bg-tertiary)", position: "relative", minWidth: 60 }}>
                    <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, (m?.grDb ?? 0) / 12 * 100)}%`, background: "#8868D8" }} />
                    {(p.split ? p.branch : "local") === x && (
                      <span style={{ position: "absolute", top: -1, bottom: -1, left: `${Math.min(100, grHold / 12 * 100)}%`, width: 2, background: "#f59e0b" }} />
                    )}
                  </span>
                  <span style={{ minWidth: 34, textAlign: "right" }}>{(m?.grDb ?? 0).toFixed(1)}</span>
                </span>
                <span><span style={LABEL}>OUT </span>{m ? m.outLufs.toFixed(1) : "—"}</span>
                {(bp.ride || bp.limiter) && (
                  <span style={{ fontSize: 10, fontWeight: 800, color: "#f59e0b" }}>
                    {bp.ride && bp.limiter ? "BOTH BYP" : bp.ride ? "RIDE BYP" : "LIM BYP"}
                  </span>
                )}
              </div>
            );
          })}
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 7 }}>
            <span title="The deepest gain reduction on the selected branch in the last 10 seconds - a seam lasts about five, and a 15 Hz needle cannot be read while it happens.">
              MAX 10s ({BRANCH_LABEL[p.split ? p.branch : "local"].toLowerCase()}) {gr10s.toFixed(1)} dB
            </span>
            {!p.meters.local && !p.meters.stream && " · waiting for audio — meters run only while processing is on"}
          </div>
        </div>
    </div>
  );
}
