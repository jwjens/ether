import { useState, useEffect, useRef } from "react";

interface Props {
  deckId: "A" | "B";
  isPlaying: boolean;
}

export default function VUMeter({ deckId, isPlaying }: Props) {
  const [bars, setBars] = useState<number[]>(Array(20).fill(0));
  const [peak, setPeak] = useState(0);
  const peakTimeout = useRef<any>(null);
  const frameRef = useRef<any>(null);
  const levelRef = useRef(0);

  useEffect(() => {
    if (!isPlaying) {
      // Decay to zero
      const decay = () => {
        levelRef.current = Math.max(0, levelRef.current - 0.05);
        const l = levelRef.current;
        setBars(Array(20).fill(0).map((_, i) => i < Math.round(l * 20) ? 1 : 0));
        if (levelRef.current > 0) frameRef.current = requestAnimationFrame(decay);
      };
      frameRef.current = requestAnimationFrame(decay);
      return () => cancelAnimationFrame(frameRef.current);
    }

    // Animate realistic VU meter
    let t = 0;
    const animate = () => {
      t += 0.08;
      // Realistic music-like level variation
      const base = 0.65;
      const variation = Math.sin(t * 2.3) * 0.15 + Math.sin(t * 5.1) * 0.08 + Math.sin(t * 11.7) * 0.04;
      const beat = Math.abs(Math.sin(t * 1.2)) > 0.92 ? 0.15 : 0;
      const level = Math.max(0, Math.min(1, base + variation + beat));
      levelRef.current = level;

      const activeBars = Math.round(level * 20);
      setBars(Array(20).fill(0).map((_, i) => i < activeBars ? 1 : 0));

      if (level > peak) {
        setPeak(level);
        clearTimeout(peakTimeout.current);
        peakTimeout.current = setTimeout(() => setPeak(0), 1500);
      }

      frameRef.current = requestAnimationFrame(animate);
    };

    frameRef.current = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frameRef.current);
      clearTimeout(peakTimeout.current);
    };
  }, [isPlaying]);

  const peakBar = Math.round(peak * 20);

  return (
    <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 32, padding: "4px 0 0" }}>
      {bars.map((active, i) => {
        const color = i < 12 ? "#22c55e" : i < 17 ? "#f59e0b" : "#ef4444";
        const isPeak = i === peakBar - 1 && peak > 0 && !active;
        return (
          <div key={i} style={{
            flex: 1,
            height: Math.round(((i + 1) / 20) * 28) + 4 + "px",
            background: active ? color : isPeak ? color : "rgba(255,255,255,0.07)",
            borderRadius: 2,
            transition: active ? "none" : "background 0.1s",
          }} />
        );
      })}
    </div>
  );
}
