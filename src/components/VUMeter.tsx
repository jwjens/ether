import { useEffect, useRef } from "react";

interface Props {
  deckId: "A" | "B" | "C" | string;
  isPlaying: boolean;
  remaining?: number; duration?: number; pos?: number;
  isInIntro?: boolean; isEnding?: boolean; isCritical?: boolean;
  introEnd?: number; hasTrack?: boolean; filePath?: string;
  /** When provided, bypasses IPC subscription and uses this value (0–1) directly. */
  externalLevel?: number;
}

const PEAK_HOLD_MS = 1500;

export default function VUMeter({
  deckId, isPlaying,
  isInIntro, isEnding, isCritical, hasTrack = false,
  externalLevel,
}: Props) {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const rawLevel      = useRef(0);
  const levelL        = useRef(0);
  const peakL         = useRef(0);
  const peakLAt       = useRef(0);
  const phaseL        = useRef(0);
  const rafRef        = useRef<number>(0);
  const standbyPhase  = useRef(Math.random() * Math.PI * 2);

  // ── Draw loop ─────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return; }

      const w   = canvas.width;
      const h   = canvas.height;
      const now = Date.now();

      ctx.clearRect(0, 0, w, h);

      // Background — #080808, barely darker than deck surface #0e0e12
      ctx.fillStyle = "#080808";
      ctx.fillRect(0, 0, w, h);

      // ── STANDBY ───────────────────────────────────────────────
      if (!isPlaying) {
        if (hasTrack) {
          // Gentle center flatline wave — not a fake level simulation
          standbyPhase.current += 0.022;
          const p = standbyPhase.current;
          const col = deckId === "C" ? "#601820" : "#003828";
          ctx.fillStyle = col;
          ctx.globalAlpha = 0.55;
          const lineH = Math.max(2, Math.floor(h * 0.06));
          for (let x = 0; x < w; x += 3) {
            const wave = Math.sin(p + x * 0.04) * h * 0.04;
            const y = Math.floor(h / 2 - lineH / 2 + wave);
            ctx.fillRect(x, y, 2, lineH);
          }
          ctx.globalAlpha = 1;
        }
        // Deck letter — visible grey so jocks can identify which deck at a glance
        {
          const label = deckId === "mic" ? "MIC" : (/^[A-Z]$/.test(deckId) ? deckId : null);
          if (label) {
            const sz = label.length > 1
              ? Math.floor(Math.min(h * 0.40, w * 0.55))
              : Math.floor(Math.min(h * 0.40, w * 0.70));
            ctx.globalAlpha = hasTrack ? 0.18 : 0.30;
            ctx.fillStyle = "#c0c0d0";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = `bold ${sz}px sans-serif`;
            ctx.fillText(label, w / 2, h / 2);
            ctx.globalAlpha = 1;
          }
        }
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // ── PLAYING ────────────────────────────────────────────────
      phaseL.current += 0.042;
      const wobble = 0.05;
      const raw    = rawLevel.current;
      const targetL = Math.max(0, Math.min(1, raw + wobble * Math.sin(phaseL.current)));
      // Attack: ~2 frames (80%). Decay: ~300ms (5.5% per frame at 60fps)
      levelL.current += (targetL - levelL.current) * (targetL > levelL.current ? 0.80 : 0.055);


      const drawBar = (
        x: number, bw: number, lv: number,
        pkRef: React.MutableRefObject<number>,
        pkAtRef: React.MutableRefObject<number>
      ) => {
        const barH = Math.floor(lv * h);
        const fillY = h - barH;

        // Unlit track — #080808, same as bg, invisible when silent
        ctx.fillStyle = "#080808";
        ctx.fillRect(x, 0, bw, h);

        // Lit fill — gradient: teal at bottom → amber at 60% → red at top
        if (barH > 0) {
          const grad = ctx.createLinearGradient(x, h, x, 0);
          grad.addColorStop(0,    "#008878"); // teal at bottom
          grad.addColorStop(0.60, "#a07020"); // amber at 60%
          grad.addColorStop(0.80, "#a02020"); // red at 80%
          grad.addColorStop(1,    "#a02020"); // red at top
          ctx.fillStyle = grad;
          ctx.fillRect(x, fillY, bw, barH);
        }

        // Peak hold line (1px)
        if (lv > pkRef.current) {
          pkRef.current   = lv;
          pkAtRef.current = now;
        } else if (now - pkAtRef.current > PEAK_HOLD_MS) {
          pkRef.current = Math.max(0, pkRef.current - 0.010);
        }
        if (pkRef.current > 0.05) {
          const py = Math.max(0, h - Math.floor(pkRef.current * h) - 1);
          ctx.fillStyle = pkRef.current > 0.80 ? "#e04040"
            : pkRef.current > 0.60 ? "#d09030"
            : "#00c8a8";
          ctx.fillRect(x, py, bw, 1);
        }
      };

      // ── MONO — single full-width bar for all decks ───────────
      drawBar(0, w, levelL.current, peakL, peakLAt);

      // Subtle zone ticks (60% and 80%)
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth   = 1;
      [0.40, 0.20].forEach(f => {
        const y = Math.floor(h * f);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      });

      // Watermark — capped by both height (40%) and width so it never cramps
      ctx.save();
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (deckId === "mic") {
        // "MIC" is 3 chars — cap width: font ≤ w * 0.55 so text fits with margin
        const sz = Math.floor(Math.min(h * 0.40, w * 0.55));
        ctx.font = `bold ${sz}px sans-serif`;
        ctx.fillText("MIC", w / 2, h / 2);
      } else if (/^[A-Z]$/.test(deckId)) {
        // Single char — cap width: font ≤ w * 0.70 (char is ~0.6× font-size wide)
        const sz = Math.floor(Math.min(h * 0.40, w * 0.70));
        ctx.font = `bold ${sz}px sans-serif`;
        ctx.fillText(deckId, w / 2, h / 2);
      }
      ctx.restore();

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, hasTrack, deckId]);

  // ── External level (e.g. mic, bypasses IPC) ──────────────────
  useEffect(() => {
    if (externalLevel === undefined) return;
    rawLevel.current = Math.max(0, Math.min(1, externalLevel));
  }, [externalLevel]);

  // ── Real-time level subscription — 30fps push, no polling ─────
  useEffect(() => {
    if (externalLevel !== undefined) return; // skip IPC when caller provides level
    if (!isPlaying) {
      rawLevel.current = 0;
      levelL.current   = 0;
      peakL.current    = 0;
      return;
    }
    const handle = (window as any).ether.audio.onLevels(
      (lvl: { a: number; b: number; c: number; [k: string]: number }) => {
        const raw = deckId === "A" ? lvl.a
          : deckId === "C" ? lvl.c
          : lvl.b;
        rawLevel.current = Math.max(0, Math.min(1, raw || 0));
      }
    );
    return () => {
      (window as any).ether.audio.offLevels(handle);
      rawLevel.current = 0;
      levelL.current   = 0;
      peakL.current    = 0;
    };
  }, [isPlaying, deckId, externalLevel]);

  // ── HiDPI canvas sizing ────────────────────────────────────────
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
        // No ctx.scale() — draw loop uses raw device pixels
      }
    });
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  }, []);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", background: "#080808" }} />
    </div>
  );
}
