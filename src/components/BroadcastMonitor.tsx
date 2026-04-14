// BroadcastMonitor.tsx — Full broadcast monitor for the Master Output popout window
// Shown when the pop-out icon is clicked on the inline Master Out panel.
// Default window size: 800×600 (resizable). All colors via CSS variables.

import React, { useEffect, useRef, useState } from "react";
import { query } from "../db/client";

const TEAL = "#00c8a8";
const AMB  = "#c07820";
const PEAK_HOLD_MS = 1400;

// ── BigClock ──────────────────────────────────────────────────────
function BigClock() {
  const timeRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tick = () => {
      const n = new Date();
      const hh = String(n.getHours()).padStart(2, "0");
      const mm = String(n.getMinutes()).padStart(2, "0");
      const ss = String(n.getSeconds()).padStart(2, "0");
      if (timeRef.current) timeRef.current.textContent = `${hh}:${mm}:${ss}`;
      if (dateRef.current) {
        dateRef.current.textContent = n.toLocaleDateString([], {
          weekday: "long", month: "long", day: "numeric", year: "numeric",
        });
      }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 0 0 28px" }}>
      <div
        ref={timeRef}
        style={{
          fontFamily: "'DM Mono', 'Courier New', monospace",
          fontSize: 54,
          fontWeight: 700,
          letterSpacing: "0.04em",
          color: "var(--text-primary)",
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
        }}
      />
      <div
        ref={dateRef}
        style={{
          fontFamily: "'DM Mono', 'Courier New', monospace",
          fontSize: 11,
          color: "var(--text-secondary)",
          marginTop: 7,
          letterSpacing: "0.05em",
          textTransform: "uppercase" as const,
        }}
      />
    </div>
  );
}

// ── OnAirBadge ────────────────────────────────────────────────────
function OnAirBadge({ live }: { live: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 28px 0 0" }}>
      <div style={{
        padding: "12px 28px",
        background: live ? "rgba(192,40,40,0.16)" : "rgba(30,30,44,0.5)",
        border: `2px solid ${live ? "#c02828" : "var(--border-primary)"}`,
        color: live ? "#e85050" : "var(--text-tertiary)",
        fontSize: 20,
        fontWeight: 900,
        letterSpacing: "0.26em",
        textTransform: "uppercase" as const,
        animation: live ? "onair-pulse 1.8s ease-in-out infinite" : "none",
        transition: "color 0.3s, border-color 0.3s, background 0.3s",
        userSelect: "none",
      }}>
        {live ? "ON AIR" : "STANDBY"}
      </div>
      <style>{`
        @keyframes onair-pulse {
          0%,100% { box-shadow: 0 0 14px rgba(192,40,40,0.30); }
          50%      { box-shadow: 0 0 30px rgba(192,40,40,0.60); }
        }
      `}</style>
    </div>
  );
}

