import { useState, useEffect, useCallback, useRef } from "react";

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
  | { phase: "downloading"; progress: number; total: number; downloaded: number; version?: string }
  | { phase: "ready"; version?: string }
  | { phase: "error"; message: string; version?: string };

/** The version this update window is about, in whichever phase it is in. */
const versionOf = (s: UpdateState): string | null =>
  s.phase === "available" ? s.info.version : s.phase === "idle" ? null : s.version ?? null;

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

  // Track the current phase in a ref so the polling interval reads it without
  // re-subscribing every render.
  const phaseRef = useRef(state.phase);
  useEffect(() => { phaseRef.current = state.phase; }, [state.phase]);

  // Check on startup (10s delay so boot isn't slowed) AND every 30 min while the
  // app is running — so an update published mid-session surfaces LIVE in the banner
  // without needing a restart. Only re-check while idle, so an in-progress download
  // or an already-shown banner is never clobbered (a dismissed banner leaves the
  // phase non-idle, so the operator isn't re-nagged within the session).
  useEffect(() => {
    const startup = setTimeout(checkForUpdate, 10_000);
    const poll = setInterval(() => {
      if (phaseRef.current === "idle") checkForUpdate();
    }, 30 * 60 * 1000);
    return () => { clearTimeout(startup); clearInterval(poll); };
  }, [checkForUpdate]);

  const versionRef = useRef<string | undefined>(undefined);
  useEffect(() => { if (state.phase === "available") versionRef.current = state.info.version; }, [state]);

  const download = useCallback(async () => {
    const version = versionRef.current;
    try {
      setState({ phase: "downloading", progress: 0, total: 0, downloaded: 0, version });
      // Listen for progress events from main process
      const handler = (window as any).ether.on("updater:progress", (data: any) => {
        if (data.percent !== undefined) {
          setState({ phase: "downloading", progress: Math.round(data.percent), total: data.total ?? 0, downloaded: data.transferred ?? 0, version });
        }
      });
      await downloadUpdate();
      (window as any).ether.off("updater:progress", handler);
      setState({ phase: "ready", version });
    } catch (e) {
      setState({ phase: "error", message: String(e), version });
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
  const [details, setDetails] = useState(false);
  if (state.phase === "idle") return null;
  const version = versionOf(state);
  // Details opens the release notes beside the update; it never stands between the operator and Update / Restart.
  const detailsBtn = version ? (
    <button onClick={() => setDetails(true)} style={{
      padding: "9px 14px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
      color: "var(--text-secondary)", fontSize: 12, cursor: "pointer",
    }}>Details</button>
  ) : null;

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
              {detailsBtn}
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
          {detailsBtn && <div style={{ marginTop: 10 }}>{detailsBtn}</div>}
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
          <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onRestart}
            style={{
              flex: 1, padding: "9px 0", borderRadius: 0,
              background: "var(--accent-green)", border: "none",
              color: "#000", fontSize: 12, fontWeight: 700,
              cursor: "pointer", letterSpacing: "0.02em",
            }}
          >
            Restart & Update
          </button>
          {detailsBtn}
          </div>
        </div>
      )}

      {/* Error */}
      {state.phase === "error" && (
        <div style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent-red)", marginBottom: 6 }}>Update failed</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 10, lineHeight: 1.5 }}>{state.message}</div>
          <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onDismiss} style={{ padding: "7px 14px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer" }}>
            Dismiss
          </button>
          {detailsBtn}
          </div>
        </div>
      )}
      {details && version && <ReleaseNotesPopup version={version} onClose={() => setDetails(false)} />}
    </div>
  );
}

type NotesAnswer =
  | { ok: true; from: string; to: string; releases: { version: string; name: string; date: string | null; body: string }[]; missing: string[] }
  | { ok: false; error: string };

// ── Details: what was added and fixed, every version from this one up to the update, newest first ──
// Asked only when Details is clicked (main: updater:release-notes → electron/release-notes.js); a failure is said here
// and never touches the update.
export function ReleaseNotesPopup({ version, onClose }: { version: string; onClose: () => void }) {
  const [answer, setAnswer] = useState<NotesAnswer | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve((window as any).ether.invoke("updater:release-notes", version))
      .then((a: NotesAnswer) => { if (live) setAnswer(a && typeof a === "object" ? a : { ok: false, error: "no answer" }); })
      .catch((e: unknown) => { if (live) setAnswer({ ok: false, error: String(e) }); });
    return () => { live = false; };
  }, [version]);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div role="dialog" aria-label={`What's in Ether ${version}`} onClick={e => e.stopPropagation()} style={{
        width: 560, maxWidth: "calc(100vw - 32px)", maxHeight: "80vh", display: "flex", flexDirection: "column",
        background: "var(--bg-secondary)", border: "1px solid var(--border-secondary)", boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
      }}>
        <div style={{ display: "flex", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid var(--border-primary)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
            What's in Ether {version}{answer?.ok && answer.releases.length > 1 ? ` (everything since ${answer.from})` : ""}
          </div>
          <button onClick={onClose} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 16 }}>×</button>
        </div>
        <div style={{ padding: "12px 16px", overflowY: "auto", fontSize: 12, lineHeight: 1.55, color: "var(--text-secondary)" }}>
          {!answer && <div>Loading the release notes…</div>}
          {answer && !answer.ok && (
            <div style={{ color: "var(--accent-red)" }}>
              The release notes could not be loaded ({answer.error}). The update itself is not affected.
            </div>
          )}
          {answer?.ok && answer.missing.length > 0 && (
            <div style={{ color: "var(--accent-red)", marginBottom: 10 }}>No release notes were found for Ether {answer.missing.join(", ")}.</div>
          )}
          {answer?.ok && answer.releases.map(r => (
            <div key={r.version} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
                {r.name}{r.date ? <span style={{ fontWeight: 400, color: "var(--text-tertiary)", fontSize: 11 }}> · {new Date(r.date).toLocaleDateString()}</span> : null}
              </div>
              <NotesBody text={r.body} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Release notes are Markdown; shown as plain text with headings bold and list items as bullets. */
function NotesBody({ text }: { text: string }) {
  if (!text) return <div style={{ color: "var(--text-tertiary)" }}>This release has no notes.</div>;
  const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return (
    <div style={{ marginTop: 4 }}>
      {text.split(/\r?\n/).map((line, i) => {
        const h = line.match(/^#{1,6}\s+(.*)$/);
        if (h) return <div key={i} style={{ fontWeight: 700, color: "var(--text-primary)", marginTop: 8 }}>{plain(h[1])}</div>;
        const li = line.match(/^\s*[-*]\s+(.*)$/);
        if (li) return <div key={i} style={{ paddingLeft: 14, textIndent: -10 }}>• {plain(li[1])}</div>;
        return line.trim() ? <div key={i}>{plain(line)}</div> : <div key={i} style={{ height: 6 }} />;
      })}
    </div>
  );
}
