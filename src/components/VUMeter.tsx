import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  deckId: "A" | "B" | "C" | string;
  isPlaying: boolean;
  remaining?: number;
  duration?: number;
  pos?: number;
  isInIntro?: boolean;
  isEnding?: boolean;
  isCritical?: boolean;
  introEnd?: number;
  hasTrack?: boolean;
  filePath?: string;
}

const BAR_COUNT    = 48;
const PEAK_HOLD_MS = 1200;

export default function VUMeter({
  deckId, isPlaying,
  remaining = 0, duration = 0, pos = 0,
  isInIntro, isEnding, isCritical,
  hasTrack = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Per-bar independent state
  const barLevels   = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const barTargets  = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const barPhases   = useRef<number[]>(
    Array.from({ length: BAR_COUNT }, (_, i) => i * 0.71 + Math.random() * 2)
  );
  const peakLevels  = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const peakTimes   = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const masterLevel = useRef(0);
  const rafRef      = useRef<number>(0);
  // Standby sine wave — separate per-deck phase, never resets
  const standbyPhase = useRef(Math.random() * Math.PI * 2);

  const getColors = () => {
    if (!isPlaying) {
      if (deckId === "C") return { bar: "#a78bfa", peak: "#7c3aed" };
      if (deckId === "B") return { bar: "#34d399", peak: "#059669" };
      return { bar: "#64748b", peak: "#475569" };
    }
    if (isCritical) return { bar: "#f87171", peak: "#dc2626" };
    if (isEnding)   return { bar: "#fb923c", peak: "#ea580c" };
    if (isInIntro)  return { bar: "#38bdf8", peak: "#0284c7" };
    return { bar: "#34d399", peak: "#059669" };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const w   = canvas.width;
      const h   = canvas.height;
      const col = getColors();
      const now = Date.now();

      ctx.clearRect(0, 0, w, h);

      const barW   = Math.max(2, Math.floor((w - (BAR_COUNT - 1)) / BAR_COUNT));
      const gap    = 1;
      const totalW = BAR_COUNT * (barW + gap) - gap;
      const offX   = Math.floor((w - totalW) / 2);

      // ── STANDBY sine wave — original bow-tie style ──────────
      if (!isPlaying) {
        if (hasTrack) {
          const speed = deckId === "C" ? 0.07 : deckId === "A" ? 0.018 : 0.025;
          standbyPhase.current += speed;
          const phase = standbyPhase.current;
          const isC   = deckId === "C";

          for (let i = 0; i < BAR_COUNT; i++) {
            const x    = offX + i * (barW + gap);
            const wave = isC
              ? 0.055 * Math.sin(phase - i * 0.38) +
                0.025 * Math.sin(phase * 2.3 - i * 0.7) +
                0.010 * Math.sin(phase * 3.1 + i * 0.4)
              : 0.040 * Math.sin(phase - i * 0.35) +
                0.015 * Math.sin(phase * 1.7 - i * 0.6);

            const amp  = isC ? 0.065 : 0.055;
            const barH = Math.max(2, Math.floor((amp + wave) * h));
            const y    = Math.floor(h / 2 - barH / 2);

            ctx.fillStyle   = col.bar;
            ctx.globalAlpha = isC ? 0.75 : 0.70;
            ctx.beginPath();
            ctx.roundRect(x, y, barW, barH, 1);
            ctx.fill();
            ctx.globalAlpha = 1;
          }

          // Dashed center line
          ctx.strokeStyle = col.bar;
          ctx.globalAlpha = isC ? 0.4 : 0.35;
          ctx.lineWidth   = 1;
          ctx.setLineDash([3, isC ? 4 : 5]);
          ctx.beginPath();
          ctx.moveTo(offX, h / 2);
          ctx.lineTo(offX + totalW, h / 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;

          // Status label
          const label = deckId === "C" ? "NEXT UP" : deckId === "A" ? "PRIMARY" : "STANDBY";
          ctx.font      = `700 8px 'Inter', sans-serif`;
          ctx.textAlign = "center";
          const lw      = ctx.measureText(label).width + 16;
          ctx.fillStyle   = col.bar;
          ctx.globalAlpha = 0.12;
          ctx.beginPath();
          ctx.roundRect(w / 2 - lw / 2, h - 22, lw, 16, 4);
          ctx.fill();
          ctx.globalAlpha = 0.5;
          ctx.fillText(label, w / 2, h - 11);
          ctx.globalAlpha = 1;

        } else {
          // No track
          for (let i = 0; i < BAR_COUNT; i++) {
            const x = offX + i * (barW + gap);
            ctx.fillStyle   = col.bar;
            ctx.globalAlpha = 0.1;
            ctx.beginPath();
            ctx.roundRect(x, Math.floor(h / 2 - 2), barW, 4, 1);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }

        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // ── PLAYING — each bar fully independent ─────────────────
      for (let i = 0; i < BAR_COUNT; i++) {
        // Advance this bar's own phase at its own speed
        barPhases.current[i] += 0.04 + (i % 7) * 0.005 + (i % 3) * 0.007;
        const p = barPhases.current[i];

        // Independent target — multi-frequency combination unique per bar
        const target =
          masterLevel.current * (
            0.4 +
            0.35 * Math.abs(Math.sin(p)) +
            0.15 * Math.abs(Math.sin(p * 1.61 + i)) +
            0.10 * Math.abs(Math.cos(p * 0.79 + i * 0.3))
          );

        // Smooth toward target: fast attack, slow decay
        const diff = target - barLevels.current[i];
        barLevels.current[i] += diff * (diff > 0 ? 0.40 : 0.08);

        const level = Math.max(0, barLevels.current[i]);
        const barH  = Math.max(2, Math.floor(level * h));

        // Peak hold per bar
        if (level > peakLevels.current[i]) {
          peakLevels.current[i] = level;
          peakTimes.current[i]  = now;
        } else if (now - peakTimes.current[i] > PEAK_HOLD_MS) {
          peakLevels.current[i] = Math.max(0, peakLevels.current[i] - 0.016);
        }

        // Bottom-up gradient
        const x    = offX + i * (barW + gap);
        const grad = ctx.createLinearGradient(x, h, x, h - barH);
        if (isCritical) {
          grad.addColorStop(0, "#fca5a5");
          grad.addColorStop(0.6, "#f87171");
          grad.addColorStop(1, "#dc2626");
        } else if (isEnding) {
          grad.addColorStop(0, "#fed7aa");
          grad.addColorStop(0.6, "#fb923c");
          grad.addColorStop(1, "#ea580c");
        } else if (isInIntro) {
          grad.addColorStop(0, "#bae6fd");
          grad.addColorStop(0.6, "#38bdf8");
          grad.addColorStop(1, "#0284c7");
        } else {
          grad.addColorStop(0, "#86efac");
          grad.addColorStop(0.6, "#34d399");
          grad.addColorStop(1, "#059669");
        }

        const r = Math.min(2, barW / 2);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(x, h - barH, barW, barH, [r, r, 0, 0]);
        ctx.fill();

        // Peak dot — clamped to visible area
        if (peakLevels.current[i] > 0.05) {
          const py = Math.max(2, h - Math.floor(peakLevels.current[i] * h) - 2);
          ctx.fillStyle   = col.peak;
          ctx.globalAlpha = 0.75;
          ctx.fillRect(x, py, barW, 2);
          ctx.globalAlpha = 1;
        }

        // Ghost above bar
        if (barH < h - 2) {
          ctx.fillStyle = "rgba(255,255,255,0.02)";
          ctx.beginPath();
          ctx.roundRect(x, 0, barW, h - barH, [r, r, 0, 0]);
          ctx.fill();
        }
      }

      // Subtle grid lines
      ctx.strokeStyle = "rgba(255,255,255,0.03)";
      ctx.lineWidth   = 1;
      for (let g = 1; g < 4; g++) {
        const y = Math.floor(h * g / 4);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, isInIntro, isEnding, isCritical, hasTrack, deckId]);

  // Poll master level
  useEffect(() => {
    if (!isPlaying) { masterLevel.current = 0; return; }
    const poll = async () => {
      try {
        const lvl = await invoke<{ a: number; b: number; c: number }>("get_levels");
        const raw = deckId === "A" ? lvl.a : deckId === "C" ? lvl.c : lvl.b;
        masterLevel.current = raw > 0.005 ? 0.3 + raw * 0.7 : 0.15 + Math.random() * 0.2;
      } catch {
        masterLevel.current = 0.2 + Math.random() * 0.5;
      }
    };
    const id = setInterval(poll, 60);
    return () => { clearInterval(id); masterLevel.current = 0; };
  }, [isPlaying, deckId]);

  // HiDPI resize
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
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", borderRadius: 8 }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", borderRadius: 8 }} />
    </div>
  );
}