// ── NowPlayingPanel ───────────────────────────────────────────────
function NowPlayingPanel({
  title, artist, positionSec, durationSec,
}: {
  title: string; artist: string; positionSec: number; durationSec: number;
}) {
  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const progress = durationSec > 0 ? Math.min(1, positionSec / durationSec) : 0;
  const remaining = Math.max(0, durationSec - positionSec);

  return (
    <div style={{ padding: "14px 28px 16px", borderBottom: "1px solid var(--border-primary)" }}>
      <div style={{
        fontSize: 8.5, fontWeight: 800, letterSpacing: "0.15em",
        color: "var(--text-secondary)", textTransform: "uppercase" as const, marginBottom: 10,
      }}>Now Playing</div>

      <div style={{
        fontSize: 24, fontWeight: 700, color: "var(--text-primary)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.15,
      }}>
        {title || "—"}
      </div>
      <div style={{
        fontSize: 14, color: "var(--text-secondary)", marginTop: 3,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>
        {artist || ""}
      </div>

      {/* Progress bar */}
      <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{
          fontSize: 11, fontFamily: "'DM Mono', monospace",
          color: "var(--text-tertiary)", flexShrink: 0, minWidth: 36,
        }}>
          {fmt(positionSec)}
        </span>
        <div style={{
          flex: 1, height: 5, background: "var(--bg-tertiary, #1a1a2a)",
          borderRadius: 3, overflow: "hidden",
        }}>
          <div style={{
            width: `${progress * 100}%`,
            height: "100%",
            background: `linear-gradient(90deg, ${TEAL} 0%, #00a090 100%)`,
            borderRadius: 3,
            transition: "width 0.8s linear",
          }} />
        </div>
        <span style={{
          fontSize: 11, fontFamily: "'DM Mono', monospace",
          color: "var(--text-tertiary)", flexShrink: 0, minWidth: 42, textAlign: "right" as const,
        }}>
          -{fmt(remaining)}
        </span>
      </div>
    </div>
  );
}

// ── MonitorVU — large stereo VU canvas ───────────────────────────
function MonitorVU({ master }: { master: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelL    = useRef(0);
  const levelR    = useRef(0);
  const peakL     = useRef(0); const peakLAt = useRef(0);
  const peakR     = useRef(0); const peakRAt = useRef(0);
  const phaseL    = useRef(0);
  const phaseR    = useRef(Math.PI * 0.37);
  const rafRef    = useRef(0);
  const masterRef = useRef(master);

  useEffect(() => { masterRef.current = master; }, [master]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        const dpr = window.devicePixelRatio || 1;
        canvas.width  = Math.floor(width  * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width  = width  + "px";
        canvas.style.height = height + "px";
      }
    });
    ro.observe(canvas);

    let cachedBg   = "#080810";
    let cachedTxt  = "#505060";
    let colorTs    = 0;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return; }
      const w   = canvas.width;
      const h   = canvas.height;
      const now = Date.now();

      if (now - colorTs > 2000) {
        const cs   = getComputedStyle(canvas);
        cachedBg   = cs.getPropertyValue("--bg-primary").trim()       || "#080810";
        cachedTxt  = cs.getPropertyValue("--text-secondary").trim()   || "#505060";
        colorTs = now;
      }

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = cachedBg;
      ctx.fillRect(0, 0, w, h);

      const m = masterRef.current;
      phaseL.current += 0.044;
      phaseR.current += 0.037;
      const wobble  = 0.04;
      const targetL = Math.max(0, Math.min(1, m + wobble * Math.sin(phaseL.current)));
      const targetR = Math.max(0, Math.min(1, m + wobble * Math.sin(phaseR.current)));
      levelL.current += (targetL - levelL.current) * (targetL > levelL.current ? 0.75 : 0.06);
      levelR.current += (targetR - levelR.current) * (targetR > levelR.current ? 0.75 : 0.06);

      const drawBar = (
        x: number, bw: number, lv: number,
        pkRef: React.MutableRefObject<number>,
        pkAt:  React.MutableRefObject<number>,
        label: string,
      ) => {
        const barH = Math.floor(lv * h);
        const fillY = h - barH;

        ctx.fillStyle = cachedBg;
        ctx.fillRect(x, 0, bw, h);

        if (barH > 0) {
          const grad = ctx.createLinearGradient(x, h, x, fillY);
          if (lv <= 0.60) {
            grad.addColorStop(0, "#00c8a8"); grad.addColorStop(1, "#005a50");
          } else if (lv <= 0.80) {
            grad.addColorStop(0, "#00c8a8"); grad.addColorStop(0.65, "#c07820"); grad.addColorStop(1, "#905010");
          } else {
            grad.addColorStop(0, "#00c8a8"); grad.addColorStop(0.5, "#c07820"); grad.addColorStop(0.8, "#c02828"); grad.addColorStop(1, "#901818");
          }
          ctx.fillStyle = grad;
          ctx.fillRect(x, fillY, bw, barH);
        }

        // Peak hold
        if (lv > pkRef.current) {
          pkRef.current = lv; pkAt.current = now;
        } else if (now - pkAt.current > PEAK_HOLD_MS) {
          pkRef.current = Math.max(0, pkRef.current - 0.010);
        }
        if (pkRef.current > 0.04) {
          const py = Math.max(1, h - Math.floor(pkRef.current * h) - 2);
          ctx.fillStyle = pkRef.current > 0.80 ? "#e04040" : pkRef.current > 0.60 ? "#d09030" : "#00d8b0";
          ctx.fillRect(x, py, bw, 2);
        }

        // Zone tick lines
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        ctx.lineWidth = 1;
        [0.40, 0.20].forEach(f => {
          const y = Math.floor(h * f);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + bw, y); ctx.stroke();
        });

        // Zone labels on right edge
        const labelSz = Math.max(9, Math.min(12, Math.floor(w * 0.035)));
        ctx.fillStyle = cachedTxt;
        ctx.font = `600 ${labelSz}px system-ui`;
        ctx.textAlign = "center";
        ctx.fillText(label, x + bw / 2, h - 4);
      };

      const gap  = Math.max(3, Math.floor(w * 0.02));
      const barW = Math.floor((w - gap) / 2);
      drawBar(0,         barW, levelL.current, peakL, peakLAt, "L");
      drawBar(barW + gap, barW, levelR.current, peakR, peakRAt, "R");

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "100%", display: "block", background: "var(--bg-primary)" }}
    />
  );
}

