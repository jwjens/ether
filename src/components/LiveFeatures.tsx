import { useState, useEffect, useRef } from "react";
import { query } from "../db/client";

// ── Types ─────────────────────────────────────────────────────
interface PlayedSong {
  title: string;
  artist: string;
  played_at: number;
  deck: string;
}

// ── 1. LIVE HOUR CLOCK ────────────────────────────────────────
// Shows where you are in the current hour based on play_log

export function LiveHourClock() {
  const [played, setPlayed] = useState<PlayedSong[]>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const load = async () => {
      try {
        const hourStart = Math.floor(Date.now() / 1000) - (Math.floor(Date.now() / 1000) % 3600);
        const rows = await query<PlayedSong>(
          "SELECT title, artist, deck, played_at FROM play_log WHERE played_at >= ? ORDER BY played_at ASC LIMIT 30",
          [hourStart]
        );
        setPlayed(rows);
      } catch {}
    };
    load();
    const id = setInterval(() => { load(); setNow(Date.now()); }, 10000);
    return () => clearInterval(id);
  }, []);

  const SIZE = 120;
  const CX = SIZE / 2; const CY = SIZE / 2;
  const R_OUT = SIZE / 2 - 6;
  const R_IN = SIZE * 0.28;

  // Current position in the hour (0-1)
  const secInHour = (Math.floor(now / 1000)) % 3600;
  const pct = secInHour / 3600;
  const elapsed = pct * Math.PI * 2;

  // Build arc for elapsed time
  const ex = CX + R_OUT * Math.cos(-Math.PI / 2 + elapsed);
  const ey = CY + R_OUT * Math.sin(-Math.PI / 2 + elapsed);
  const ix = CX + R_IN * Math.cos(-Math.PI / 2 + elapsed);
  const iy = CY + R_IN * Math.sin(-Math.PI / 2 + elapsed);
  const large = elapsed > Math.PI ? 1 : 0;
  const elapsedPath = elapsed > 0.01
    ? `M ${CX} ${CY - R_OUT} A ${R_OUT} ${R_OUT} 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)} L ${ix.toFixed(2)} ${iy.toFixed(2)} A ${R_IN} ${R_IN} 0 ${large} 0 ${CX} ${CY - R_IN} Z`
    : "";

  // Tick marks at 15-min intervals
  const ticks = [0, 0.25, 0.5, 0.75].map(t => {
    const a = -Math.PI / 2 + t * Math.PI * 2;
    return {
      x1: CX + (R_OUT + 2) * Math.cos(a), y1: CY + (R_OUT + 2) * Math.sin(a),
      x2: CX + (R_OUT + 7) * Math.cos(a), y2: CY + (R_OUT + 7) * Math.sin(a),
    };
  });

  const minStr = String(Math.floor(secInHour / 60)).padStart(2, "0");
  const secStr = String(secInHour % 60).padStart(2, "0");

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 3 }}>
      <span style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.14em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>Hour</span>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {/* Background ring */}
        <circle cx={CX} cy={CY} r={R_OUT} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={R_OUT - R_IN} />
        {/* Elapsed arc */}
        {elapsedPath && <path d={elapsedPath} fill="var(--accent-cyan)" opacity="0.7" />}
        {/* Played songs as dots on the ring */}
        {played.map((p, i) => {
          const hourStart = Math.floor(now / 1000 / 3600) * 3600;
          const songPct = (p.played_at - hourStart) / 3600;
          const a = -Math.PI / 2 + songPct * Math.PI * 2;
          const r = R_IN + (R_OUT - R_IN) / 2;
          return (
            <circle key={i}
              cx={CX + r * Math.cos(a)} cy={CY + r * Math.sin(a)}
              r="2.5" fill="var(--accent-amber)" opacity="0.9"
            />
          );
        })}
        {/* 15-min ticks */}
        {ticks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeLinecap="round" />
        ))}
        {/* Now pointer */}
        <line
          x1={CX} y1={CY}
          x2={CX + (R_OUT - 4) * Math.cos(-Math.PI / 2 + elapsed)}
          y2={CY + (R_OUT - 4) * Math.sin(-Math.PI / 2 + elapsed)}
          stroke="var(--accent-cyan)" strokeWidth="1.5" strokeLinecap="round" opacity="0.9"
        />
        {/* Center */}
        <circle cx={CX} cy={CY} r={R_IN - 2} fill="var(--bg-primary)" />
        <text x={CX} y={CY + 4} textAnchor="middle" fill="rgba(255,255,255,0.8)"
          fontSize="11" fontWeight="700" fontFamily="'DM Mono', monospace">
          {minStr}:{secStr}
        </text>
      </svg>
      <span style={{ fontSize: 8, color: "var(--text-tertiary)" }}>{played.length} played</span>
    </div>
  );
}

