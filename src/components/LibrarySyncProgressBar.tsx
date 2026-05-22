import { useState, useEffect } from "react";

// Persistent bottom-of-UI progress bar for library:sync-r2:download (Phase B.4).
// Mounts at App.tsx top-level so it's visible across every panel. Renders null
// when no download is in progress — invisible until the first progress/done
// event arrives, or until a mount-time getDownloadState() catch-up reveals a
// download already in flight (the onboarding hand-off scenario from B.3).
//
// Auto-hide: 3s after a clean done event, 6s after errors or cancel. A new
// progress event during the fade cancels the timer and switches back to the
// in-progress label.
//
// Byte counts are intentionally omitted — the B.2 progress payload carries
// file counts only. Adding bytes is a clean follow-up if needed (extend the
// progress event with bytesDone/bytesTotal and the label).

const FADE_NORMAL_MS = 3000;
const FADE_ERROR_MS  = 6000;

interface BarState {
  visible:  boolean;
  done:     number;
  total:    number;
  errors:   number;
  aborted:  boolean;
  finished: boolean; // true after a done event — switches label to "Done"/"Cancelled"
}

const HIDDEN: BarState = {
  visible: false, done: 0, total: 0, errors: 0, aborted: false, finished: false,
};

export default function LibrarySyncProgressBar() {
  const [state, setBar] = useState<BarState>(HIDDEN);

  useEffect(() => {
    let cancelled = false;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const clearHideTimer = () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    };

    // Mount-time catch-up — if a download is already in flight (typical when
    // arriving from onboarding's "From the cloud" path), the snapshot from
    // main process tells us the current counts before any progress event fires.
    (window as any).ether.libraryR2.getDownloadState()
      .then((s: { in_progress: boolean; done: number; total: number; errors: number }) => {
        if (cancelled) return;
        if (s.in_progress) {
          setBar({
            visible: true,
            done:    s.done,
            total:   s.total,
            errors:  s.errors,
            aborted: false,
            finished: false,
          });
        }
      })
      .catch((err: any) => console.error('[LibrarySyncProgressBar] getDownloadState failed:', err));

    const unsubP = (window as any).ether.libraryR2.onDownloadProgress(
      (e: { done: number; total: number; errors: number; current: string }) => {
        if (cancelled) return;
        clearHideTimer(); // a fresh progress event during fade cancels the hide
        setBar({
          visible: true,
          done:    e.done,
          total:   e.total,
          errors:  e.errors,
          aborted: false,
          finished: false,
        });
      }
    );

    const unsubD = (window as any).ether.libraryR2.onDownloadDone(
      (e: { done: number; total: number; errors: number; aborted: boolean }) => {
        if (cancelled) return;
        setBar({
          visible: true,
          done:    e.done,
          total:   e.total,
          errors:  e.errors,
          aborted: e.aborted,
          finished: true,
        });
        clearHideTimer();
        const fadeMs = (e.aborted || e.errors > 0) ? FADE_ERROR_MS : FADE_NORMAL_MS;
        hideTimer = setTimeout(() => {
          if (!cancelled) setBar(HIDDEN);
        }, fadeMs);
      }
    );

    return () => {
      cancelled = true;
      unsubP();
      unsubD();
      clearHideTimer();
    };
  }, []);

  if (!state.visible) return null;

  const pct = state.total > 0 ? Math.min(100, (state.done / state.total) * 100) : 0;
  const isAlert = state.errors > 0 || state.aborted;

  const label = state.finished
    ? (state.aborted
        ? `Cancelled — ${state.done.toLocaleString()} / ${state.total.toLocaleString()} files`
        : (state.errors > 0
            ? `Done — ${state.done.toLocaleString()} / ${state.total.toLocaleString()} files, ${state.errors} error${state.errors === 1 ? '' : 's'}`
            : `Done — ${state.done.toLocaleString()} files synced`))
    : `Downloading library — ${state.done.toLocaleString()} / ${state.total.toLocaleString()} audio files${state.errors > 0 ? `, ${state.errors} error${state.errors === 1 ? '' : 's'}` : ''}`;

  return (
    <div style={{
      position: "fixed",
      bottom: 52, left: 0, right: 0,
      height: 36,
      zIndex: 250,
      background: "var(--bg-secondary)",
      borderTop: "1px solid var(--border-primary)",
      display: "flex", alignItems: "center",
      fontFamily: "'Inter', system-ui, sans-serif",
      overflow: "hidden",
    }}>
      {/* Progress fill — sits behind the label */}
      <div style={{
        position: "absolute",
        left: 0, top: 0, bottom: 0,
        width: `${pct}%`,
        background: "linear-gradient(135deg, rgba(34,211,238,0.18), rgba(167,139,250,0.18))",
        borderRight: pct > 0 && pct < 100 ? "1px solid rgba(34,211,238,0.5)" : "none",
        transition: "width 0.15s ease",
      }} />
      {/* Label — right-aligned over the fill */}
      <div style={{
        position: "relative",
        zIndex: 1,
        marginLeft: "auto", marginRight: 16,
        fontSize: 13, fontWeight: 600,
        color: isAlert ? "#fca5a5" : "var(--text-secondary)",
        letterSpacing: "0.01em",
      }}>
        {label}
      </div>
    </div>
  );
}
