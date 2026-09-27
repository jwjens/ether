// scripts/rta-screens/entry.tsx — OLD vs NEW spectrum, side by side, for docs/dsp-channel-rta.md.
//
// Both fed the SAME moment of the SAME music (native/goldens/inputs/music.wav at 22 s, the master GEQ set to
// +3 @ 63 · −4 @ 250 · +6 @ 1k · −3 @ 8k), recorded by the engine test `rta_screens_fixture`:
//   · OLD — the deleted MasterEQRack (git 7089096~1): its bar block, VERBATIM (bar colour by level, the gradient,
//     the glow, the white peak-hold line, the fader caps), fed the old eq.rs analyser's own output (verbatim maths,
//     2b9f1cf) for those samples.
//   · NEW — the REAL components, unmodified: the master GEQ view's GeqPanel and the channel rack's EqCurve, drawing
//     RtaBars from the meter thread's frames for the same samples.
import React from "react";
import { createRoot } from "react-dom/client";
import { GeqPanel } from "../../src/components/rack/Rack";
import EqCurve from "../../src/components/rack/EqCurve";

declare const FIXTURE: any;
declare const LAYOUT: string;          // "old" (old vs new) or "x32" (Jeff's X32 reference vs new)
declare const X32_IMG: string;         // the reference photo, as a data URL
const fx = FIXTURE;

