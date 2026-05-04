import { useGlobalStatus } from "../contexts/StreamStatusContext";

interface Props {
  onAir:     boolean;
  onClick:   () => void;
  style?:    React.CSSProperties;
}

export default function GlobalOnAirBadge({ onAir, onClick, style }: Props) {
  const { anyLive, liveCount } = useGlobalStatus();
  const streaming = anyLive;

  // Color logic: red if mic on-air, green if streaming but not on-air, gray otherwise
  const bg     = onAir   ? "#ef4444"
               : streaming ? "rgba(34,197,94,0.15)"
               : "var(--bg-tertiary)";
  const color  = onAir   ? "#fff"
               : streaming ? "#4ade80"
               : "var(--text-tertiary)";
  const shadow = onAir   ? "0 0 16px rgba(239,68,68,0.5)"
               : streaming ? "0 0 8px rgba(34,197,94,0.25)"
               : "none";
  const outline = streaming && !onAir ? "1px solid rgba(34,197,94,0.4)" : "none";

  return (
    <button
      data-tour="onair-btn"
      onClick={onClick}
      style={{
        height: 48, padding: "0 24px", borderRadius: 0, border: "none", cursor: "pointer",
        fontSize: 15, fontWeight: 800, letterSpacing: "0.1em",
        background: bg, color, boxShadow: shadow, outline,
        transition: "all 0.2s",
        display: "flex", alignItems: "center", gap: 8,
        ...style,
      }}
    >
      {onAir || streaming ? "● " : ""}
      {onAir ? "ON AIR" : streaming ? `LIVE (${liveCount})` : "OFF AIR"}
    </button>
  );
}
