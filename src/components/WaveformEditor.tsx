import { useRef, useEffect, useCallback } from "react";

// Voice-track editor waveform — Audacity-style: click-drag to SELECT, click to seek.
// Renders a VIEW WINDOW [viewStart, viewEnd] of the take (for zoom); `peaks` are already
// extracted for that window. Times (playhead/selection) map through the window.

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function WaveformEditor({
  peaks, duration, viewStart, viewEnd, playhead, selection, onSelectionChange, onSeek,
}: {
  peaks: Float32Array | null;
  duration: number;
  viewStart: number;
  viewEnd: number;
  playhead: number;
  selection: { start: number; end: number } | null;
  onSelectionChange: (s: { start: number; end: number } | null) => void;
  onSeek: (sec: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vsRef = useRef(viewStart), veRef = useRef(viewEnd);
  useEffect(() => { vsRef.current = viewStart; }, [viewStart]);
  useEffect(() => { veRef.current = viewEnd; }, [viewEnd]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const W = canvas.width, H = canvas.height, mid = H / 2;
    const span = Math.max(1e-6, viewEnd - viewStart);
    const tToX = (t: number) => ((t - viewStart) / span) * W;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0a0a0f"; ctx.fillRect(0, 0, W, H);

    if (!peaks || peaks.length === 0 || duration === 0) {
      ctx.fillStyle = "#3a3a52"; ctx.font = "12px 'DM Mono', monospace"; ctx.textAlign = "center";
      ctx.fillText("No recording yet", W / 2, mid + 4);
      return;
    }

    // Selection — fill only when it has width, but ALWAYS draw the IN/OUT marker lines
    // (so a single mark, or in/out at the same spot, is still visible).
    if (selection) {
      const sx = tToX(selection.start), ex = tToX(selection.end);
      if (selection.end > selection.start) {
        const rs = Math.max(0, sx), re = Math.min(W, ex);
        if (re > rs) { ctx.fillStyle = "rgba(136,104,216,0.30)"; ctx.fillRect(rs, 0, re - rs, H); }
      }
      ctx.fillStyle = "#8868D8";
      if (sx >= -1 && sx <= W + 1) ctx.fillRect(sx - 1, 0, 2, H);
      if (ex >= -1 && ex <= W + 1) ctx.fillRect(ex - 1, 0, 2, H);
    }

    // Green symmetric waveform bars (peaks already cover the window)
    const barW = Math.max(1, W / peaks.length);
    const selS = selection ? tToX(selection.start) : -1, selE = selection ? tToX(selection.end) : -1;
    for (let i = 0; i < peaks.length; i++) {
      const x = i * barW;
      const barH = peaks[i] * mid * 0.9;
      ctx.fillStyle = (selection && x >= selS && x <= selE) ? "#c4b5fd" : "#34d399";
      ctx.fillRect(x, mid - barH, Math.max(1, barW - 0.4), Math.max(1, barH * 2));
    }

    // Center line
    ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();

    // Playhead
    if (playhead >= viewStart && playhead <= viewEnd) {
      const phX = tToX(playhead);
      ctx.strokeStyle = "#e8e8f0"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, H); ctx.stroke();
    }

    // Time ruler (absolute times within the view)
    ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.fillRect(0, H - 16, W, 16);
    ctx.font = "9px 'DM Mono', monospace"; ctx.textAlign = "center";
    const stepT = span < 4 ? 0.5 : span < 12 ? 1 : span < 40 ? 5 : 10;
    const first = Math.ceil(viewStart / stepT) * stepT;
    for (let t = first; t <= viewEnd; t += stepT) {
      const tx = tToX(t);
      ctx.fillStyle = "#3a3a52"; ctx.fillRect(tx, H - 16, 1, 4);
      ctx.fillStyle = "#52527a"; ctx.fillText(fmtTime(t), tx, H - 4);
    }
  }, [peaks, duration, viewStart, viewEnd, playhead, selection]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      const ctx = canvas.getContext("2d"); if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      draw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  const onDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const span = Math.max(1e-6, veRef.current - vsRef.current);
    const xToT = (cx: number) => vsRef.current + Math.max(0, Math.min(1, (cx - rect.left) / rect.width)) * span;
    const startX = e.clientX, startSec = xToT(startX);
    let dragged = false;
    const move = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startX) > 4) {
        dragged = true;
        const cur = xToT(ev.clientX);
        onSelectionChange({ start: Math.min(startSec, cur), end: Math.max(startSec, cur) });
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      // Plain click just moves the cursor — it does NOT clear marks (so [ click ] works). Use K to deselect.
      if (!dragged) onSeek(startSec);
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  return (
    <canvas ref={canvasRef} onMouseDown={onDown}
      style={{ width: "100%", height: "100%", display: "block", cursor: "text" }} />
  );
}
