// The Library window's deck and queue actions — the props the Library pop-out (PopoutRenderer "library") hands
// LibraryPanel. Moved here unchanged from PopoutRenderer's PopoutLibrary so the Library module on a built surface
// calls the SAME actions, not a copy (docs/screen-builder-design-2026-10-18.md §2.8: one path, two doors).
//
// The engine is the one useAudioEngine() resolves: the window's provider, or a ModuleFrame's station scope.
import { useAudioEngine } from "../audio/AudioEngineContext";

export function useLibraryWindowActions() {
  // WAS `getEngine(stationId ?? 1)` — the one place that hand-worked around the missing provider,
  // and it still carried the `?? 1` guess. main.tsx mounts <AudioEngineProvider gate> over every
  // window now, so this reads the live station like the dashboard does, and a window with no
  // provider throws instead of quietly addressing station 1.
  const eng = useAudioEngine();
  const cue = (deck: "A" | "B" | "C", s: any) => {
    try { eng.deckCue?.(deck, { filePath: s.file_path, title: s.title, artist: s.artist_name || "", durationMs: s.duration_ms ?? 0 }); } catch { /* engine not ready */ }
  };
  return {
    onLoadA: (s: any) => cue("A", s),
    onLoadB: (s: any) => cue("B", s),
    onLoadC: (s: any) => cue("C", s),
    onQueue: (s: any) => { try { (eng as any).enqueue?.({ filePath: s.file_path, title: s.title, artist: s.artist_name || "", durationMs: s.duration_ms ?? 0 }); } catch {} },
    // THESE WERE BOTH NO-OPS — controls that rendered and did nothing, in the window that is now
    // the ONLY Library. Send to Studio is genuinely fixable and is fixed: studio:push-track is a
    // real IPC and is exactly what the dashboard calls. Edit is NOT: the cue editor is a dashboard
    // PANEL, not a window, so there is nothing for this renderer to open. Rather than fake it,
    // onEdit is left off, and LibraryPanel now HIDES both cue items when it is absent.
    onSendToStudio: (s: any) => { try { (window as any).ether?.invoke("studio:push-track", { filePath: s.file_path, title: s.title, artist: s.artist_name || "", duration_ms: s.duration_ms }); } catch {} },
  };
}
