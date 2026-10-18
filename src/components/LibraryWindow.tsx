// THE LIBRARY WINDOW — what ☰ → Library opens (PopoutRenderer "library") and what the Song Library module on a built
// surface renders (src/modules/registry.ts). Moved here from PopoutRenderer's PopoutLibrary.
//
// It is the app's own LibraryPanel with the Library's one set of actions (src/lib/libraryDeckActions.tsx) — the same
// load, refusal and enqueue the main window's Library uses — and the same notice the main window shows. onEdit is left
// off: the cue editor is a dashboard PANEL, not a window, so there is nothing for this renderer to open, and
// LibraryPanel hides both cue items when it is absent.
import { useMemo, useRef, useState } from "react";
import { LibraryPanel } from "../App";
import { useAudioEngine } from "../audio/AudioEngineContext";
import { libraryDeckActions, autoSilenceTrimOn, DeckLoadNoticeBar, type DeckLoadNotice } from "../lib/libraryDeckActions";

export default function LibraryWindow() {
  // The window's provider, or a ModuleFrame's station scope. Read through a ref so every press resolves the engine
  // of the station this window belongs to NOW, not the one it had when the actions were built.
  const eng = useAudioEngine();
  const engRef = useRef(eng);
  engRef.current = eng;
  const [notice, setNotice] = useState<DeckLoadNotice>(null);
  const actions = useMemo(() => libraryDeckActions({
    engine: () => engRef.current,
    setNotice,
    autoCueOnQueue: autoSilenceTrimOn,
  }), []);
  // PopoutShell's content area is overflow:hidden; LibraryPanel is a plain flex-column with no
  // internal scroll (in the main app the surrounding page scrolls). Give the window its own
  // vertical scroll so a library taller than the window is reachable.
  return (
    <div style={{ height: "100%", overflowY: "auto", overflowX: "hidden", padding: 16 }}>
      <LibraryPanel {...actions} />
      <DeckLoadNoticeBar notice={notice} />
    </div>
  );
}
