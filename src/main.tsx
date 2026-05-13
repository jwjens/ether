import React, { Component, ReactNode } from "react";
import * as Sentry from "@sentry/electron/renderer";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  enabled: !import.meta.env.DEV,
  release: "ether@" + (import.meta.env.VITE_APP_VERSION ?? "1.0.0"),
  tracesSampleRate: 0.1,
});
import ReactDOM from "react-dom/client";
import App from "./App";
import NowPlaying from "./components/NowPlaying";
import ProducerDeskWindow from "./components/ProducerDeskWindow";
import CueEditorWindow from "./components/CueEditorWindow";
import PopoutRenderer from "./components/PopoutRenderer";
import "./index.css";
import { runMigrations } from "./db/client";

// ── Root error boundary — catches crashes before EtherErrorBoundary mounts ──
class RootBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      const err = this.state.error;
      return (
        <div style={{
          position: "fixed", inset: 0, background: "#080810",
          display: "flex", flexDirection: "column" as const, alignItems: "center",
          justifyContent: "center", fontFamily: "monospace", color: "#e0e0f0",
          gap: 16, padding: 32,
        }}>
          <div style={{ fontSize: 18, color: "#f87171", fontWeight: 700 }}>Ether — startup error</div>
          <div style={{
            background: "#111118", border: "1px solid #2a2a3a", padding: "12px 16px",
            maxWidth: 700, width: "100%",
          }}>
            <div style={{ color: "#f87171", fontSize: 13, marginBottom: 8 }}>{err.message}</div>
            <pre style={{
              fontSize: 10, color: "#606070", overflow: "auto",
              maxHeight: 300, margin: 0, whiteSpace: "pre-wrap" as const,
            }}>{err.stack}</pre>
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 24px", background: "#6040c0", border: "none",
              color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 700,
            }}
          >Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

async function boot() {
  const hash = window.location.hash;
  const isNowPlaying  = hash === "#nowplaying";
  const isDesk        = hash === "#desk";
  const isCueEditor   = hash.startsWith("#cueeditor");
  const isPopout      = hash.startsWith("#popout/");
  const popoutPanel   = isPopout ? hash.slice("#popout/".length) : "";

  // Pop-outs need migrations for DB-backed features (EQ, etc.)
  if (!isNowPlaying && !isDesk && !isCueEditor) {
    await runMigrations();
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <RootBoundary>
      {isNowPlaying  ? <NowPlaying /> :
       isDesk        ? <ProducerDeskWindow /> :
       isCueEditor   ? <CueEditorWindow /> :
       isPopout      ? <PopoutRenderer panel={popoutPanel} /> :
       <App />}
    </RootBoundary>
  );
}

boot();
