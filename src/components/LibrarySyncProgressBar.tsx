import { useState, useEffect } from "react";

// THE canonical restore surface (docs/one-switch-2026-09-09.md §4).
//
// Mounts at App.tsx top-level so it's visible across every panel. Renders null
// when no download is in progress — invisible until the first progress/done
// event arrives, or until a mount-time getDownloadState() catch-up reveals a
// download already in flight (the onboarding hand-off scenario from B.3).
//
// Now driven by catalogue:backup:* rather than library:sync-r2:*. The old path counted the `songs`
// table; the catalogue engine walks the folder, so this bar covers carts, sweepers, spots,
// announcements and voice-tracks too — everything an operator would call "my audio". One engine,
// per Jeff's ruling: "I'm not shipping two engines."
//
// It also carries the PHASE, which the old shape could not express. A restore is rows THEN files,
// and that order was invisible: "Downloading library — 312/483" said nothing about the setup pull
// that had to finish first. The three phases are one sentence each, so the arc reads as one act.
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

type Phase = "idle" | "rows" | "files" | "done";

interface BarState {
  visible:  boolean;
  phase:    Phase;
  done:     number;
  total:    number;
  errors:   number;
  aborted:  boolean;
  finished: boolean; // true after a done event — switches label to "Done"/"Cancelled"
}

const HIDDEN: BarState = {
  visible: false, phase: "idle", done: 0, total: 0, errors: 0, aborted: false, finished: false,
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
    (window as any).ether.catalogueBackup.getDownloadState()
      .then((s: { in_progress: boolean; phase: Phase; done: number; total: number; errors: number }) => {
        if (cancelled) return;
        if (s.in_progress) {
          setBar({
            visible: true,
            phase:   s.phase ?? "files",
            done:    s.done,
            total:   s.total,
            errors:  s.errors,
            aborted: false,
            finished: false,
          });
        }
      })
      .catch((err: any) => console.error('[LibrarySyncProgressBar] getDownloadState failed:', err));

    // PHASE CHANGES ARRIVE SEPARATELY from progress, because the rows phase has no per-file
    // progress to report — it is one database swap. Without this subscription the bar would stay
    // invisible for the whole setup pull and then appear abruptly when the files start, which is
    // the "no way to know which I need" problem in miniature.
    const unsubS = (window as any).ether.catalogueBackup.onDownloadState(
      (s: { in_progress: boolean; phase: Phase; done: number; total: number; errors: number }) => {
        if (cancelled) return;
        if (s.phase === "rows") {
          clearHideTimer();
          setBar({ visible: true, phase: "rows", done: 0, total: 0, errors: 0, aborted: false, finished: false });
        } else if (s.phase === "idle" && !s.in_progress) {
          // A rows-only restore (a snapshot rollback pulls no files) ends here rather than hanging
          // on "bringing your audio down".
          setBar(HIDDEN);
        }
      }
    );

    const unsubP = (window as any).ether.catalogueBackup.onDownloadProgress(
      (e: { done: number; total: number; errors: number; current: string }) => {
        if (cancelled) return;
        clearHideTimer(); // a fresh progress event during fade cancels the hide
        setBar({
          visible: true,
          phase:   "files",
          done:    e.done,
          total:   e.total,
          errors:  e.errors,
          aborted: false,
          finished: false,
        });
      }
    );

    // THE COMPLETION PAYLOAD IS NOT SHAPED LIKE THE PROGRESS PAYLOAD, AND THIS READ THE WRONG ONE.
    //
    // OV, 4.6.27: "Cannot read properties of undefined (reading 'toLocaleString')" — the UI went
    // down on install while audio kept running. onProgress emits { phase, done, total, errors,
    // current } (audio-library-r2.js:352), but the DONE event carries downloadCatalogue's result
    // object, which names the same two numbers `downloaded` and `toDownload` (:315-328). There is no
    // `done` and no `total` on it. So both went undefined, `finished` went true, and the label below
    // called .toLocaleString() on undefined.
    //
    // The annotation is why it survived review: a hand-written type on an IPC boundary asserting a
    // shape nothing ever checked against the producer. tsc typechecks the CLAIM, not the wire.
    // scripts/smoke-ipc-payload-contract.js now checks the wire.
    //
    // Latent since step 5 — a manual download with files in it would have crashed identically. The
    // Phase 0 pull made it routine rather than causing it: the timer fires this event on every tick
    // that actually fetches something, and OV had files waiting after the catalogue move.
    //
    // ?? on every field deliberately. A progress bar must never be able to take the UI down; if a
    // future payload drops a field, the worst outcome allowed is a wrong number.
    const unsubD = (window as any).ether.catalogueBackup.onDownloadDone(
      (e: { downloaded?: number; toDownload?: number; errors?: number; aborted?: boolean; fatal?: string }) => {
        if (cancelled) return;
        setBar({
          visible: true,
          phase:   "done",
          done:    e.downloaded ?? 0,
          total:   e.toDownload ?? 0,
          errors:  e.errors ?? 0,
          aborted: e.aborted ?? false,
          finished: true,
        });
        clearHideTimer();
        const fadeMs = (e.aborted || (e.errors ?? 0) > 0) ? FADE_ERROR_MS : FADE_NORMAL_MS;
        hideTimer = setTimeout(() => {
          if (!cancelled) setBar(HIDDEN);
        }, fadeMs);
      }
    );

    return () => {
      cancelled = true;
      unsubS();
      unsubP();
      unsubD();
      clearHideTimer();
    };
  }, []);

  if (!state.visible) return null;

  const pct = state.total > 0 ? Math.min(100, (state.done / state.total) * 100) : 0;
  const isAlert = state.errors > 0 || state.aborted;

  // ONE ACT, THREE SENTENCES. "audio files", never "songs" — the catalogue holds carts, sweepers,
  // spots, announcements and voice-tracks, and calling that count "songs" is the label defect this
  // work exists to fix (docs/one-switch-2026-09-09.md §5).
  const label = state.finished
    ? (state.aborted
        ? `Stopped — ${state.done.toLocaleString()} of ${state.total.toLocaleString()} audio files arrived`
        : (state.errors > 0
            ? `Everything's here, except ${state.errors} file${state.errors === 1 ? '' : 's'} that wouldn't come down — ${state.done.toLocaleString()} of ${state.total.toLocaleString()} arrived`
            : `Everything's here — ${state.done.toLocaleString()} audio files`))
    : state.phase === "rows"
      ? `Bringing your setup down…`
      : `Bringing your audio down — ${state.done.toLocaleString()} of ${state.total.toLocaleString()} files${state.errors > 0 ? `, ${state.errors} error${state.errors === 1 ? '' : 's'}` : ''}`;

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
        background: "linear-gradient(135deg, rgb(from var(--accent-cyan) r g b / 0.18), rgba(167,139,250,0.18))",
        borderRight: pct > 0 && pct < 100 ? "1px solid rgb(from var(--accent-cyan) r g b / 0.5)" : "none",
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
