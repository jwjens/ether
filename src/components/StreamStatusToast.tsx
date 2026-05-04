import { useEffect, useRef, useState } from "react";
import { useStreamStatus } from "../contexts/StreamStatusContext";

interface Toast {
  id:      number;
  message: string;
  color:   string;
}

let _toastId = 0;

export default function StreamStatusToast() {
  const { dests } = useStreamStatus();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const prevRef = useRef<Record<string, string>>({});

  useEffect(() => {
    for (const [destId, status] of Object.entries(dests)) {
      const prev = prevRef.current[destId];
      if (prev === status.state) continue;
      prevRef.current[destId] = status.state;
      if (!prev) continue; // skip initial load

      let message = "";
      let color   = "#6b7280";

      if (status.state === "live") {
        message = `▶ ${status.label} is now LIVE`;
        color   = "#22c55e";
      } else if (status.state === "error") {
        message = `✕ ${status.label}: ${status.errorMsg ?? "stream error"}`;
        color   = "#ef4444";
      } else if (status.state === "idle" && prev === "live") {
        message = `■ ${status.label} stream stopped`;
        color   = "#f59e0b";
      } else if (status.state === "connecting") {
        message = `⟳ ${status.label} connecting…`;
        color   = "#f59e0b";
      }

      if (!message) continue;

      const id = ++_toastId;
      setToasts(t => [...t, { id, message, color }]);
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500);
    }
  }, [dests]);

  if (toasts.length === 0) return null;

  return (
    <div style={{
      position: "fixed", bottom: 20, right: 20, zIndex: 9999,
      display: "flex", flexDirection: "column", gap: 8,
      pointerEvents: "none",
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          padding: "10px 14px",
          background: "var(--bg-secondary)",
          border: `1px solid ${t.color}60`,
          boxShadow: `0 4px 20px rgba(0,0,0,0.5), 0 0 0 1px ${t.color}20`,
          color: t.color,
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.04em",
          maxWidth: 320,
          animation: "ether-toast-in 0.2s ease both",
        }}>
          {t.message}
        </div>
      ))}
      <style>{`
        @keyframes ether-toast-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0);   }
        }
      `}</style>
    </div>
  );
}
