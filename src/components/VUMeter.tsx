import { useEffect, useRef, memo } from "react";

interface Props {
  deckId: "A" | "B";
  isPlaying: boolean;
}

const VUMeter = memo(function VUMeter({ isPlaying }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<any>(null);
  const tRef = useRef(0);
  const NUM = 20;

  useEffect(() => {
    const bars = containerRef.current?.querySelectorAll<HTMLDivElement>('.vu-bar');
    if (!bars) return;

    const animate = () => {
      tRef.current += 0.06;
      const t = tRef.current;
      const base = isPlaying ? 0.6 : 0;
      const v = isPlaying ? Math.sin(t*2.1)*0.12 + Math.sin(t*4.7)*0.07 + Math.sin(t*9.3)*0.03 : 0;
      const beat = isPlaying && Math.abs(Math.sin(t*1.1)) > 0.93 ? 0.18 : 0;
      const level = Math.max(0, Math.min(1, base + v + beat));
      const activeBars = Math.round(level * NUM);

      bars.forEach((bar, i) => {
        const active = i < activeBars;
        const color = i < 12 ? "#22c55e" : i < 17 ? "#f59e0b" : "#ef4444";
        bar.style.background = active ? color : "rgba(255,255,255,0.07)";
      });

      frameRef.current = requestAnimationFrame(animate);
    };

    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [isPlaying]);

  return (
    <div ref={containerRef} style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 28, padding: "4px 0 0" }}>
      {Array.from({ length: NUM }, (_, i) => (
        <div key={i} className="vu-bar" style={{
          flex: 1,
          height: Math.round(4 + (i / NUM) * 24) + "px",
          background: "rgba(255,255,255,0.07)",
          borderRadius: 2,
        }} />
      ))}
    </div>
  );
});

export default VUMeter;
