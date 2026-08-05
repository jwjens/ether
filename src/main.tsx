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
              padding: "8px 24px", background: "var(--accent-blue)", border: "none",
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

  // Report real startup steps to the native splash (main window only).
  const reportSplash = (msg: string) => { try { (window as any).ether?.invoke?.("splash:status", msg); } catch { /* not in electron */ } };

  // Pop-outs need migrations for DB-backed features (EQ, etc.)
  if (!isNowPlaying && !isDesk && !isCueEditor) {
    if (!isPopout) reportSplash("Preparing database…");
    await runMigrations();
    if (!isPopout) reportSplash("Database ready");
  }

  // Dev console helpers + debug panel/banner mount. Available in the dev server, or
  // in any build on the owner install (license_key === ETHER-OWNER-2026). Loaded via
  // dynamic import so the modules are a lazy chunk that never ships in the initial
  // bundle — and stays unreachable for customers. See lib/devAccess.ts.
  const isMainApp = !isPopout && !isNowPlaying && !isDesk && !isCueEditor;
  let DebugMount: React.ComponentType | null = null;
  let DevTierBanner: React.ComponentType | null = null;
  const { isDevToolsEnabled } = await import("./lib/devAccess");
  if (isMainApp && await isDevToolsEnabled()) {
    const { initDevGlobals } = await import("./lib/devGlobals");
    initDevGlobals();
    const debugMod = await import("./components/DebugPanel");
    DebugMount = debugMod.DebugMount;
    DevTierBanner = debugMod.DevTierBanner;
  }

  const mainContent = isNowPlaying  ? <NowPlaying /> :
                      isDesk        ? <ProducerDeskWindow /> :
                      isCueEditor   ? <CueEditorWindow /> :
                      isPopout      ? <PopoutRenderer panel={popoutPanel} /> :
                      <App />;

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <RootBoundary>
      {DevTierBanner && <DevTierBanner />}
      {mainContent}
      {DebugMount && <DebugMount />}
    </RootBoundary>
  );
}

boot();
