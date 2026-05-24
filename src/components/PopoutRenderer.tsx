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
};

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
