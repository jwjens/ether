// ── Daemon version mismatch — say it, don't just log it (2026-08-10) ─────────────────────────────
//
// The audio daemon does NOT reload on auto-update (CLAUDE.md), so the app can end up talking to a
// daemon built before a field or command existed. The app has always DETECTED this
// ("stale-check: daemon vX != app vY") and told only the log, so on screen it degraded into a
// silently wrong UI instead of an honest one. On 2026-08-03 the stale-daemon hypothesis burned a
// full diagnostic round and could be neither confirmed nor ruled out from the screen.
//
// NOT DISMISSIBLE, deliberately. It is not a notification, it is a statement about whether what you
// are looking at can be trusted, and it clears itself the moment the daemon matches. A dismiss
// button would let the operator hide a condition that is still true — the same mistake as logging it.
//
// backlog 2026-08-03 "VERSION-MISMATCH GUARD"
import { useEffect, useState } from "react";

export interface DaemonVersionState {
  stale: boolean;
  /** "mismatch" — versions known and different · "unknown" — daemon predates the version command. */
  reason: "mismatch" | "unknown" | null;
  daemonVersion: string | null;
  appVersion: string | null;
}

const IDLE: DaemonVersionState = { stale: false, reason: null, daemonVersion: null, appVersion: null };

/**
 * The running daemon's version state.
 *
 * Any UI whose data depends on a field the running daemon may not supply should consult this and
 * render UNKNOWN rather than a confident default — a plausible-looking number from a daemon that
 * cannot produce it is worse than an admitted gap, because it cannot be questioned.
 */
export function useDaemonVersion(): DaemonVersionState {
  const [state, setState] = useState<DaemonVersionState>(IDLE);

  useEffect(() => {
    const ether = (window as any).ether;
    let alive = true;
    // Ask on mount: a window opened after the check ran would otherwise show nothing, which is
    // exactly where a mismatch is hardest to notice.
    ether?.invoke?.("daemon:version-state")
      .then((s: DaemonVersionState) => { if (alive && s) setState(s); })
      .catch(() => {});
    const h = ether?.on?.("audio:daemon-version", (s: DaemonVersionState) => { if (alive && s) setState(s); });
    return () => { alive = false; try { ether?.off?.("audio:daemon-version", h); } catch {} };
  }, []);

  return state;
}

export default function DaemonVersionBanner() {
  const v = useDaemonVersion();
  if (!v.stale) return null;

  // "unknown" is reported as unknown. The daemon predating the version command is precisely the case
  // where its build CANNOT be determined, and printing a guess would be the defect this fixes.
  const which = v.reason === "unknown"
    ? "an older build (version unknown — it predates the version check)"
    : `an older build (engine v${v.daemonVersion ?? "unknown"}, app v${v.appVersion ?? "unknown"})`;

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 10000,
      background: "rgba(251,191,36,0.14)", borderBottom: "1px solid var(--accent-amber)",
      color: "var(--accent-amber)", padding: "8px 16px",
      fontSize: 13, fontWeight: 600, fontFamily: "'Inter', system-ui, sans-serif",
      display: "flex", alignItems: "center", justifyContent: "center", gap: 8, textAlign: "center",
    }}>
      <span>⚠</span>
      <span>
        The audio engine is running {which} — <strong>fully close and reopen Ether</strong>.
        Until then some readings may be missing or out of date.
      </span>
    </div>
  );
}
