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
}

const BAR_COUNT = 32;
const PEAK_HOLD_MS = 1200;

// Deterministic pseudo-waveform for standby C — looks like a real audio file preview
function getWaveformShape(count: number): number[] {
  const shape: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    // Combines sine waves at different frequencies for a natural-looking waveform
    const v =
      0.35 +
      0.25 * Math.sin(t * Math.PI * 6.3) +
      0.15 * Math.sin(t * Math.PI * 14.7 + 0.8) +
      0.10 * Math.sin(t * Math.PI * 23.1 + 2.1) +
      0.08 * Math.cos(t * Math.PI * 9.4 + 1.3);
    shape.push(Math.max(0.04, Math.min(0.95, v)));
  }
  return shape;
}

const WAVEFORM_SHAPE = getWaveformShape(BAR_COUNT);

export default function VUMeter({
  deckId, isPlaying,
  remaining = 0, duration = 0, pos = 0,
  isInIntro, isEnding, isCritical, introEnd = 0,
  hasTrack = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const peaksRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const peakTimesRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const targetLevelRef = useRef(0);
  const rafRef = useRef<number>(0);
  const flatlinePhaseRef = useRef(0);

  const getColors = () => {
    if (!isPlaying) {
      if (deckId === "C") return { bar: "#a78bfa", peak: "#7c3aed", bg: "transparent" };
      if (deckId === "B") return { bar: "#34d399", peak: "#059669", bg: "transparent" };
      return { bar: "#64748b", peak: "#475569", bg: "transparent" };
    }
    if (isCritical) return { bar: "#f87171", peak: "#dc2626", bg: "transparent" };
    if (isEnding) return { bar: "#fb923c", peak: "#ea580c", bg: "transparent" };
    if (isInIntro) return { bar: "#38bdf8", peak: "#0284c7", bg: "transparent" };
    return { bar: "#34d399", peak: "#059669", bg: "transparent" };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      const colors = getColors();
      const now = Date.now();

      ctx.clearRect(0, 0, w, h);

      const barW = Math.max(2, Math.floor((w - BAR_COUNT + 1) / BAR_COUNT));
      const gap = 1;
      const totalW = BAR_COUNT * (barW + gap) - gap;
      const offsetX = Math.floor((w - totalW) / 2);

      // ── Mode: STANDBY — any deck with track loaded, not playing ──
      if (!isPlaying && hasTrack) {
        const isC = deckId === "C";
        const isA = deckId === "A";
        flatlinePhaseRef.current += isC ? 0.07 : isA ? 0.018 : 0.025;
        const phase = flatlinePhaseRef.current;

        for (let i = 0; i < BAR_COUNT; i++) {
          const x = offsetX + i * (barW + gap);
          const wave = isC
            ? 0.055 * Math.sin(phase - i * 0.38) + 0.025 * Math.sin(phase * 2.3 - i * 0.7) + 0.01 * Math.sin(phase * 3.1 + i * 0.4)
            : 0.04 * Math.sin(phase - i * 0.35) + 0.015 * Math.sin(phase * 1.7 - i * 0.6);
          const barH = Math.max(2, Math.floor(((isC ? 0.065 : 0.055) + wave) * h));
          const y = h / 2 - barH / 2;
          ctx.fillStyle = colors.bar;
          ctx.globalAlpha = isC ? 0.75 : 0.7;
          ctx.beginPath();
          ctx.roundRect(x, y, barW, barH, 1);
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        // Center line
        ctx.strokeStyle = colors.bar;
        ctx.globalAlpha = isC ? 0.4 : 0.35;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, isC ? 4 : 5]);
        ctx.beginPath();
        ctx.moveTo(offsetX, h / 2);
        ctx.lineTo(offsetX + totalW, h / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        ctx.fillStyle = colors.bar;
        ctx.globalAlpha = 0.55;
        ctx.font = `700 9px 'Inter', sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(isC ? "NEXT UP" : "STANDBY", w / 2, h - 8);
        ctx.globalAlpha = 1;

        rafRef.current = requestAnimationFrame(draw);
        return;
      }


      // ── Mode: IDLE — subtle floor bars ──
      if (!isPlaying) {
        for (let i = 0; i < BAR_COUNT; i++) {
          const x = offsetX + i * (barW + gap);
          ctx.fillStyle = colors.bar;
          ctx.globalAlpha = 0.18;
          const barH = Math.max(3, Math.floor(0.04 * h));
          ctx.beginPath();
          ctx.roundRect(x, h - barH, barW, barH, 1);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        // Dashed center line so there's something to see
        ctx.strokeStyle = colors.bar;
        ctx.globalAlpha = 0.12;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 6]);
        ctx.beginPath();
        ctx.moveTo(offsetX, h / 2);
        ctx.lineTo(offsetX + totalW, h / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // ── Mode: PLAYING — animated level bars ──
      for (let i = 0; i < BAR_COUNT; i++) {
        const x = offsetX + i * (barW + gap);

        const target = targetLevelRef.current * (0.55 + Math.random() * 0.45);
        const current = levelsRef.current[i];
        const diff = target - current;
        levelsRef.current[i] += diff * (diff > 0 ? 0.35 : 0.12);

        const level = levelsRef.current[i];
        const barH = Math.max(2, Math.floor(level * h));

        // Peak hold
        if (level > peaksRef.current[i]) {
          peaksRef.current[i] = level;
          peakTimesRef.current[i] = now;
        } else if (now - peakTimesRef.current[i] > PEAK_HOLD_MS) {
          peaksRef.current[i] = Math.max(0, peaksRef.current[i] - 0.015);
        }

        // Gradient bar
        const barGrad = ctx.createLinearGradient(x, h, x, h - barH);
        if (isCritical) {
          barGrad.addColorStop(0, "#fca5a5"); barGrad.addColorStop(0.5, "#f87171"); barGrad.addColorStop(1, "#dc2626");
        } else if (isEnding) {
          barGrad.addColorStop(0, "#fed7aa"); barGrad.addColorStop(0.5, "#fb923c"); barGrad.addColorStop(1, "#ea580c");
        } else if (isInIntro) {
          barGrad.addColorStop(0, "#bae6fd"); barGrad.addColorStop(0.5, "#38bdf8"); barGrad.addColorStop(1, "#0284c7");
        } else {
          barGrad.addColorStop(0, "#86efac"); barGrad.addColorStop(0.5, "#34d399"); barGrad.addColorStop(1, "#059669");
        }

        const radius = Math.min(2, barW / 2);
        ctx.fillStyle = barGrad;
        ctx.beginPath();
        ctx.roundRect(x, h - barH, barW, barH, [radius, radius, 0, 0]);
        ctx.fill();

        // Peak dot
        if (peaksRef.current[i] > 0.05) {
          const peakY = h - Math.floor(peaksRef.current[i] * h) - 2;
          ctx.fillStyle = colors.peak;
          ctx.fillRect(x, peakY, barW, 2);
        }

        // Empty track behind bar
        if (barH < h) {
          ctx.fillStyle = "rgba(0,0,0,0.04)";
          ctx.beginPath();
          ctx.roundRect(x, 0, barW, h - barH, [radius, radius, 0, 0]);
          ctx.fill();
        }
      }

      // Subtle horizontal grid lines
      ctx.strokeStyle = "rgba(0,0,0,0.04)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = Math.floor(h * (i / 4));
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, isInIntro, isEnding, isCritical, hasTrack, deckId]);

  // Poll audio levels
  useEffect(() => {
    if (!isPlaying) { targetLevelRef.current = 0; return; }
    const poll = async () => {
      try {
        const lvl = await invoke<{ a: number; b: number; c: number }>("get_levels");
        const raw = deckId === "A" ? lvl.a : deckId === "C" ? lvl.c : lvl.b;
        targetLevelRef.current = raw > 0 ? 0.3 + Math.random() * 0.6 : 0.1 + Math.random() * 0.2;
      } catch {
        targetLevelRef.current = 0.25 + Math.random() * 0.55;
      }
    };
    const id = setInterval(poll, 80);
    return () => { clearInterval(id); targetLevelRef.current = 0; };
  }, [isPlaying, deckId]);

  // Resize canvas to match container
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = devicePixelRatio || 1;
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.scale(dpr, dpr);
      }
    });
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  }, []);

  return (
    <div style={{ width: "100%", height: "100%", flex: 1, position: "relative", overflow: "hidden", borderRadius: 8 }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", borderRadius: 8 }} />
    </div>
  );
}
