// PopoutRenderer.tsx — routes #popout/<panel> hash to the right component
// Loaded by src/main.tsx when window.location.hash starts with "#popout/"

import React, { useState, useEffect } from "react";
import PopoutShell from "./PopoutShell";
import StandaloneDecksPanel from "./StandaloneDecksPanel";
import BroadcastMonitor from "./BroadcastMonitor";
import MicDeck from "./MicDeck";
import PhoneDesk from "./PhoneDesk";
import VoiceTracker from "./VoiceTracker";
import UpNext from "./UpNext";
import { HealthMonitor } from "./HealthMonitor";
import { BoutiqueCartWall } from "./DeckConfigurator";
import Scheduler from "./Scheduler";
import BroadcastCalendar from "./BroadcastCalendar";
import { LibraryPanel } from "../App";
import { getEngine } from "../audio/engine-registry";
import { useActiveStation } from "../hooks/useActiveStation";

// ── StandaloneUpNext — wraps UpNext; syncs queue via broadcast relay ──
// The main window emits "ether:broadcast" { channel: "queue:sync", data: queueLen }
// on every queue change; this window receives it and refreshes.

function StandaloneUpNext() {
  const [queueLen, setQueueLen] = useState(0);
  const [rev, setRev] = useState(0);   // bump to force UpNext re-fetch

  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.on) return;
    const h = ether.on("queue:sync", (len: number) => {
      setQueueLen(len);
      setRev(r => r + 1);
    });
    return () => ether.off("queue:sync", h);
  }, []);

  return <UpNext key={rev} queueLen={queueLen} onQueueChange={() => setRev(r => r + 1)} />;
}

// ── Router ───────────────────────────────────────────────────

const TITLES: Record<string, string> = {
  "decks":     "Decks",
  "mic":       "Mic",
  "master":    "Master Output",
  "upnext":    "Up Next",
  "phone":     "Phone Desk",
  "voicetrack":"Voice Tracker",
  "health":    "Station Health",
  "carts":     "Carts",
  "shows":     "Shows",
  "clocks":    "Clocks",
  "categories":"Categories",
  "library":   "Library",
  "calendar":  "Calendar",
};

// Library pop-out handlers — cue a track onto a deck via the shared engine (daemon-backed,
// so it affects the live air chain). Edit/send-to-studio aren't meaningful in a pop-out.
function PopoutLibrary() {
  const { stationId } = useActiveStation();
  const eng = getEngine(stationId ?? 1);
  const cue = (deck: "A" | "B" | "C", s: any) => {
    try { eng.deckCue?.(deck, { filePath: s.file_path, title: s.title, artist: s.artist_name || "", durationMs: s.duration_ms ?? 0 }); } catch { /* engine not ready */ }
  };
  return (
    <LibraryPanel
      onLoadA={s => cue("A", s)} onLoadB={s => cue("B", s)} onLoadC={s => cue("C", s)}
      onQueue={s => { try { (eng as any).enqueue?.({ filePath: s.file_path, title: s.title, artist: s.artist_name || "", durationMs: s.duration_ms ?? 0 }); } catch {} }}
      onEdit={() => {}} onSendToStudio={() => {}}
    />
  );
}

export default function PopoutRenderer({ panel }: { panel: string }) {
  const title = TITLES[panel] ?? panel;

  let content: React.ReactNode;
  switch (panel) {
    case "decks":
      content = <StandaloneDecksPanel />;
      break;
    case "master":
      content = <BroadcastMonitor />;
      break;
    case "mic":
      content = <MicDeck />;
      break;
    case "phone":
      content = <PhoneDesk onClose={() => window.close()} />;
      break;
    case "voicetrack":
      content = <VoiceTracker />;
      break;
    case "upnext":
      content = <StandaloneUpNext />;
      break;
    case "health":
      content = <HealthMonitor onClose={() => window.close()} />;
      break;
    case "carts":
      content = <BoutiqueCartWall deckSlot="C" />;
      break;
    case "shows":
      content = <Scheduler defaultTab="shows" embedded />;
      break;
    case "clocks":
      content = <Scheduler defaultTab="clocks" embedded />;
      break;
    case "categories":
      content = <Scheduler defaultTab="categories" embedded />;
      break;
    case "calendar":
      content = <BroadcastCalendar />;
      break;
    case "library":
      content = <PopoutLibrary />;
      break;
    default:
      content = (
        <div style={{ color: "#505060", padding: 32, fontSize: 13 }}>
          Unknown pop-out panel: <code style={{ color: "#6080a0" }}>{panel}</code>
        </div>
      );
  }

  return (
    <PopoutShell title={title}>
      {content}
    </PopoutShell>
  );
}
