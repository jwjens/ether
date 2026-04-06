import { useEffect, useRef } from "react";
const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);

interface Props {
  deckId: "A" | "B" | "C" | string;
  isPlaying: boolean;
  remaining?: number; duration?: number; pos?: number;
  isInIntro?: boolean; isEnding?: boolean; isCritical?: boolean;
  introEnd?: number; hasTrack?: boolean; filePath?: string;
}

const BAR_COUNT    = 48;
const PEAK_HOLD_MS = 1200;

export default function VUMeter({
  deckId, isPlaying,
  isInIntro, isEnding, isCritical, hasTrack = false,
}: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const barLevels    = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const barTargets   = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const barPhases    = useRef<number[]>(
    Array.from({ length: BAR_COUNT }, (_, i) => i * 0.71 + Math.random() * 2)
  );
  const peakLevels   = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const peakTimes    = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const masterLevel  = useRef(0);
  const rafRef       = useRef<number>(0);
  const standbyPhase = useRef(Math.random() * Math.PI * 2);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const w   = canvas.width;
      const h   = canvas.height;
      const now = Date.now();

      ctx.clearRect(0, 0, w, h);

      // Very dark background
      ctx.fillStyle = "#0a0a0e";
      ctx.fillRect(0, 0, w, h);

      const barW   = Math.max(2, Math.floor((w - (BAR_COUNT - 1)) / BAR_COUNT));
      const gap    = 1;
      const totalW = BAR_COUNT * (barW + gap) - gap;
      const offX   = Math.floor((w - totalW) / 2);

      // ── STANDBY ─────────────────────────────────────────────
      if (!isPlaying) {
        if (hasTrack) {
          const speed = deckId === "C" ? 0.07 : deckId === "A" ? 0.018 : 0.025;
          standbyPhase.current += speed;
          const phase = standbyPhase.current;
          const isC   = deckId === "C";
          const idleColor = deckId === "A" ? "#008878"
            : deckId === "C" ? "#203878"
            : "#1a6040";

          for (let i = 0; i < BAR_COUNT; i++) {
            const x    = offX + i * (barW + gap);
            const wave = isC
              ? 0.055 * Math.sin(phase - i * 0.38) + 0.025 * Math.sin(phase * 2.3 - i * 0.7)
              : 0.040 * Math.sin(phase - i * 0.35) + 0.015 * Math.sin(phase * 1.7 - i * 0.6);
            const amp  = isC ? 0.065 : 0.055;
            const barH = Math.max(2, Math.floor((amp + wave) * h));
            const y    = Math.floor(h / 2 - barH / 2);

            ctx.fillStyle   = idleColor;
            ctx.globalAlpha = 0.55;
            ctx.fillRect(x, y, barW, barH);
            ctx.globalAlpha = 1;
          }

          // Center line
          ctx.strokeStyle = idleColor;
          ctx.globalAlpha = 0.25;
          ctx.lineWidth   = 1;
          ctx.setLineDash([3, 5]);
          ctx.beginPath();
          ctx.moveTo(offX, h / 2);
          ctx.lineTo(offX + totalW, h / 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        } else {
          // No track — dim tick marks only
          for (let i = 0; i < BAR_COUNT; i++) {
            const x = offX + i * (barW + gap);
            ctx.fillStyle   = "#1a1a22";
            ctx.fillRect(x, Math.floor(h / 2 - 1), barW, 2);
          }
        }

        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // ── PLAYING — animate each bar independently ─────────────
      for (let i = 0; i < BAR_COUNT; i++) {
        barPhases.current[i] += 0.04 + (i % 7) * 0.005 + (i % 3) * 0.007;
        const p = barPhases.current[i];

        const target =
          masterLevel.current * (
            0.4 +
            0.35 * Math.abs(Math.sin(p)) +
            0.15 * Math.abs(Math.sin(p * 1.61 + i)) +
            0.10 * Math.abs(Math.cos(p * 0.79 + i * 0.3))
          );

        const diff = target - barLevels.current[i];
        barLevels.current[i] += diff * (diff > 0 ? 0.40 : 0.08);

        const level = Math.max(0, barLevels.current[i]);
        const barH  = Math.max(0, Math.floor(level * h));

        // Peak hold
        if (level > peakLevels.current[i]) {
          peakLevels.current[i] = level;
          peakTimes.current[i]  = now;
        } else if (now - peakTimes.current[i] > PEAK_HOLD_MS) {
          peakLevels.current[i] = Math.max(0, peakLevels.current[i] - 0.016);
        }

        const x = offX + i * (barW + gap);

        // ── Unlit track (above the fill) ──────────────────────
        if (barH < h) {
          ctx.fillStyle = "#111116";
          ctx.fillRect(x, 0, barW, h - barH);
        }

        // ── Lit fill with zone-aware gradient ─────────────────
        if (barH > 0) {
          const fillY = h - barH;
          // Determine the top zone the bar reaches
          const normPeak = level; // 0–1

          // Build gradient: bottom-to-top of the fill
          const grad = ctx.createLinearGradient(x, h, x, fillY);

          // Bottom of fill = brighter / more saturated (energy source)
          if (normPeak <= 0.60) {
            grad.addColorStop(0,   "#00c8a8"); // bright teal bottom
            grad.addColorStop(0.5, "#008878");
            grad.addColorStop(1,   "#006058");
          } else if (normPeak <= 0.80) {
            grad.addColorStop(0,   "#00c8a8"); // teal at base
            grad.addColorStop(0.5, "#008878");
            grad.addColorStop(0.75, "#c07820"); // amber transition
            grad.addColorStop(1,   "#905010");
          } else {
            grad.addColorStop(0,   "#00c8a8"); // teal at base
            grad.addColorStop(0.4, "#008878");
            grad.addColorStop(0.6, "#c07820"); // amber mid
            grad.addColorStop(0.8, "#c02828"); // red top
            grad.addColorStop(1,   "#901818");
          }

          ctx.fillStyle = grad;
          ctx.fillRect(x, fillY, barW, barH);

          // ── Highlight cap — top 2px of fill, brighter ────────
          if (barH > 4) {
            ctx.fillStyle   = "rgba(255,255,255,0.18)";
            ctx.fillRect(x, fillY, barW, 2);
          }
        }

        // ── Peak dot ─────────────────────────────────────────
        if (peakLevels.current[i] > 0.05) {
          const py      = Math.max(1, h - Math.floor(peakLevels.current[i] * h) - 2);
          const normPk  = peakLevels.current[i];
          const pkColor = normPk > 0.80 ? "#e04040"
            : normPk > 0.60 ? "#d09030"
            : "#00d8b0";
          ctx.fillStyle   = pkColor;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(x, py, barW, 2);
          ctx.globalAlpha = 1;
        }
      }

      // ── Zone separator tick lines (subtle) ───────────────────
      const tick60 = Math.floor(h * 0.40); // 60% fill level from top
      const tick80 = Math.floor(h * 0.20); // 80% fill level from top
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(0, tick60); ctx.lineTo(w, tick60); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, tick80); ctx.lineTo(w, tick80); ctx.stroke();

      // ── Glass / dome overlay ─────────────────────────────────
      // Soft white-to-transparent gradient over top ~35% of canvas
      const glass = ctx.createLinearGradient(0, 0, 0, h * 0.45);
      glass.addColorStop(0,   "rgba(255,255,255,0.055)");
      glass.addColorStop(0.5, "rgba(255,255,255,0.018)");
      glass.addColorStop(1,   "rgba(255,255,255,0)");
      ctx.fillStyle = glass;
      ctx.fillRect(0, 0, w, h * 0.45);

      // Very subtle vignette at edges
      const vig = ctx.createRadialGradient(w/2, h/2, h * 0.35, w/2, h/2, w * 0.8);
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, "rgba(0,0,0,0.22)");
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, w, h);

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, isInIntro, isEnding, isCritical, hasTrack, deckId]);

  // Poll real audio levels
  useEffect(() => {
    if (!isPlaying) { masterLevel.current = 0; return; }
    const poll = async () => {
      try {
        const lvl = await invoke("get_levels") as { a: number; b: number; c: number };
        const raw = deckId === "A" ? lvl.a : deckId === "C" ? lvl.c : lvl.b;
        masterLevel.current = Math.max(0, Math.min(1, raw));
      } catch {
        masterLevel.current = 0.28 + 0.32 * Math.abs(Math.sin(Date.now() * 0.0018));
      }
    };
    const id = setInterval(poll, 50);
    return () => { clearInterval(id); masterLevel.current = 0; };
  }, [isPlaying, deckId]);

  // HiDPI canvas sizing
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
        const c = canvas.getContext("2d");
        if (c) c.scale(dpr, dpr);
      }
    });
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  }, []);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}
