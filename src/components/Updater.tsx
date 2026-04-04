import { useState, useEffect, useCallback } from "react";

const relaunch = () => (window as any).ether.invoke("relaunch");
const checkForUpdates = () => (window as any).ether.invoke("updater:check");
const downloadUpdate = () => (window as any).ether.invoke("updater:download");
const quitAndInstall = () => (window as any).ether.invoke("updater:install");

interface UpdateInfo {
  version: string;
  notes: string | null;
  date: string | null;
}

type UpdateState =
  | { phase: "idle" }
  | { phase: "available"; info: UpdateInfo }
  | { phase: "downloading"; progress: number; total: number; downloaded: number }
  | { phase: "ready" }
  | { phase: "error"; message: string };

// ── Hook ──────────────────────────────────────────────────────
export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ phase: "idle" });
  const [dismissed, setDismissed] = useState(false);

  const checkForUpdate = useCallback(async () => {
    try {
      const result = await checkForUpdates();
      if (result?.available) {
        setState({
          phase: "available",
          info: {
            version: result.version,
            notes: result.notes ?? null,
            date: result.date ?? null,
          },
        });
      }
    } catch {
      // Silently fail
    }
  }, []);

  // Check on startup after 10s delay (don't slow down boot)
  useEffect(() => {
    const t = setTimeout(checkForUpdate, 10_000);
    return () => clearTimeout(t);
  }, [checkForUpdate]);

  const download = useCallback(async () => {
    try {
      setState({ phase: "downloading", progress: 0, total: 0, downloaded: 0 });
      // Listen for progress events from main process
      const handler = (window as any).ether.on("updater:progress", (data: any) => {
        if (data.percent !== undefined) {
          setState({ phase: "downloading", progress: Math.round(data.percent), total: data.total ?? 0, downloaded: data.transferred ?? 0 });
        }
      });
      await downloadUpdate();
      (window as any).ether.off("updater:progress", handler);
      setState({ phase: "ready" });
    } catch (e) {
      setState({ phase: "error", message: String(e) });
    }
  }, []);

  const restart = useCallback(async () => {
    await quitAndInstall();
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  return { state, dismissed, checkForUpdate, download, restart, dismiss };
}

// ── Update Banner (compact, shown in header area) ─────────────
export function UpdateBanner({
  state,
  onDownload,
  onRestart,
  onDismiss,
}: {
  state: UpdateState;
  onDownload: () => void;
  onRestart: () => void;
  onDismiss: () => void;
}) {
  if (state.phase === "idle") return null;

  const fmt = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  };

  return (
    <div style={{
      position: "fixed" as const,
      bottom: 32, right: 24,
      zIndex: 9999,
      width: 340,
      background: "var(--bg-secondary)",
      border: "1px solid var(--border-secondary)",
      borderRadius: 0,
      boxShadow: "0 8px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04)",
      overflow: "hidden",
      fontFamily: "'Inter', system-ui, sans-serif",
      animation: "deck-slide-in 0.3s cubic-bezier(0.34,1.56,0.64,1) both",
    }}>

      {/* Available */}
      {state.phase === "available" && (
        <>
          <div style={{ padding: "14px 16px 12px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 28, height: 28, borderRadius: 0, background: "linear-gradient(135deg, var(--accent-cyan), var(--accent-purple))", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>
                    Ether {state.info.version} is ready
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 1 }}>
                    A new version is available
                  </div>
                </div>
              </div>
              <button onClick={onDismiss} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}>×</button>
            </div>

            {/* Changelog notes */}
            {state.info.notes && (
              <div style={{
                fontSize: 11, color: "var(--text-secondary)",
                background: "var(--bg-tertiary)", borderRadius: 0,
                padding: "8px 10px", marginBottom: 10,
                maxHeight: 80, overflowY: "auto" as const,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap" as const,
              }}>
                {state.info.notes.slice(0, 300)}{state.info.notes.length > 300 ? "…" : ""}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={onDownload}
                style={{
                  flex: 1, padding: "9px 0", borderRadius: 0,
                  background: "var(--accent-cyan)", border: "none",
                  color: "#000", fontSize: 12, fontWeight: 700,
                  cursor: "pointer", letterSpacing: "0.02em",
                }}
              >
                Update Now
              </button>
              <button
                onClick={onDismiss}
                style={{
                  padding: "9px 14px", borderRadius: 0,
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
                  color: "var(--text-secondary)", fontSize: 12, cursor: "pointer",
                }}
              >
                Later
              </button>
            </div>
          </div>
        </>
      )}

      {/* Downloading */}
      {state.phase === "downloading" && (
        <div style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-cyan)", animation: "onair-pulse 1s ease-in-out infinite" }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>Downloading update…</span>
            <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>
              {state.progress}%
            </span>
          </div>
          <div style={{ height: 4, background: "var(--bg-tertiary)", borderRadius: 0, overflow: "hidden", marginBottom: 6 }}>
            <div style={{
              height: "100%", borderRadius: 0,
              background: "linear-gradient(90deg, var(--accent-cyan), var(--accent-purple))",
              width: state.progress + "%",
              transition: "width 0.3s ease",
            }} />
          </div>
          {state.total > 0 && (
            <div style={{ fontSize: 9, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>
              {fmt(state.downloaded)} / {fmt(state.total)}
            </div>
          )}
        </div>
      )}

      {/* Ready to restart */}
      {state.phase === "ready" && (
        <div style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <div style={{ width: 20, height: 20, borderRadius: "50%", background: "rgba(52,211,153,0.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>Update downloaded</div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 1 }}>Restart Ether to apply the update</div>
            </div>
          </div>
          <button
            onClick={onRestart}
            style={{
              width: "100%", padding: "9px 0", borderRadius: 0,
              background: "var(--accent-green)", border: "none",
              color: "#000", fontSize: 12, fontWeight: 700,
              cursor: "pointer", letterSpacing: "0.02em",
            }}
          >
            Restart & Update
          </button>
        </div>
      )}

      {/* Error */}
      {state.phase === "error" && (
        <div style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent-red)", marginBottom: 6 }}>Update failed</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 10, lineHeight: 1.5 }}>{state.message}</div>
          <button onClick={onDismiss} style={{ padding: "7px 14px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer" }}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