// ── 2. SONG HISTORY STRIP ─────────────────────────────────────

export function SongHistoryStrip() {
  const [history, setHistory] = useState<PlayedSong[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        const rows = await query<PlayedSong>(
          "SELECT title, artist, deck, played_at FROM play_log ORDER BY played_at DESC LIMIT 5",
          []
        );
        setHistory(rows);
      } catch {}
    };
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  if (history.length === 0) return null;

  const fmtTime = (epoch: number) => {
    const d = new Date(epoch * 1000);
    return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
  };

  const deckColor = (deck: string) =>
    deck === "A" ? "var(--accent-cyan)" : deck === "B" ? "var(--accent-green)" : "var(--accent-purple)";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 0,
      background: "var(--bg-secondary)",
      border: "1px solid var(--border-primary)",
      borderRadius: 10, overflow: "hidden",
      flexShrink: 0,
    }}>
      <div style={{ padding: "5px 10px", borderRight: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <span style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.14em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>History</span>
      </div>
      {history.map((song, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 12px",
          borderRight: i < history.length - 1 ? "1px solid var(--border-primary)" : "none",
          opacity: 1 - i * 0.15,
          minWidth: 0,
        }}>
          <div style={{ width: 2, height: 20, borderRadius: 1, background: deckColor(song.deck), flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis", maxWidth: 120 }}>{song.title}</div>
            <div style={{ fontSize: 8, color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontFamily: "'DM Mono', monospace" }}>{fmtTime(song.played_at)}</span>
              <span>·</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, maxWidth: 80 }}>{song.artist}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 3. CROSSFADE VISUALIZER ───────────────────────────────────

interface XfadeProps {
  active: boolean;
  fromDeck: "A" | "B" | "C";
  toDeck: "A" | "B" | "C";
}

export function CrossfadeVisualizer({ active, fromDeck, toDeck }: XfadeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const progressRef = useRef(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (active) {
      setVisible(true);
      progressRef.current = 0;
    }
  }, [active]);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width; const H = canvas.height;
    const BAR = 3; const GAP = 2; const COUNT = Math.floor(W / (BAR + GAP));

    const deckColorRaw = (d: string) =>
      d === "A" ? [56, 189, 248] : d === "B" ? [52, 211, 153] : [167, 139, 250];

    const fromColor = deckColorRaw(fromDeck);
    const toColor = deckColorRaw(toDeck);

    const draw = () => {
      progressRef.current = Math.min(progressRef.current + 0.008, 1);
      const p = progressRef.current;

      ctx.clearRect(0, 0, W, H);

      for (let i = 0; i < COUNT; i++) {
        const x = i * (BAR + GAP);
        const wave = Math.sin(Date.now() / 200 + i * 0.3) * 0.4 + 0.6;

        // From deck — fading out
        const fromAlpha = (1 - p) * 0.8;
        const fromH = wave * H * (1 - p * 0.5);
        ctx.fillStyle = `rgba(${fromColor.join(",")}, ${fromAlpha})`;
        ctx.beginPath();
        ctx.roundRect(x, H / 2 - fromH / 2, BAR, fromH, 1);
        ctx.fill();

        // To deck — fading in
        const toAlpha = p * 0.8;
        const toH = wave * H * (0.3 + p * 0.7);
        ctx.fillStyle = `rgba(${toColor.join(",")}, ${toAlpha})`;
        ctx.beginPath();
        ctx.roundRect(x, H / 2 - toH / 2, BAR, toH, 1);
        ctx.fill();
      }

      // Center crossfade indicator
      ctx.fillStyle = `rgba(255,255,255,${0.6 * Math.sin(progressRef.current * Math.PI)})`;
      ctx.font = "700 9px Inter,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${fromDeck} → ${toDeck}`, W / 2, H / 2 + 3);

      if (progressRef.current < 1) {
        frameRef.current = requestAnimationFrame(draw);
      } else {
        setTimeout(() => setVisible(false), 500);
      }
    };

    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [visible, fromDeck, toDeck]);

  if (!visible) return null;

  return (
    <div style={{
      position: "absolute" as const,
      bottom: "100%", left: "50%",
      transform: "translateX(-50%)",
      marginBottom: 8,
      background: "var(--bg-secondary)",
      border: "1px solid var(--border-secondary)",
      borderRadius: 10, overflow: "hidden",
      boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
      zIndex: 100,
    }}>
      <canvas ref={canvasRef} width={200} height={40} />
    </div>
  );
}
