import { useStreamStatus } from "../contexts/StreamStatusContext";

interface Props {
  onGoLive:   () => void;
  onStopLive: () => void;
  style?:     React.CSSProperties;
}

// The On-Air badge reflects the REAL Icecast stream status only — never playback — so
// the light never lies: OFF AIR (idle) → GOING LIVE… (connecting) → ON AIR (streaming).
// Clicking it starts or stops the actual stream.
export default function GlobalOnAirBadge({ onGoLive, onStopLive, style }: Props) {
  const { dests, global } = useStreamStatus();
  const live = global.anyLive;
  const connecting = !live && Object.values(dests).some((d) => d.state === "connecting");
  const active = live || connecting;

  const label = connecting
    ? "GOING LIVE…"
    : live
      ? `ON AIR${global.liveCount > 1 ? ` (${global.liveCount})` : ""}`
      : "OFF AIR";

  const bg      = live ? "#ef4444" : connecting ? "rgba(245,158,11,0.18)" : "var(--bg-tertiary)";
  const color   = live ? "#fff"    : connecting ? "#fbbf24"               : "var(--text-primary)";
  const shadow  = live ? "0 0 16px rgba(239,68,68,0.5)" : connecting ? "0 0 10px rgba(245,158,11,0.35)" : "none";
  const outline = connecting ? "1px solid rgba(245,158,11,0.45)" : "none";

  return (
    <button
      data-tour="onair-btn"
      onClick={() => (active ? onStopLive() : onGoLive())}
      title={active ? "Click to stop broadcasting" : "Click to go on air (start streaming)"}
      style={{
        height: 48, padding: "0 24px", borderRadius: 0, border: "none", cursor: "pointer",
        fontSize: 15, fontWeight: 800, letterSpacing: "0.1em",
        background: bg, color, boxShadow: shadow, outline,
        transition: "all 0.2s",
        display: "flex", alignItems: "center", gap: 8,
        ...style,
      }}
    >
      {active ? "● " : ""}{label}
    </button>
  );
}
