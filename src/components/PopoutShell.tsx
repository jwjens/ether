// PopoutShell.tsx — frameless window wrapper for Tony Stark multi-monitor mode
// Provides a thin drag handle (titlebar) + close button around any panel.

import React from "react";

interface Props {
  title: string;
  children: React.ReactNode;
  /** Extra controls rendered right of the title (inside drag region — no-drag them yourself) */
  headerExtra?: React.ReactNode;
}

export default function PopoutShell({ title, children, headerExtra }: Props) {
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100vh",
      background: "#0e0e14",
      overflow: "hidden",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      {/* ── Drag handle / titlebar ── */}
      <div style={{
        height: 28,
        background: "#08080e",
        borderBottom: "1px solid #181826",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 8px 0 14px",
        flexShrink: 0,
        // Chromium drag region — makes the whole bar draggable
        WebkitAppRegion: "drag",
        userSelect: "none",
      } as React.CSSProperties}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Wordmark */}
          <span style={{
            fontSize: 9, fontWeight: 800, letterSpacing: "0.18em",
            color: "#2a3860", textTransform: "uppercase",
          }}>ETHERCAST</span>
          <span style={{ width: 1, height: 12, background: "#1e1e30" }} />
          <span style={{
            fontSize: 10, fontWeight: 600, letterSpacing: "0.06em",
            color: "#50607a", textTransform: "uppercase",
          }}>{title}</span>
        </div>

        {/* Right side: optional extras + close */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          // Interactive children must opt-out of drag region individually
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties}>
          {headerExtra}
          <PopoutCloseBtn />
        </div>
      </div>

      {/* ── Panel content ── */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </div>
  );
}

// ── Close button ─────────────────────────────────────────────

function PopoutCloseBtn() {
  return (
    <button
      onClick={() => window.close()}
      title="Close panel"
      style={{
        width: 22, height: 22,
        background: "none",
        border: "none",
        color: "#30303e",
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: 0,
        transition: "color 0.12s, background 0.12s",
        fontSize: 12,
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLButtonElement).style.color = "#e04040";
        (e.currentTarget as HTMLButtonElement).style.background = "rgba(224,64,64,0.12)";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.color = "#30303e";
        (e.currentTarget as HTMLButtonElement).style.background = "none";
      }}
    >
      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
      </svg>
    </button>
  );
}

// ── Pop-out trigger button — add to any panel header ─────────
// Usage: <PopoutBtn panel="deck-a" />

export function PopoutBtn({ panel, label }: { panel: string; label?: string }) {
  const launch = () => (window as any).ether.invoke("window:popout", panel);
  return (
    <button
      onClick={launch}
      title={`Pop out ${label ?? panel} to separate window`}
      style={{
        background: "none",
        border: "none",
        color: "#30303e",
        cursor: "pointer",
        padding: "2px 4px",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "color 0.12s",
        borderRadius: 0,
      }}
      onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color = "#5070b0"}
      onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color = "#30303e"}
    >
      {/* External-link / pop-out icon */}
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
    </button>
  );
}
