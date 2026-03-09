import { useRef, useEffect } from "react";

interface Props {
  peaks: number[];
  progress: number; // 0 to 1
  color: string;
  playedColor: string;
  height?: number;
}

export default function Waveform({ peaks, progress, color, playedColor, height = 60 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;
    const barW = Math.max(1, w / (peaks.length || 1));
    const playedX = progress * w;

    ctx.clearRect(0, 0, w, h);

    if (peaks.length === 0) {
      ctx.fillStyle = "#27272a";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#3f3f46";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No track loaded", w / 2, mid + 4);
      return;
    }

    for (let i = 0; i < peaks.length; i++) {
      const x = i * barW;
      const barH = peaks[i] * mid * 0.9;
      ctx.fillStyle = x < playedX ? playedColor : color;
      ctx.fillRect(x, mid - barH, Math.max(1, barW - 0.5), barH * 2);
    }

    // Playhead line
    if (progress > 0 && progress < 1) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playedX, 0);
      ctx.lineTo(playedX, h);
      ctx.stroke();
    }
  }, [peaks, progress, color, playedColor, height]);

  return (
    <canvas
      ref={canvasRef}
      width={600}
      height={height}
      style={{ width: "100%", height: height + "px", borderRadius: "6px", background: "#18181b" }}
    />
  );
}