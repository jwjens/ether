import { useDestStatus } from "../contexts/StreamStatusContext";

interface Props {
  destId:  string;
  style?:  React.CSSProperties;
}

function Sparkline({ history }: { history: number[] }) {
  if (history.length < 2) return null;
  const W = 120, H = 24;
  const MIN = 0.5, MAX = 1.5;
  const pts = history.map((v, i) => {
    const x = (i / (history.length - 1)) * W;
    const y = H - ((Math.min(Math.max(v, MIN), MAX) - MIN) / (MAX - MIN)) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = history[history.length - 1];
  const color = (last < 0.9 || last > 1.1) ? "#ef4444" : "#22c55e";
  return (
    <svg width={W} height={H} style={{ display: "block" }}>
      <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function fmtUptime(sec: number | null): string {
  if (sec === null) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const STATE_COLORS: Record<string, string> = {
  idle:       "#6b7280",
  connecting: "#f59e0b",
  live:       "#22c55e",
  error:      "#ef4444",
};

const STATE_LABELS: Record<string, string> = {
  idle:       "OFFLINE",
  connecting: "CONNECTING…",
  live:       "LIVE",
  error:      "ERROR",
};

export default function StreamStatusPill({ destId, style }: Props) {
  const status = useDestStatus(destId);
  if (!status || status.state === "idle") return null;

  const color = STATE_COLORS[status.state] ?? "#6b7280";
  const label = STATE_LABELS[status.state] ?? status.state.toUpperCase();

  return (
    <div style={{
      marginTop: 8,
      padding: "8px 10px",
      background: `${color}12`,
      border: `1px solid ${color}40`,
      display: "flex",
      flexDirection: "column",
      gap: 4,
      ...style,
    }}>
      {/* State + dest label + uptime */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0,
          boxShadow: status.state === "live" ? `0 0 6px ${color}` : "none",
        }} />
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", color }}>
          {label}
        </span>
        {status.label && (
          <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginLeft: 2 }}>
            {status.label}
          </span>
        )}
        {status.state === "live" && status.uptimeSec !== null && (
          <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)" }}>
            {fmtUptime(status.uptimeSec)}
          </span>
        )}
      </div>

      {/* Error message */}
      {status.state === "error" && status.errorMsg && (
        <div style={{ fontSize: 10, color: "#f87171", lineHeight: 1.4 }}>
          {status.errorMsg}
        </div>
      )}

      {/* Metrics row (live only) */}
      {status.state === "live" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {status.bitrate !== null && (
            <span style={{ fontSize: 10, color: "var(--text-secondary)", fontFamily: "'DM Mono', monospace" }}>
              {status.bitrate.toFixed(0)} kbps
            </span>
          )}
          {status.speed !== null && (
            <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: status.speed < 0.9 || status.speed > 1.1 ? "#ef4444" : "var(--text-tertiary)" }}>
              {status.speed.toFixed(2)}×
            </span>
          )}
          {status.speedHistory.length >= 2 && (
            <div style={{ marginLeft: "auto" }}>
              <Sparkline history={status.speedHistory} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
