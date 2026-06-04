// src/components/MasterEQRack.tsx
// Immersive Master EQ rack — 10-band graphic EQ with live FFT spectrum
// analyzer, rendered inside the reusable FloatingWindow chrome so it
// drags/resizes/snaps/persists like a real FX window.

import { useEffect, useRef, useState } from "react";
import { EQ_FREQS, EQ_LABELS } from "./GraphicEQ";
import FloatingWindow from "./FloatingWindow";

const MAX_DB  = 12;
const POLL_MS = 33;

interface Props {
  bands:    number[];
  onChange: (bands: number[]) => void;
  onClose:  () => void;
}

export default function MasterEQRack({ bands, onChange, onClose }: Props) {
  const [spectrum, setSpectrum] = useState<number[]>(Array(10).fill(0));
  const [peaks,    setPeaks]    = useState<number[]>(Array(10).fill(0));
  const peakRef = useRef<number[]>(Array(10).fill(0));

  // Poll spectrum at ~30fps while the rack is open
  useEffect(() => {
    let alive = true;
    const ether = (window as any).ether;
    const tick = async () => {
      if (!alive) return;
      try {
        const s = await ether?.audio?.getSpectrum?.();
        if (Array.isArray(s) && s.length === 10) {
          setSpectrum(s);
          const next = peakRef.current.map((p, i) => Math.max(s[i], p * 0.985));
          peakRef.current = next;
          setPeaks(next);
        }
      } catch {}
    };
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const dragBand = (idx: number, trackH: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY    = e.clientY;
    const startGain = bands[idx] ?? 0;
    const onMove = (me: MouseEvent) => {
      const dy   = startY - me.clientY;
      const gain = Math.max(-MAX_DB, Math.min(MAX_DB,
        startGain + (dy / trackH) * MAX_DB * 2
      ));
      const next = [...bands];
      next[idx] = Math.round(gain * 10) / 10;
      onChange(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const resetFlat = () => onChange(Array(10).fill(0));
  const isActive  = bands.some(g => Math.abs(g) > 0.05);

  // Custom header — replaces the default FloatingWindow header so we can
  // show the full rack bezel (LED, model number, FLAT button, etc.)
  const header = (
    <div style={{
      height: 52,
      background: "linear-gradient(180deg, #262632 0%, #1a1a22 100%)",
      borderBottom: "1px solid #0a0a0f",
      display: "flex", alignItems: "center", padding: "0 20px", gap: 16,
      position: "relative",
    }}>
      {/* Drag grip */}
      <div style={{
        position: "absolute", left: 6, top: "50%", transform: "translateY(-50%)",
        display: "flex", flexDirection: "column", gap: 3, pointerEvents: "none",
      }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{ display: "flex", gap: 3 }}>
            <div style={{ width: 2, height: 2, borderRadius: "50%", background: "#3a3a48" }} />
            <div style={{ width: 2, height: 2, borderRadius: "50%", background: "#3a3a48" }} />
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 10, height: 10, borderRadius: "50%",
          background: isActive ? "#ef4444" : "#22c55e",
          boxShadow: `0 0 8px ${isActive ? "#ef4444" : "#22c55e"}`,
          color: isActive ? "#ef4444" : "#22c55e",
        }} />
        <div style={{
          fontSize: 14, fontWeight: 800, letterSpacing: "0.18em",
          color: "#ececf2", textTransform: "uppercase" as const,
        }}>ETHER</div>
        <div style={{
          fontSize: 10, fontWeight: 600, letterSpacing: "0.14em",
          color: "var(--accent-cyan)", textTransform: "uppercase" as const,
          padding: "2px 8px",
          border: "1px solid rgb(from var(--accent-cyan) r g b / 0.3)",
          borderRadius: 3,
        }}>MASTER EQ · 10-BAND</div>
      </div>

      <div style={{ flex: 1, textAlign: "center" }}>
        <div style={{
          fontSize: 10, fontWeight: 600, letterSpacing: "0.3em",
          color: "#5a5a72", fontFamily: "'JetBrains Mono', monospace",
        }}>MODEL 10-R · OCT-2026 · ◉ LIVE</div>
      </div>

      <button
        onClick={resetFlat}
        data-no-drag
        style={{
          padding: "7px 14px", borderRadius: 4,
          background: "#1a1a22", border: "1px solid #3a3a48",
          color: "#a8a8b4", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
          cursor: "pointer", transition: "all 0.15s",
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-blue)"; (e.currentTarget as HTMLElement).style.color = "#ececf2"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#3a3a48"; (e.currentTarget as HTMLElement).style.color = "#a8a8b4"; }}
      >FLAT</button>

      <button
        onClick={onClose}
        title="Close (Esc)"
        data-no-drag
        style={{
          width: 32, height: 32, borderRadius: 4,
          background: "#1a1a22", border: "1px solid #3a3a48",
          color: "#a8a8b4", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.15s",
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#ef4444"; (e.currentTarget as HTMLElement).style.borderColor = "#ef4444"; (e.currentTarget as HTMLElement).style.color = "#fff"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#1a1a22"; (e.currentTarget as HTMLElement).style.borderColor = "#3a3a48"; (e.currentTarget as HTMLElement).style.color = "#a8a8b4"; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
        </svg>
      </button>
    </div>
  );

  return (
    <FloatingWindow
      id="eqrack"
      defaultWidth={920}
      defaultHeight={420}
      minWidth={640}
      minHeight={320}
      onClose={onClose}
      headerContent={header}
      accentColor="var(--accent-cyan)"
    >
      {({ width, height }) => {
        // Scale the track height based on available body space
        // (subtract padding ~48px top + 52px bottom bezel + labels ~40px)
        const TRACK_H = Math.max(160, height - 52 - 100);
        const bottomBezelH = 36;
        const contentH = height - bottomBezelH;

        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            {/* Main rack body */}
            <div style={{
              flex: 1,
              padding: "20px 20px 14px",
              background: "radial-gradient(ellipse at top, rgb(from var(--accent-blue) r g b / 0.06) 0%, transparent 70%), #0a0a0f",
              minHeight: 0, overflow: "hidden",
            }}>
              <div style={{ display: "flex", height: "100%" }}>
                {/* dB scale labels */}
                <div style={{
                  width: 30,
                  display: "flex", flexDirection: "column", justifyContent: "space-between",
                  padding: "4px 8px 26px 0", fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10, color: "#5a5a72", textAlign: "right" as const,
                }}>
                  <span>+12</span>
                  <span>+6</span>
                  <span style={{ color: "#a8a8b4", fontWeight: 700 }}>0</span>
                  <span>−6</span>
                  <span>−12</span>
                </div>

                {/* 10-band rack area */}
                <div style={{
                  flex: 1, display: "grid",
                  gridTemplateColumns: "repeat(10, 1fr)", gap: 4,
                  background: "linear-gradient(180deg, #06060a 0%, #0a0a0f 100%)",
                  border: "1px solid #1d1d28",
                  borderRadius: 4,
                  padding: "12px 10px 10px",
                  boxShadow: "inset 0 2px 8px rgba(0,0,0,0.5)",
                  position: "relative",
                }}>
                  {/* Horizontal dB grid */}
                  {[0, 0.25, 0.5, 0.75, 1].map((p, i) => (
                    <div key={i} style={{
                      position: "absolute",
                      left: 10, right: 10,
                      top: 12 + p * TRACK_H,
                      height: 1,
                      background: i === 2 ? "rgb(from var(--accent-cyan) r g b / 0.3)" : "rgba(255,255,255,0.04)",
                      pointerEvents: "none", zIndex: 1,
                    }} />
                  ))}

                  {EQ_FREQS.map((_, idx) => {
                    const gain    = bands[idx] ?? 0;
                    const gainPct = gain / MAX_DB;
                    const spec    = spectrum[idx] ?? 0;
                    const peak    = peaks[idx]    ?? 0;
                    const specPct = Math.min(1, spec);
                    const peakPct = Math.min(1, peak);

                    const barColor =
                      specPct > 0.9  ? "#ef4444" :
                      specPct > 0.75 ? "#f59e0b" :
                      specPct > 0.5  ? "#22c55e" :
                                       "var(--accent-cyan)";

                    return (
                      <div key={idx} style={{
                        display: "flex", flexDirection: "column", alignItems: "center",
                        position: "relative", zIndex: 2,
                      }}>
                        <div style={{
                          position: "relative", width: "100%", maxWidth: 44,
                          height: TRACK_H,
                          display: "flex", alignItems: "flex-end", justifyContent: "center",
                        }}>
                          {/* Spectrum bar */}
                          <div style={{
                            position: "absolute", bottom: 0, left: "22%", right: "22%",
                            height: `${specPct * 100}%`,
                            background: `linear-gradient(180deg, ${barColor} 0%, ${barColor}50 100%)`,
                            boxShadow: `0 0 10px ${barColor}80`,
                            borderRadius: 1,
                            transition: "height 0.05s linear, background 0.2s, box-shadow 0.2s",
                          }} />
                          {/* Peak-hold */}
                          {peakPct > 0.02 && (
                            <div style={{
                              position: "absolute",
                              bottom: `${peakPct * 100}%`,
                              left: "22%", right: "22%",
                              height: 2,
                              background: "#ffffff",
                              boxShadow: "0 0 4px #ffffff",
                              opacity: 0.85,
                              transition: "bottom 0.1s linear",
                            }} />
                          )}

                          {/* Slider track */}
                          <div
                            onMouseDown={dragBand(idx, TRACK_H)}
                            onDoubleClick={() => { const next = [...bands]; next[idx] = 0; onChange(next); }}
                            style={{
                              position: "absolute", inset: 0,
                              cursor: "ns-resize",
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}
                          >
                            {/* Fader cap */}
                            <div style={{
                              position: "absolute",
                              top: `${50 - gainPct * 50}%`,
                              transform: "translateY(-50%)",
                              width: 30, height: 14,
                              background: "linear-gradient(180deg, #5a5a72 0%, #2a2a36 100%)",
                              border: "1px solid #1a1a22",
                              borderRadius: 2,
                              boxShadow: Math.abs(gain) > 0.05
                                ? "0 0 10px rgb(from var(--accent-cyan) r g b / 0.6), 0 1px 0 rgba(255,255,255,0.15) inset, 0 -1px 0 rgba(0,0,0,0.3) inset"
                                : "0 1px 0 rgba(255,255,255,0.08) inset, 0 -1px 0 rgba(0,0,0,0.3) inset",
                              transition: "box-shadow 0.18s",
                              zIndex: 3,
                            }}>
                              <div style={{
                                position: "absolute", top: "50%", left: 2, right: 2,
                                height: 1, background: Math.abs(gain) > 0.05 ? "var(--accent-cyan)" : "#5a5a72",
                                transform: "translateY(-50%)",
                                boxShadow: Math.abs(gain) > 0.05 ? "0 0 4px var(--accent-cyan)" : "none",
                              }}/>
                            </div>
                          </div>
                        </div>

                        <div style={{
                          marginTop: 8, fontSize: 10,
                          fontFamily: "'JetBrains Mono', monospace",
                          color: Math.abs(gain) > 0.05 ? "var(--accent-cyan)" : "#5a5a72",
                          fontWeight: 700, letterSpacing: "0.03em", minHeight: 14,
                        }}>
                          {gain > 0.05 ? "+" : ""}{gain.toFixed(1)}
                        </div>
                        <div style={{
                          fontSize: 11, fontWeight: 700,
                          color: "#a8a8b4",
                          fontFamily: "'JetBrains Mono', monospace",
                          letterSpacing: "0.05em",
                        }}>{EQ_LABELS[idx]}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Bottom info strip */}
            <div style={{
              height: bottomBezelH, flexShrink: 0,
              background: "linear-gradient(180deg, #1a1a22 0%, #121218 100%)",
              borderTop: "1px solid #0a0a0f",
              display: "flex", alignItems: "center", padding: "0 20px", gap: 24,
              fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: "#5a5a72",
              letterSpacing: "0.08em",
            }}>
              <span>FFT · 2048pt · HANN</span>
              <span>·</span>
              <span>BIQUAD PEAKING · Q=1.0</span>
              <span>·</span>
              <span style={{ color: isActive ? "#ef4444" : "#5a5a72" }}>
                {isActive ? "● EQ ENGAGED" : "○ BYPASS"}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--accent-cyan)" }}>
                {isActive
                  ? `BOOST ${Math.max(...bands).toFixed(1)}dB · CUT ${Math.min(...bands).toFixed(1)}dB`
                  : "DOUBLE-CLICK ANY BAND TO RESET"}
              </span>
            </div>
          </div>
        );
      }}
    </FloatingWindow>
  );
}
