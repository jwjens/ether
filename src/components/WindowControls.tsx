// macOS-style traffic lights — top-right, on every window the app opens.
//
//   🔴 RED    close the window          → BrowserWindow.close()
//   🟡 YELLOW minimize to the taskbar   → BrowserWindow.minimize()   (restore from the taskbar)
//   🟢 GREEN  toggle fullscreen ↔ windowed → BrowserWindow.setFullScreen(!isFullScreen())
//
// The main-process handlers act on the SENDER's window (electron/main.js, `win:*`), so this one
// component works unmodified in the main window and in every pop-out — it never needs to know which
// window it is rendered in.
//
// The green button's state is OBSERVED, not assumed: toggleFullscreen returns the resulting boolean
// and the component stores that, and it re-reads on focus. A control that tracked its own last click
// would drift the moment the window was fullscreened by any other route (F11, the native chrome, the
// OS) — the same "control reads its own memory" defect that made the AUTO pill and the JINGLES ON
// button lie.

import { useState, useEffect, useCallback } from "react";

const w = () => (window as any).ether?.win;

export default function WindowControls({ style }: { style?: React.CSSProperties }) {
  const [isFull, setIsFull] = useState(false);
  const [hover, setHover] = useState(false);

  const readState = useCallback(async () => {
    try { setIsFull(!!(await w()?.isFullscreen?.())); } catch { /* no host — leave as-is */ }
  }, []);

  useEffect(() => {
    void readState();
    // Re-read whenever this window regains focus: fullscreen can be changed by F11, the native
    // titlebar, or the OS, and the button must report the window's real state.
    const onFocus = () => { void readState(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [readState]);

  // No host (browser dev, or preload missing) → render nothing rather than dead buttons.
  if (!w()) return null;

  const dot = (color: string, title: string, onClick: () => void, glyph: string) => (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: 13, height: 13, borderRadius: "50%", border: "none", padding: 0,
        background: color, cursor: "pointer", display: "flex",
        alignItems: "center", justifyContent: "center",
        fontSize: 9, lineHeight: 1, fontWeight: 900,
        color: "rgba(0,0,0,0.55)",
        // Glyphs only on hover — the same affordance macOS uses; colour alone carries it otherwise.
        opacity: 1,
      }}
    >
      <span style={{ opacity: hover ? 1 : 0, transition: "opacity .12s", pointerEvents: "none" }}>{glyph}</span>
    </button>
  );

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "fixed", top: 6, right: 8, zIndex: 100000,
        display: "flex", gap: 8, alignItems: "center",
        // Stay clickable inside any draggable titlebar region. Not in React's CSS types, hence the cast.
        ...({ WebkitAppRegion: "no-drag" } as React.CSSProperties),
        ...style,
      }}
    >
      {dot("#febc2e", "Minimize to taskbar", () => { void w()?.minimize?.(); }, "–")}
      {dot("#28c840", isFull ? "Exit fullscreen" : "Fullscreen", async () => {
        try { setIsFull(!!(await w()?.toggleFullscreen?.())); } catch { /* ignore */ }
      }, isFull ? "⤡" : "⤢")}
      {dot("#ff5f57", "Close window", () => { void w()?.close?.(); }, "✕")}
    </div>
  );
}