// ── BigFader ──────────────────────────────────────────────────────
function BigFader({
  label, value, onChange,
}: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 800, letterSpacing: "0.12em",
          color: "var(--text-secondary)", textTransform: "uppercase" as const,
        }}>{label}</span>
        <span style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: TEAL }}>
          {Math.round(value * 100)}
        </span>
      </div>
      <input
        type="range" min={0} max={1} step={0.01} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: TEAL, cursor: "pointer", height: 6 }}
      />
    </div>
  );
}

// ── StatsRow ──────────────────────────────────────────────────────
function StatCell({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, justifyContent: "center", padding: "0 12px" }}>
      {dot && (
        <div style={{
          width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0,
        }} />
      )}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
        <span style={{
          fontSize: 8, fontWeight: 800, letterSpacing: "0.14em",
          color: "var(--text-tertiary)", textTransform: "uppercase" as const,
        }}>{label}</span>
        <span style={{
          fontSize: 14, fontFamily: "'DM Mono', monospace",
          color: "var(--text-primary)", letterSpacing: "0.04em",
        }}>{value}</span>
      </div>
    </div>
  );
}

// ── NextUpList ────────────────────────────────────────────────────
function NextUpList({ items }: { items: { title: string; artist: string }[] }) {
  return (
    <div style={{ padding: "10px 28px 12px" }}>
      <div style={{
        fontSize: 8.5, fontWeight: 800, letterSpacing: "0.15em",
        color: "var(--text-secondary)", textTransform: "uppercase" as const, marginBottom: 8,
      }}>Next Up</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", opacity: 0.5, fontStyle: "italic" }}>
          Queue is empty
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {items.slice(0, 3).map((item, i) => (
            <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{
                fontSize: 10, fontFamily: "'DM Mono', monospace",
                color: "var(--text-tertiary)", flexShrink: 0, width: 14,
              }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13, fontWeight: 600, color: "var(--text-primary)",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>{item.title}</div>
                <div style={{
                  fontSize: 11, color: "var(--text-secondary)",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>{item.artist}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── BroadcastMonitor (main) ───────────────────────────────────────
export default function BroadcastMonitor() {
  const [masterLevel, setMasterLevel] = useState(0);
  const [masterVol,   setMasterVol]   = useState(1.0);
  const [monitorVol,  setMonitorVol]  = useState(0.8);
  const [onAir,       setOnAir]       = useState(false);

  const [title,       setTitle]       = useState("");
  const [artist,      setArtist]      = useState("");
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [upcoming,    setUpcoming]    = useState<{ title: string; artist: string }[]>([]);

  const [uptime,      setUptime]      = useState("0:00");
  const [nextBreak,   setNextBreak]   = useState("—");
  const [streamStatus, setStreamStatus] = useState("—");

  // Interpolate position between updates
  const posBaseRef   = useRef(0);
  const posBaseAt    = useRef(Date.now());
  const durRef       = useRef(0);
  const playingRef   = useRef(false);

  // ── Master level subscription ──────────────────────────────────
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.audio?.onLevels) return;
    const h = ether.audio.onLevels((lvl: { master?: number }) => {
      const lv = lvl.master ?? 0;
      setMasterLevel(lv);
      setOnAir(lv > 0.03);
    });
    return () => ether.audio.offLevels(h);
  }, []);

  // ── Now-playing updates from main window ──────────────────────
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.on) return;

    const h = ether.on("now-playing-update", (payload: any) => {
      const t = payload.title   || "";
      const a = payload.artist  || "";
      const pos = Number(payload.positionSec ?? payload.position ?? 0);
      const dur = Number(payload.durationSec ?? payload.duration ?? 0);
      const isPlaying = payload.isPlaying !== false;

      setTitle(t);
      setArtist(a);
      setDurationSec(dur);
      setPositionSec(pos);

      posBaseRef.current = pos;
      posBaseAt.current  = Date.now();
      durRef.current     = dur;
      playingRef.current = isPlaying;

      if (payload.upcoming && Array.isArray(payload.upcoming)) {
        setUpcoming(payload.upcoming.map((q: any) => ({
          title:  q.title  || "",
          artist: q.artist || q.artist_name || "",
        })));
      }
    });

    // Request current state from main window
    setTimeout(() => ether.emit("now-playing-request", {}), 600);

    return () => ether.off("now-playing-update", h);
  }, []);

  // ── Position interpolation — advances smoothly every 500ms ────
  useEffect(() => {
    const id = setInterval(() => {
      if (!playingRef.current || durRef.current <= 0) return;
      const elapsed = (Date.now() - posBaseAt.current) / 1000;
      const interpolated = Math.min(durRef.current, posBaseRef.current + elapsed);
      setPositionSec(interpolated);
    }, 500);
    return () => clearInterval(id);
  }, []);

  // ── Queue sync — refresh upcoming list ────────────────────────
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.on) return;
    const h = ether.on("queue:sync", () => {
      ether.emit("now-playing-request", {});
    });
    return () => ether.off("queue:sync", h);
  }, []);

  // ── Session uptime ────────────────────────────────────────────
  useEffect(() => {
    const stored = sessionStorage.getItem("ether_session_start");
    const start  = stored ? parseInt(stored, 10) : Date.now();
    if (!stored) sessionStorage.setItem("ether_session_start", String(start));

    const id = setInterval(() => {
      const sec = Math.floor((Date.now() - start) / 1000);
      const h   = Math.floor(sec / 3600);
      const m   = Math.floor((sec % 3600) / 60);
      const s   = sec % 60;
      setUptime(h > 0
        ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
        : `${m}:${String(s).padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Next show boundary ────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const hour = new Date().getHours();
        const rows = await query<{ name: string; start_hour: number }>(
          "SELECT name, start_hour FROM shows WHERE is_active=1 AND start_hour > ? ORDER BY start_hour LIMIT 1",
          [hour]
        );
        if (rows.length > 0) {
          const h  = rows[0].start_hour;
          const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          setNextBreak(`${h12}:00 ${h >= 12 ? "PM" : "AM"}`);
        } else {
          setNextBreak("—");
        }
      } catch { setNextBreak("—"); }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Stream status ─────────────────────────────────────────────
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.on) return;
    const h = ether.on("stream:status", (s: string) => setStreamStatus(s || "—"));
    return () => ether.off("stream:status", h);
  }, []);

  const effectiveMaster = masterLevel * masterVol;

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      background: "var(--bg-primary)", color: "var(--text-primary)",
      fontFamily: "'Inter', system-ui, sans-serif",
      fontSize: 13, overflow: "hidden", userSelect: "none",
    }}>

      {/* ── Row 1: Clock + ON AIR ────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexShrink: 0, height: 110,
        borderBottom: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
      }}>
        <BigClock />
        <OnAirBadge live={onAir} />
      </div>

      {/* ── Row 2: Now Playing ───────────────────────────────────── */}
      <NowPlayingPanel
        title={title}
        artist={artist}
        positionSec={positionSec}
        durationSec={durationSec}
      />

      {/* ── Row 3: VU Meters + Faders ───────────────────────────── */}
      <div style={{
        display: "flex", flex: 1, minHeight: 0,
        borderBottom: "1px solid var(--border-primary)",
      }}>
        {/* VU meters — left 55% */}
        <div style={{
          width: "55%", padding: "12px 16px 12px 28px",
          borderRight: "1px solid var(--border-primary)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            fontSize: 8.5, fontWeight: 800, letterSpacing: "0.14em",
            color: "var(--text-secondary)", textTransform: "uppercase" as const, marginBottom: 8, flexShrink: 0,
          }}>Output Level</div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <MonitorVU master={effectiveMaster} />
          </div>
        </div>

        {/* Faders — right 45% */}
        <div style={{
          flex: 1, padding: "16px 28px",
          display: "flex", flexDirection: "column", justifyContent: "center", gap: 20,
        }}>
          <BigFader label="Master"  value={masterVol}  onChange={setMasterVol}  />
          <BigFader label="Monitor" value={monitorVol} onChange={setMonitorVol} />

          {/* Limiter indicator */}
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "6px 0 0",
            borderTop: "1px solid var(--border-primary)",
          }}>
            <span style={{
              fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em",
              color: "var(--text-secondary)", textTransform: "uppercase" as const,
            }}>Limiter</span>
            <span style={{
              fontSize: 11, fontFamily: "'DM Mono', monospace",
              color: effectiveMaster > 0.85 ? AMB : TEAL,
            }}>
              {effectiveMaster > 0.85
                ? `-${((effectiveMaster - 0.85) / 0.15 * 6).toFixed(1)} dB`
                : "0.0 dB"}
            </span>
          </div>
        </div>
      </div>

      {/* ── Row 4: Station stats ─────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "stretch",
        borderBottom: "1px solid var(--border-primary)",
        flexShrink: 0, height: 56,
        background: "var(--bg-secondary)",
      }}>
        <StatCell
          label="On Air"
          value={onAir ? "LIVE" : "STBY"}
          dot={onAir ? "#22c55e" : "var(--border-primary)"}
        />
        <div style={{ width: 1, background: "var(--border-primary)" }} />
        <StatCell label="Uptime"     value={uptime}      />
        <div style={{ width: 1, background: "var(--border-primary)" }} />
        <StatCell label="Next Break" value={nextBreak}   />
        <div style={{ width: 1, background: "var(--border-primary)" }} />
        <StatCell label="Stream"     value={streamStatus} />
      </div>

      {/* ── Row 5: Next Up ──────────────────────────────────────── */}
      <div style={{ flexShrink: 0 }}>
        <NextUpList items={upcoming} />
      </div>

    </div>
  );
}