// ── OLD — MasterEQRack's bar block, verbatim from git 7089096~1 (only the data source is the fixture) ─────────────
function OldMasterEqRack({ bands, spectrum, peaks }: { bands: number[]; spectrum: number[]; peaks: number[] }) {
  const MAX_DB = 12, TRACK_H = 240;
  const LABELS = ["31", "63", "125", "250", "500", "1K", "2K", "4K", "8K", "16K"];
  return (
    <div style={{ padding: "20px 20px 14px", background: "#0a0a0f" }}>
      <div style={{ display: "flex" }}>
        <div style={{ width: 30, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "4px 8px 26px 0",
                      fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#5a5a72", textAlign: "right" as const, height: TRACK_H }}>
          <span>+12</span><span>+6</span><span style={{ color: "#a8a8b4", fontWeight: 700 }}>0</span><span>−6</span><span>−12</span>
        </div>
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 4, background: "linear-gradient(180deg, #06060a 0%, #0a0a0f 100%)",
                      border: "1px solid #1d1d28", borderRadius: 4, padding: "12px 10px 10px", boxShadow: "inset 0 2px 8px rgba(0,0,0,0.5)", position: "relative" }}>
          {bands.map((gain, idx) => {
            const gainPct = gain / MAX_DB;
            const specPct = Math.min(1, spectrum[idx] ?? 0);
            const peakPct = Math.min(1, peaks[idx] ?? 0);
            const barColor = specPct > 0.9 ? "#ef4444" : specPct > 0.75 ? "#f59e0b" : specPct > 0.5 ? "#22c55e" : "var(--accent-cyan)";
            return (
              <div key={idx} style={{ display: "flex", flexDirection: "column", alignItems: "center", position: "relative", zIndex: 2 }}>
                <div style={{ position: "relative", width: "100%", maxWidth: 44, height: TRACK_H, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                  <div style={{ position: "absolute", bottom: 0, left: "22%", right: "22%", height: `${specPct * 100}%`,
                                background: `linear-gradient(180deg, ${barColor} 0%, ${barColor}50 100%)`, boxShadow: `0 0 10px ${barColor}80`, borderRadius: 1 }} />
                  {peakPct > 0.02 && (
                    <div style={{ position: "absolute", bottom: `${peakPct * 100}%`, left: "22%", right: "22%", height: 2, background: "#ffffff", boxShadow: "0 0 4px #ffffff", opacity: 0.85 }} />
                  )}
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ position: "absolute", top: `${50 - gainPct * 50}%`, transform: "translateY(-50%)", width: 30, height: 14,
                                  background: "linear-gradient(180deg, #5a5a72 0%, #2a2a36 100%)", border: "1px solid #1a1a22", borderRadius: 2, zIndex: 3 }} />
                  </div>
                </div>
                <div style={{ fontSize: 10, color: "#808090", marginTop: 6, fontFamily: "'JetBrains Mono', monospace" }}>{LABELS[idx]}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const frame = (x: any) => ({ v: 1, seq: 1, target: "master", fed: x.fed, centres: [], coarseBelowHz: x.coarseBelowHz, pre: x.pre, post: x.post,
                            fineN: x.fineN, fineLoHz: x.fineLoHz, fineHiHz: x.fineHiHz, finePre: x.finePre, finePost: x.finePost, pushed: 0, dropped: 0 });
const rtaOf = (x: any) => ({ frame: frame(x), held: x.finePost, peakHold: true, setPeakHold: () => {}, unavailable: null });

const H = ({ t, s }: { t: string; s: string }) => (
  <div style={{ padding: "10px 12px 4px" }}>
    <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text-primary)" }}>{t}</div>
    <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{s}</div>
  </div>
);

function Page() {
  const doc = fx.channel.doc;
  const filters = doc.sections.ch.find((s: any) => s.module?.type === "filters");
  const peq = doc.sections.ch.find((s: any) => s.module?.type === "peq");
  return (
    <div style={{ background: "var(--bg-primary)", color: "var(--text-primary)", fontFamily: "Inter, system-ui, sans-serif", width: 1480, padding: 12 }}>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", padding: "0 12px 8px" }}>
        The same moment of the same music ({fx.source} at {fx.atSeconds} s), master GEQ +3 @ 63 · −4 @ 250 · +6 @ 1k · −3 @ 8k.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ border: "1px solid var(--border-primary)" }}>
          <H t="OLD — the master rack before slice 4 (MasterEQRack, deleted in 7089096)" s="Its bar block verbatim from git; the old in-callback analyser's own output (eq.rs@2b9f1cf): 10 octave bars, 0–1 normalised to a running peak, colour by level, glow, white peak hold." />
          <OldMasterEqRack bands={fx.geq} spectrum={fx.old.spectrum} peaks={fx.old.peaks} />
        </div>
        <div style={{ border: "1px solid var(--border-primary)" }}>
          <H t="NEW — the master GEQ view (Rack.tsx GeqPanel, unmodified)" s="RtaBars: 24 bars per octave from the meter thread, the range following the running peak (60 dB) like the old one, coloured green → yellow → red by level, glow, white peak markers; faint = before the GEQ, bright = after it." />
          <div style={{ padding: 12 }}>
            <GeqPanel geq={{ type: "geq", bands: fx.geq } as any} on={true} onBands={() => {}} onIn={() => {}} rta={rtaOf(fx.new) as any} />
          </div>
        </div>
      </div>
      <div style={{ border: "1px solid var(--border-primary)", marginTop: 12 }}>
        <H t="NEW — a channel rack (ChannelRackView's EqCurve, unmodified): the same music on a channel, HPF 100 Hz + PEQ (−5 @ 250, +4 @ 2.5k, +3 shelf @ 10k)" s="The same RtaBars component: faint = before the rack, bright = after it; the EQ curve on top; the lows below 160 Hz hatched (coarser than 3 FFT bins)." />
        <div style={{ padding: 12, maxWidth: 1100 }}>
          <EqCurve doc={doc} filters={filters} peq={peq} onFilters={() => {}} onPeq={() => {}} selected={null} onSelect={() => {}} rta={{ frame: { ...frame(fx.channel), target: "S1" } as any, held: fx.channel.finePost }} />
        </div>
      </div>
    </div>
  );
}

// ── Jeff's X32 reference beside the new graphs (2026-09-27) ──────────────────────────────────────────────────────
function X32Page() {
  const doc = fx.channel.doc;
  const filters = doc.sections.ch.find((s: any) => s.module?.type === "filters");
  const peq = doc.sections.ch.find((s: any) => s.module?.type === "peq");
  return (
    <div style={{ background: "var(--bg-primary)", color: "var(--text-primary)", fontFamily: "Inter, system-ui, sans-serif", width: 1480, padding: 12 }}>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", padding: "0 12px 8px" }}>
        Left: Jeff's reference, a Behringer X32 EQ page with its RTA. Right: the new graphs — the real components, unmodified — on the same
        moment of music ({fx.source} at {fx.atSeconds} s) through the engine.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "start" }}>
        <div style={{ border: "1px solid var(--border-primary)" }}>
          <H t="REFERENCE — Behringer X32 (Jeff's photo)" s="~1/12-octave bars with gaps, blue → green → yellow by level, a grid, the EQ curve in yellow, numbered band markers." />
          <img src={X32_IMG} style={{ width: "100%", display: "block" }} />
        </div>
        <div style={{ border: "1px solid var(--border-primary)" }}>
          <H t="NEW — a channel rack (EqCurve): HPF 100 Hz + PEQ (−5 @ 250, +4 @ 2.5k, +3 shelf @ 10k)" s="120 bars (1/12 octave), blue → teal → green → yellow → red at the very top; before the rack dimmed, after it full; white peak markers; the yellow curve and numbered band markers on top." />
          <div style={{ padding: 10 }}>
            <EqCurve doc={doc} filters={filters} peq={peq} onFilters={() => {}} onPeq={() => {}} selected={null} onSelect={() => {}} rta={{ frame: { ...frame(fx.channel), target: "S1" } as any, held: fx.channel.finePost }} />
          </div>
        </div>
      </div>
      <div style={{ border: "1px solid var(--border-primary)", marginTop: 12 }}>
        <H t="NEW — the master GEQ view (GeqPanel): the same component set — GEQ +3 @ 63 · −4 @ 250 · +6 @ 1k · −3 @ 8k" s="The graph above the faders: the same bars and grid, the GEQ's own curve in yellow, a numbered marker at each fader's position." />
        <div style={{ padding: 12, maxWidth: 1100 }}>
          <GeqPanel geq={{ type: "geq", bands: fx.geq } as any} on={true} onBands={() => {}} onIn={() => {}} rta={rtaOf(fx.new) as any} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(LAYOUT === "x32" ? <X32Page /> : <Page />);
(window as any).__rendered = true;
