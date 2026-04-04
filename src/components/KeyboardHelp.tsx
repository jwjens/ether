import { useState, useEffect } from "react";

export default function KeyboardHelp() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === "Slash" && e.shiftKey) {
        setShow(prev => !prev);
      }
      if (e.code === "Escape") setShow(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!show) return (
    <button onClick={() => setShow(true)}
      style={{ position: "fixed", bottom: 12, right: 12, padding: "4px 10px", borderRadius: 0,
        fontSize: 10, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-tertiary)",
        border: "1px solid var(--border-primary)", cursor: "pointer", zIndex: 100, opacity: 0.5 }}
      title="Keyboard shortcuts (?)">
      ⌨ ?
    </button>
  );

  const shortcuts = [
    { key: "Space", action: "Play / Pause Deck A" },
    { key: "B", action: "Play / Pause Deck B" },
    { key: "X", action: "Crossfade A ↔ B" },
    { key: "A", action: "Toggle AUTO mode" },
    { key: "Esc", action: "Stop all decks" },
    { key: "N / F1", action: "Go to Live Assist" },
    { key: "L / F2", action: "Go to Library" },
    { key: "S / F3", action: "Go to Scheduler" },
    { key: "G / F4", action: "Go to Logs" },
    { key: "F10", action: "Go to Settings" },
    { key: "? or F12", action: "Toggle this help" },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9998,
      display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => setShow(false)}>
      <div style={{ background: "var(--bg-secondary)", borderRadius: 0, padding: 28, minWidth: 340,
        border: "1px solid var(--border-primary)", boxShadow: "0 24px 60px rgba(0,0,0,0.5)" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", marginBottom: 16 }}>
          ⌨ Keyboard Shortcuts
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {shortcuts.map(s => (
            <div key={s.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
              <kbd style={{ padding: "2px 8px", borderRadius: 0, fontSize: 11, fontFamily: "monospace",
                fontWeight: 700, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
                color: "var(--text-primary)", whiteSpace: "nowrap" }}>{s.key}</kbd>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{s.action}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16, fontSize: 11, color: "var(--text-tertiary)", textAlign: "center" }}>
          Press Esc or click outside to close
        </div>
      </div>
    </div>
  );
}
