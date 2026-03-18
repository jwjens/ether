import UserLogin from "./components/UserLogin";
import KeyboardHelp from "./components/KeyboardHelp";
import { UserContext, AppUser, useRole } from "./UserContext";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useState, useEffect, useRef, useCallback } from "react";
import { query, execute, queryOne } from "./db/client";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { engine, DeckState } from "./audio/engine";
import { fillQueueFromSchedule, refillFromSchedule } from "./audio/loggen";
import { readID3 } from "./audio/id3";
import Waveform from "./components/Waveform";
import OnAirDeck from "./components/OnAirDeck";
import CartWall from "./components/CartWall";
import ImportDialog from "./components/ImportDialog";
import NexGenImport from "./components/NexGenImport";
import BackupRestore from "./components/BackupRestore";
import DMCANotice from "./components/DMCANotice";
import JockStrip from "./components/JockStrip";
import UpNext from "./components/UpNext";
import Scheduler from "./components/Scheduler";
import Logs from "./components/Logs";
import NowPlaying from "./components/NowPlaying";
import { openNowPlayingWindow } from "./components/NowPlayingWindow";
import Spots from "./components/Spots";
import RulesEditor from "./components/RulesEditor";
import ProcessingPanel from "./components/ProcessingPanel";
import NowPlayingSettings from "./components/NowPlayingSettings";
import StreamManager from "./components/StreamManager";
import AudioDevices from "./components/AudioDevices";
import VoiceTracker from "./components/VoiceTracker";
import Announcements, { startAnnouncementEngine } from "./components/Announcements";
import SplashScreen from "./components/SplashScreen";
import FirstRunWizard from "./components/FirstRunWizard";

type Panel = "live" | "library" | "clocks" | "logs" | "spots" | "voicetrack" | "announce" | "streaming" | "settings";

interface SongRow {
  id: number; title: string; file_path: string | null;
  artist_name: string | null; album_title: string | null;
  genre: string | null; duration_ms: number;
  category_code: string | null; category_color: string | null;
}

const EXTS = [".mp3",".flac",".ogg",".wav",".m4a",".aac",".wma",".aiff"];
function isAudio(n: string) { return EXTS.some(e => n.toLowerCase().endsWith(e)); }
function titleFromFile(p: string) { return (p.split(/[\\/]/).pop() || p).replace(/\.[^.]+$/, "").replace(/[_-]/g, " ").replace(/^\d+\.?\s*/, ""); }
function fmtExt(p: string) { return (p.split(".").pop() || "").toLowerCase(); }
function fmtTime(s: number) { if (!s || s < 0) return "0:00"; return Math.floor(s/60) + ":" + String(Math.floor(s%60)).padStart(2,"0"); }
function fmtTimeLong(s: number) { if (!s || s < 0) return "00:00.0"; const m = Math.floor(s/60); const sec = s % 60; return String(m).padStart(2,"0") + ":" + sec.toFixed(1).padStart(4,"0"); }

export default function App() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [panel, setPanel] = useState<Panel>("live");
  const [onAir, setOnAir] = useState(false);
  const [deckA, setDeckA] = useState<DeckState | null>(null);
  const [deckB, setDeckB] = useState<DeckState | null>(null);
  const [deckC, setDeckC] = useState<DeckState | null>(null);
  const [autoAdv, setAutoAdv] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [queueLen, setQueueLen] = useState(0);
  const [showNowPlaying, setShowNowPlaying] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [stationName, setStationName] = useState("Ether");
  const [darkMode, setDarkMode] = useState(false);
  const [showCarts, setShowCarts] = useState(false);
  const [outputDevice, setOutputDevice] = useState("");
  const [inputDevice, setInputDevice] = useState("");

  // Log plays to database
  useEffect(() => {
    (globalThis as any).__etherEngine = engine;
    return engine.onPlayStart(async (deckId, title, artist, filePath) => {
      try {
        await execute(
          "INSERT INTO play_log (title, artist, deck, played_at) VALUES (?, ?, ?, unixepoch())",
          [title, artist, deckId]
        );
      } catch (e) { console.error('Log write error:', e); }
    });
  }, []);

  // Respond to Now Playing window requesting current track
  useEffect(() => {
    const unlisten = listen("now-playing-request", () => {
      const track = (globalThis as any).__currentTrack;
      const deckA = engine.getDeck("A");
      const stA = deckA?.getState();
      emit("now-playing-update", {
        title: stA?.title || track?.title || "Ether Radio",
        artist: stA?.artist || track?.artist || "",
        positionSec: stA?.positionSec || 0,
        durationSec: stA?.durationSec || 0,
        isPlaying: stA?.status === "playing" || false,
      }).catch(() => {});
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  // Refill callback: loads all songs from DB when queue empties
  useEffect(() => {
    engine.setRefillCallback(async () => {
      const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 500");
      return rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" }));
    });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const dA = engine.getDeck("A");
      const dB = engine.getDeck("B");
      switch(e.code) {
        case "Space": e.preventDefault(); if (dA) { if (dA.getState().status === "playing") dA.pause(); else if (dA.getState().status === "paused") dA.resume(); else dA.play(); } break;
        case "KeyB": if (dB) { if (dB.getState().status === "playing") dB.pause(); else if (dB.getState().status === "paused") dB.resume(); else dB.play(); } break;
        case "KeyX": if (deckA?.status === "playing" && deckB?.filePath) engine.crossfade("A", "B", 2000); else if (deckB?.status === "playing" && deckA?.filePath) engine.crossfade("B", "A", 2000); break;
        case "Escape": dA?.stop(); dB?.stop(); break;
        case "KeyN": setPanel("live"); break;
        case "KeyL": setPanel("library"); break;
        case "KeyS": setPanel("clocks"); break;
        case "KeyG": setPanel("logs"); break;
        case "KeyA": e.preventDefault(); toggleAuto(); break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [deckA, deckB]);

  useEffect(() => {
    engine.init();
    engine.outroCrossfade = true;
    engine.crossfadeDuration = 3;
    return engine.on((id, st) => {
      if (id === "A") { setDeckA({...st}); setOnAir(st.status === "playing"); }
      else if (id === "B") setDeckB({...st});
      else if (id === "C") setDeckC({...st});
      setQueueLen(engine.getQueue().length); 

    });
  }, []);

  // Autosave queue every 30 seconds for crash recovery
  useEffect(() => {
    const saveQueue = async () => {
      try {
        const queue = engine.getQueue();
        const deckA = engine.getDeck('A')?.getState();
        await execute(
          "UPDATE crash_recovery SET queue_json=?, deck_a_path=?, deck_a_title=?, deck_a_artist=?, deck_a_position=?, was_playing=?, saved_at=unixepoch() WHERE id=1",
          [
            JSON.stringify(queue),
            deckA?.filePath || null,
            deckA?.title || null,
            deckA?.artist || null,
            deckA?.positionSec || 0,
            deckA?.status === 'playing' ? 1 : 0,
          ]
        );
      } catch (e) { console.error('Autosave failed:', e); }
    };
    const id = setInterval(saveQueue, 30000);
    return () => clearInterval(id);
  }, []);

  // Restore queue on startup if crash recovery data exists
  useEffect(() => {
    (async () => {
      try {
        const row = await queryOne<{queue_json: string, deck_a_path: string | null, deck_a_title: string | null, deck_a_artist: string | null, was_playing: number, saved_at: number}>(
          "SELECT * FROM crash_recovery WHERE id=1"
        );
        if (!row || !row.saved_at) return;
        const age = Date.now() / 1000 - row.saved_at;
        if (age > 3600) return; // Only restore if saved within last hour
        const queue = JSON.parse(row.queue_json || '[]');
        if (queue.length > 0) {
          engine.addToQueue(queue);
          setQueueLen(queue.length);
          console.log('Restored', queue.length, 'items from crash recovery');
        }
        if (row.deck_a_path && row.deck_a_title) {
          await engine.loadToDeck('A', row.deck_a_path, row.deck_a_title, row.deck_a_artist || '');
          console.log('Restored deck A:', row.deck_a_title);
        }
        // Clear recovery data after restore
        await execute("UPDATE crash_recovery SET queue_json='[]', deck_a_path=NULL, was_playing=0, saved_at=0 WHERE id=1", []);
      } catch (e) { console.error('Crash restore failed:', e); }
    })();
  }, []);

  // Dead air watchdog - listens for Rust watchdog events and force-advances queue
  useEffect(() => {
    // Enable watchdog in Rust when AUTO is on
    if (autoAdv) {
      invoke("watchdog_set", { active: true, thresholdSec: 10.0 }).catch(() => {});
    } else {
      invoke("watchdog_set", { active: false, thresholdSec: 10.0 }).catch(() => {});
    }
  }, [autoAdv]);

  useEffect(() => {
    const unlisten = listen("dead-air-detected", async (event) => {
      console.warn("Dead air detected after", event.payload, "seconds - recovering...");
      // Try to restart playback
      const q = engine.getQueue();
      if (q.length > 0) {
        const next = q[0];
        engine.clearQueue();
        engine.addToQueue(q.slice(1));
        await engine.loadToDeck('A', next.filePath, next.title, next.artist);
        const deck = engine.getDeck('A');
        if (deck) deck.play();
      } else if (autoAdv) {
        // Refill from schedule and restart
        await fillQueueFromSchedule().then(async (count) => {
          if (count === 0) {
            // Random fallback
            const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 100");
            const items = rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" }));
            engine.addToQueue(items);
          }
          const q2 = engine.getQueue();
          if (q2.length > 0) {
            const next = q2[0];
            engine.clearQueue();
            engine.addToQueue(q2.slice(1));
            await engine.loadToDeck('A', next.filePath, next.title, next.artist);
            const deck = engine.getDeck('A');
            if (deck) deck.play();
          }
        });
      }
    });
    return () => { unlisten.then(f => f()); };
  }, [autoAdv]);

  const handleOutputChange = (deviceId: string) => { setOutputDevice(deviceId); engine.setOutputDevice(deviceId); };
  const handleInputChange = (deviceId: string) => { setInputDevice(deviceId); };

  const toggleAuto = async () => {
    const n = !autoAdv;
    setAutoAdv(n);
    engine.autoAdvance = n;
    if (n) {
      // AUTO on = fill queue from schedule and start playing
      engine.init();
      engine.continuous = true;
      setContinuous(true);
      engine.shuffle = false;
      setShuffle(false);
      if (engine.getQueue().length === 0) {
        const count = await fillQueueFromSchedule();
        if (count === 0) {
          // Fallback: load all songs randomly
          engine.setRefillCallback(async () => {
            const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 500");
            return rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" }));
          });
          const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 100");
          const items = rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" }));
          engine.addToQueue(items);
        }
      }
      const q = engine.getQueue();
      if (q.length > 0 && engine.getDeck('A')?.getState().status !== 'playing') {
        const first = q[0];
        engine.clearQueue();
        engine.addToQueue(q.slice(1));
        await engine.loadToDeck('A', first.filePath, first.title, first.artist);
        engine.getDeck('A')?.play();
        // Preload B=queue[0], C=queue[1] - guard against double-fire
        clearTimeout((globalThis as any).__preloadTimer);
        (globalThis as any).__preloadTimer = setTimeout(async () => {
          const q2 = engine.getQueue();
          if (q2.length >= 1) await engine.loadToDeck("B", q2[0].filePath, q2[0].title, q2[0].artist);
          if (q2.length >= 2) await engine.loadToDeck("C" as any, q2[1].filePath, q2[1].title, q2[1].artist);
        }, 1500);
      }
    } else {
      engine.continuous = false;
      setContinuous(false);
    }
  };

  const toggleShuffle = () => { const n = !shuffle; setShuffle(n); engine.shuffle = n; };
  const toggleContinuous = async () => {
    const n = !continuous;
    setContinuous(n);
    engine.continuous = n;
    if (n) {
      // Auto-start: fill queue from schedule and play
      engine.autoAdvance = true;
      setAutoAdv(true);
      engine.shuffle = true;
      setShuffle(true);
      if (engine.getQueue().length === 0) {
        const count = await fillQueueFromSchedule();
        if (count > 0) {
          const q = engine.getQueue();
          if (q.length > 0) {
            const first = q.shift();
            if (first) {
              engine.clearQueue();
              engine.addToQueue(q);
              await engine.loadToDeck('A', first.filePath, first.title, first.artist);
              engine.getDeck('A')?.play();
            }
          }
        }
      }
    }
  };

  const loadA = useCallback((s: SongRow) => { if (s.file_path) engine.loadToDeck("A", s.file_path, s.title, s.artist_name || ""); }, []);
  const loadB = useCallback((s: SongRow) => { if (s.file_path) engine.loadToDeck("B", s.file_path, s.title, s.artist_name || ""); }, []);
  const addToQueue = useCallback((s: SongRow) => {
    if (s.file_path) { engine.addToQueue([{ filePath: s.file_path, title: s.title, artist: s.artist_name || "" }]); setQueueLen(engine.getQueue().length);  }
  }, []);

  // User login gate
  if (!currentUser) {
    return <UserLogin onLogin={setCurrentUser} />;
  }

  return (
    <div className={"h-screen flex flex-col " + (darkMode ? "dark-theme bg-zinc-950 text-zinc-100" : "")} style={{ background: "var(--bg-primary)", color: "var(--text-primary)" }}>
      <KeyboardHelp />
      {/* Now Playing opens as separate window via openNowPlayingWindow() */}
      <header style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)", boxShadow: "var(--shadow-sm)", flexShrink: 0 }}>
        <div className="flex items-center gap-0">
          <Nav active={panel} set={setPanel} />
          <span className="ether-logo" style={{ marginLeft: 24, fontSize: 24 }}><span className="eth">Eth</span><span className="er">er</span></span><span style={{ fontSize: 13, fontWeight: 400, color: "var(--text-tertiary)", marginLeft: 16 }}>{stationName}</span>
          <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontWeight: 300, letterSpacing: "0.02em" }}>v1.5</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <button onClick={() => setCurrentUser(null)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer", marginRight: 4 }}>
            {currentUser?.name} ↩
          </button>
          <button onClick={() => setDarkMode(!darkMode)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: darkMode ? "var(--accent-purple)" : "var(--bg-tertiary)", color: darkMode ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>{darkMode ? "DARK" : "LIGHT"}</button>
          <button onClick={() => openNowPlayingWindow()} style={{ padding: "4px 12px", background: "var(--bg-tertiary)", border: "none", borderRadius: 6, fontSize: 10, fontWeight: 700, color: "var(--text-secondary)", cursor: "pointer", letterSpacing: "0.05em" }}>NOW PLAYING</button>
          <ClockDisplay />
          <div style={{
              marginLeft: 12,
              padding: "6px 16px",
              borderRadius: 8,
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              cursor: "default",
              transition: "all 0.3s ease",
              background: onAir ? "#ef4444" : "var(--bg-tertiary)",
              color: onAir ? "#fff" : "var(--text-tertiary)",
              border: onAir ? "1px solid rgba(255,255,255,0.2)" : "1px solid var(--border-primary)",
              boxShadow: onAir ? "0 0 20px rgba(239,68,68,0.5), 0 0 40px rgba(239,68,68,0.2), inset 0 1px 0 rgba(255,255,255,0.1)" : "none",
              animation: onAir ? "onair-pulse 1.8s ease-in-out infinite" : "none",
            }}>
              {onAir ? "● ON AIR" : "○ OFF AIR"}
            </div>
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <main style={{ flex: 1, overflow: "auto", padding: 20, background: "var(--bg-primary)" }}>
          {panel === "live" && <LivePanel deckA={deckA} deckB={deckB} deckC={deckC} autoAdv={autoAdv} shuffle={shuffle} continuous={continuous} toggleAuto={toggleAuto} toggleShuffle={toggleShuffle} toggleContinuous={toggleContinuous} queueLen={queueLen} showCarts={showCarts} toggleCarts={() => setShowCarts(!showCarts)} />}
          {panel === "library" && <LibraryPanel onLoadA={loadA} onLoadB={loadB} onQueue={addToQueue} />}
          {panel === "clocks" && <Scheduler />}
          {panel === "logs" && <Logs />}
          {panel === "spots" && <Spots />}
          {panel === "streaming" && <StreamManager />}
          {panel === "announce" && <Announcements />}
          {panel === "voicetrack" && <VoiceTracker inputDeviceId={inputDevice || undefined} />}
          <DMCANotice />
      {panel === "settings" && <div className="space-y-6"><ProcessingPanel /><BackupRestore /><NowPlayingSettings /><AudioDevices onOutputChange={handleOutputChange} onInputChange={handleInputChange} currentOutput={outputDevice} currentInput={inputDevice} /><RulesEditor /></div>}
        </main>
      </div>
      <footer style={{ height: 28, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", background: "var(--bg-secondary)", borderTop: "1px solid var(--border-primary)", fontSize: 11, color: "var(--text-tertiary)", flexShrink: 0 }}>
        <span>{deckA?.status === "playing" ? "Playing: " + deckA.title : "Ready"}</span>
        <span>{autoAdv ? "AUTO" : "MANUAL"}{shuffle ? " | SHUFFLE" : ""}{continuous ? " | 24/7" : ""} | Queue: {queueLen} | Space=Play/Pause X=Crossfade</span>
      </footer>
    </div>
  );
}

function Nav({ active, set }: { active: Panel; set: (p: Panel) => void }) {
  const [open, setOpen] = useState(false);
  const items: { id: Panel; label: string; icon: string }[] = [
    { id: "live", label: "Live Assist", icon: "▶" },
    { id: "library", label: "Library", icon: "♪" },
    { id: "clocks", label: "Schedule", icon: "⏱" },
    { id: "logs", label: "Logs", icon: "📋" },
    { id: "spots", label: "Spots", icon: "📢" },
    { id: "voicetrack" as Panel, label: "Voice Track", icon: "🎙" },
    { id: "announce" as Panel, label: "Announce", icon: "📡" },
    { id: "streaming" as Panel, label: "Stream", icon: "🌐" },
    { id: "settings", label: "Settings", icon: "⚙" },
  ];
  const current = items.find(i => i.id === active);
  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: "flex", alignItems: "center", gap: 8, padding: "0 20px", height: 56,
        background: open ? "var(--bg-tertiary)" : "transparent",
        border: "none", borderRight: "1px solid var(--border-primary)",
        color: "var(--text-primary)", cursor: "pointer", fontSize: 13, fontWeight: 500, minWidth: 160,
      }}>
        <span style={{ fontSize: 18 }}>☰</span>
        <span style={{ flex: 1, textAlign: "left" as any }}>{current?.label || "Menu"}</span>
        <span style={{ fontSize: 9, color: "var(--text-tertiary)" }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <>
        <div style={{ position: "fixed", inset: 0, zIndex: 98 }} onClick={() => setOpen(false)} />
        <div style={{ position: "absolute", top: "100%", left: 0, zIndex: 99, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: "0 0 14px 14px", boxShadow: "var(--shadow-lg)", minWidth: 220, overflow: "hidden" }}>
          {items.map(i => (
            <button key={i.id} onClick={() => { set(i.id); setOpen(false); }} style={{
              display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "11px 20px",
              textAlign: "left" as any, fontSize: 13,
              fontWeight: active === i.id ? 600 : 400,
              color: active === i.id ? "#22d3ee" : "var(--text-secondary)",
              background: active === i.id ? "var(--bg-tertiary)" : "transparent",
              border: "none", borderLeft: active === i.id ? "3px solid #22d3ee" : "3px solid transparent",
              cursor: "pointer",
            }}>
              <span style={{ fontSize: 14, width: 20, textAlign: "center" as any }}>{i.icon}</span>
              {i.label}
            </button>
          ))}
          <div style={{ padding: "10px 20px", fontSize: 10, color: "var(--text-tertiary)", borderTop: "1px solid var(--border-primary)" }}>
            Ether v1.5 · Free forever
          </div>
        </div>
      </>}
    </div>
  );
}


// ============================================================
// LIVE PANEL — polished
// ============================================================

function LivePanel({ deckA, deckB, deckC, autoAdv, shuffle, continuous, toggleAuto, toggleShuffle, toggleContinuous, queueLen, showCarts, toggleCarts }: { deckA: DeckState | null; deckB: DeckState | null; deckC: DeckState | null; autoAdv: boolean; shuffle: boolean; continuous: boolean; toggleAuto: () => void | Promise<void>; toggleShuffle: () => void; toggleContinuous: () => void | Promise<void>; queueLen: number; showCarts: boolean; toggleCarts: () => void }) {
  const [autoXfade, setAutoXfade] = useState(true);
  const handleXfade = () => {
    if (deckA?.status === "playing" && deckB?.filePath) engine.crossfade("A", "B", 2000);
    else if (deckB?.status === "playing" && deckA?.filePath) engine.crossfade("B", "A", 2000);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Top control bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexShrink: 0 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.03em", color: "var(--text-primary)" }}>Live Assist</h1>
        <div style={{ display: "flex", gap: 6 }}>
          {[
            { label: "SHUFFLE", active: shuffle, onClick: toggleShuffle, color: "#fbbf24" },
            { label: autoAdv ? "AUTO ON" : "AUTO", active: autoAdv, onClick: async () => { await toggleAuto(); }, color: "#22d3ee" },
            { label: "CARTS", active: showCarts, onClick: toggleCarts, color: "#f97316" },
            { label: "AUTO-X", active: autoXfade, onClick: () => { const n = !autoXfade; setAutoXfade(n); engine.outroCrossfade = n; }, color: "#a78bfa" },
            { label: "XFADE", active: false, onClick: handleXfade, color: "#a78bfa" },
          ].map(btn => (
            <button key={btn.label} onClick={btn.onClick} style={{
              padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700,
              letterSpacing: "0.06em", cursor: "pointer",
              background: btn.active ? btn.color : "var(--bg-tertiary)",
              color: btn.active ? "#000" : "var(--text-tertiary)",
              border: btn.active ? "none" : "1px solid var(--border-primary)",
              boxShadow: btn.active ? `0 2px 12px ${btn.color}50` : "none",
              transition: "all 0.15s ease",
            }}>{btn.label}</button>
          ))}
        </div>
      </div>

      {/* Main: queue LEFT, decks A B C horizontal RIGHT */}
      <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0, overflow: "hidden" }}>

        {/* LEFT: Queue */}
        <div style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <UpNext queueLen={queueLen} onQueueChange={() => {}} />
        </div>

        {/* RIGHT: 3 Decks horizontal + search below */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          {/* 3 Decks side by side */}
          <div style={{ display: "flex", gap: 10, flex: "0 0 auto" }}>
            <div style={{ flex: 1 }}>
              <OnAirDeck
                deck={deckA} label="Deck A" deckId="A"
                onPlay={() => engine.getDeck("A")?.play()}
                onPause={() => engine.getDeck("A")?.pause()}
                onResume={() => engine.getDeck("A")?.resume()}
                onStop={() => engine.getDeck("A")?.stop()}
                onVolume={v => engine.getDeck("A")?.setVolume(v)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <OnAirDeck
                deck={deckB} label="Deck B" deckId="B"
                onPlay={() => engine.getDeck("B")?.play()}
                onPause={() => engine.getDeck("B")?.pause()}
                onResume={() => engine.getDeck("B")?.resume()}
                onStop={() => engine.getDeck("B")?.stop()}
                onVolume={v => engine.getDeck("B")?.setVolume(v)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <OnAirDeck
                deck={deckC} label="Deck C" deckId="C"
                onPlay={() => (engine.getDeck as any)("C")?.play()}
                onPause={() => (engine.getDeck as any)("C")?.pause()}
                onResume={() => (engine.getDeck as any)("C")?.resume()}
                onStop={() => (engine.getDeck as any)("C")?.stop()}
                onVolume={v => (engine.getDeck as any)("C")?.setVolume(v)}
              />
            </div>
          </div>
          {/* Below decks: search strip */}
          <div style={{ marginTop: 10, flex: 1, minHeight: 0 }}>
            {showCarts ? <CartWall /> : <JockStrip deckA={deckA} deckB={deckB} />}
          </div>
        </div>

      </div>
    </div>
  );
}


function DeckCard({ deck, deckId, accentColor, waveColor, playedColor }: { deck: DeckState | null; deckId: "A" | "B"; accentColor: string; waveColor: string; playedColor: string }) {
  const d = engine.getDeck(deckId);
  const st = deck?.status || "idle";
  const pos = deck?.positionSec || 0;
  const dur = deck?.durationSec || 0;
  const progress = dur > 0 ? pos / dur : 0;
  const peaks = deck?.peaks || [];

  const handlePlay = () => {
    if (!d) return;
    if (st === "playing") d.pause();
    else if (st === "paused") d.resume();
    else d.play();
  };

  const pLabel = st === "playing" ? "PAUSE" : st === "paused" ? "RESUME" : "PLAY";

  const statusColor = st === "playing" ? "text-emerald-400" : st === "paused" ? "text-yellow-400" : st === "loading" ? "text-blue-400" : st === "error" ? "text-red-400" : "text-zinc-600";

  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-800">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: accentColor }}>{"Deck " + deckId}</span>
          <span className={"text-[10px] uppercase font-bold " + statusColor}>{st}</span>
        </div>
      </div>

      <div className="px-3 pt-2">
        <div className="text-sm text-zinc-100 truncate font-medium">{deck?.title || "No track loaded"}</div>
        <div className="text-[11px] text-zinc-500 truncate">{deck?.artist || ""}</div>
      </div>

      <div className="px-3 py-2">
        <Waveform peaks={peaks} progress={progress} color={waveColor} playedColor={playedColor} height={50} />
      </div>

      <div className="flex justify-between px-3 text-zinc-400 mb-2">
        <span className="text-lg font-mono font-bold">{fmtTimeLong(pos)}</span>
        <span className="text-lg font-mono font-bold text-zinc-600">-{fmtTimeLong(dur - pos)}</span>
      </div>

      <div className="flex items-center gap-1.5 px-3 pb-2">
        <button onClick={() => d?.stop()} className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-bold text-zinc-400">STOP</button>
        <button onClick={handlePlay} className="flex-1 py-2 rounded text-xs font-bold text-white" style={{ backgroundColor: st === "playing" ? "#ca8a04" : accentColor }}>{pLabel}</button>
      </div>

      <div className="flex items-center gap-2 px-3 pb-3 text-xs text-zinc-500">
        <span className="text-[10px]">VOL</span>
        <input type="range" min="0" max="100" value={Math.round((deck?.volume || 1) * 100)} onChange={e => d?.setVolume(parseInt(e.target.value) / 100)} className="flex-1 h-1 accent-blue-500" />
        <span className="text-[10px] w-8 text-right">{Math.round((deck?.volume || 1) * 100)}%</span>
      </div>

      {deck?.error ? <div className="px-3 pb-2 text-[11px] text-red-400">{deck.error}</div> : null}
    </div>
  );
}

// ============================================================
// LIBRARY
// ============================================================

function LibraryPanel({ onLoadA, onLoadB, onQueue }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void; onQueue: (s: SongRow) => void }) {
  const [showImport, setShowImport] = useState(false);
  const [showNexGen, setShowNexGen] = useState(false);
  const [catList, setCatList] = useState<{ id: number; code: string; color: string | null }[]>([]);
  const [songs, setSongs] = useState<SongRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [count, setCount] = useState(0);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const load = async () => {
    try {
      const rows = await query<SongRow>("SELECT s.*, a.name as artist_name, al.title as album_title, c.code as category_code, c.color as category_color FROM songs s LEFT JOIN artists a ON a.id = s.artist_id LEFT JOIN albums al ON al.id = s.album_id LEFT JOIN categories c ON c.id = s.category_id ORDER BY s.title LIMIT 500");
      setSongs(rows);
      const r = await queryOne<{ c: number }>("SELECT COUNT(*) as c FROM songs");
      setCount(r ? r.c : 0);
      setCatList(await query<{ id: number; code: string; color: string | null }>("SELECT id, code, color FROM categories ORDER BY code"));
    } catch (e) { console.error(e); setStatus("Error: " + e); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleImport = async () => {
    try {
      const folder = await open({ directory: true, title: "Select Music Folder" });
      if (!folder) return;
      setImporting(true); setStatus("Scanning...");
      const entries = await readDir(folder as string);
      const files: string[] = [];
      for (const e of entries) {
        if (e.name && isAudio(e.name)) {
          const sep = (folder as string).includes("/") ? "/" : "\\";
          files.push((folder as string) + sep + e.name);
        }
      }
      if (files.length === 0) { setStatus("No audio files found."); setTimeout(() => setStatus(""), 3000); setImporting(false); return; }
      let n = 0;
      for (const fp of files) {
        const ex = await queryOne<{ id: number }>("SELECT id FROM songs WHERE file_path = ?", [fp]);
        if (!ex) {
          const tags = await readID3(fp);
          const title = tags.title || titleFromFile(fp);
          const artist = tags.artist || null;
          const album = tags.album || null;
          const genre = tags.genre || null;
          let artistId: number | null = null;
          if (artist) {
            const exArt = await queryOne<{ id: number }>("SELECT id FROM artists WHERE name = ?", [artist]);
            if (exArt) { artistId = exArt.id; }
            else { const r = await execute("INSERT INTO artists (name) VALUES (?)", [artist]); artistId = r.lastInsertId; }
          }
          let albumId: number | null = null;
          if (album) {
            const exAlb = await queryOne<{ id: number }>("SELECT id FROM albums WHERE title = ? AND (artist_id = ? OR artist_id IS NULL)", [album, artistId]);
            if (exAlb) { albumId = exAlb.id; }
            else { const r = await execute("INSERT INTO albums (title, artist_id) VALUES (?, ?)", [album, artistId]); albumId = r.lastInsertId; }
          }
          await execute("INSERT INTO songs (title, artist_id, album_id, file_path, file_format, genre, daypart_mask) VALUES (?, ?, ?, ?, ?, ?, ?)", [title, artistId, albumId, fp, fmtExt(fp), genre, 16777215]);
          n++;
        }
        setStatus("Importing... " + n);
      }
      setStatus("Done! " + n + " imported."); setTimeout(() => setStatus(""), 4000);
      setImporting(false); load();
    } catch (e) { console.error(e); setStatus("Error: " + e); setImporting(false); }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const selectAll = () => {
    setSelectedIds(prev => prev.size === filtered.length ? new Set() : new Set(filtered.map(s => s.id)));
  };
  const deleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm("Delete " + selectedIds.size + " song(s) from library?")) return;
    for (const id of selectedIds) await execute("DELETE FROM songs WHERE id=?", [id]);
    setSelectedIds(new Set()); load();
  };
  const deleteAll = async () => {
    if (!confirm("Delete ALL " + count + " songs? This cannot be undone.")) return;
    await execute("DELETE FROM songs", []); setSelectedIds(new Set()); load();
  };
  const analyzeLufs = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const songs = await query<{id: number, file_path: string}>(
      "SELECT id, file_path FROM songs WHERE file_path IS NOT NULL AND gain_db = 0 LIMIT 50"
    );
    if (songs.length === 0) { setStatus("All songs already analyzed"); setTimeout(() => setStatus(""), 3000); return; }
    setStatus("Analyzing loudness... 0/" + songs.length);
    let done = 0;
    for (const song of songs) {
      try {
        const gain = await invoke<number>("analyze_lufs", { filePath: song.file_path });
        await execute("UPDATE songs SET gain_db=? WHERE id=?", [gain, song.id]);
      } catch (e) { console.error("LUFS error:", e); }
      done++;
      setStatus("Analyzing loudness... " + done + "/" + songs.length);
    }
    setStatus("Done! Analyzed " + done + " songs.");
    setTimeout(() => setStatus(""), 4000);
  };

  const relocateLibrary = async () => {
    const folder = await open({ directory: true, title: "Select new music folder location" });
    if (!folder) return;
    const newBase = (folder as string).replace(/\\/g, '/');
    // Find all songs with broken paths
    const broken = await query<{id: number, file_path: string}>(
      "SELECT id, file_path FROM songs WHERE file_path IS NOT NULL"
    );
    let fixed = 0;
    for (const song of broken) {
      const filename = song.file_path.split(/[\/]/).pop();
      if (!filename) continue;
      const newPath = newBase + '/' + filename;
      // Check if file exists at new location by trying to update
      await execute("UPDATE songs SET file_path=? WHERE id=? AND file_path!=?", [newPath, song.id, newPath]);
      fixed++;
    }
    setStatus('Relocated ' + fixed + ' songs to ' + newBase);
    setTimeout(() => setStatus(''), 4000);
    load();
  };


  const queueAll = () => {
    const items = filtered.filter(s => s.file_path);
    engine.addToQueue(items.map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" })));
  };

  const filtered = search ? songs.filter(s => (s.title||"").toLowerCase().includes(search.toLowerCase()) || (s.artist_name||"").toLowerCase().includes(search.toLowerCase())) : songs;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Song Library</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="text-xs text-zinc-500">{count} tracks</span>
          <button onClick={relocateLibrary} style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }} title="Fix broken file paths after moving music folder">📁 Relocate</button>
          <button onClick={analyzeLufs} style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }} title="Analyze loudness for volume normalization">🎚 Normalize</button>
        </div>
          <button onClick={relocateLibrary} style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }} title="Fix broken file paths after moving music folder">📁 Relocate</button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input type="text" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} className="flex-1 px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500" />
        <select onChange={async (e) => {
          if (!e.target.value) return;
          const catId = catList.find(c => c.code === e.target.value)?.id || null;
          const ids = filtered.map(s => s.id);
          for (const id of ids) { await execute("UPDATE songs SET category_id=? WHERE id=?", [catId, id]); }
          e.target.value = "";
          load();
        }} className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300">
          <option value="">Assign All...</option>
          {catList.map(c => <option key={c.id} value={c.code}>All → {c.code}</option>)}
        </select>
        <button onClick={queueAll} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-bold text-white">Queue All</button>
        {selectedIds.size > 0 && <button onClick={deleteSelected} className="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-xs font-bold text-white">Delete {selectedIds.size}</button>}
        <button onClick={deleteAll} className="px-3 py-1.5 bg-zinc-700 hover:bg-red-900 rounded text-xs font-bold text-zinc-400 hover:text-red-300">Delete All</button>
        <button onClick={() => setShowImport(!showImport)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white">{showImport ? "Cancel" : "Import"}</button>
        <button onClick={() => setShowNexGen(!showNexGen)} className="px-3 py-1.5 bg-purple-700 hover:bg-purple-600 rounded text-xs font-bold text-white">{showNexGen ? "Cancel" : "NexGen/ENCO"}</button>
      </div>
      {status ? <div className="px-3 py-1.5 bg-blue-900 border border-blue-700 rounded text-xs text-blue-200">{status}</div> : null}
      {showImport && <ImportDialog onDone={() => { setShowImport(false); load(); }} />}
      {showNexGen && <NexGenImport onDone={() => { setShowNexGen(false); load(); }} />}
      {loading ? <div className="text-sm text-zinc-500">Loading...</div> : filtered.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-zinc-400 text-lg mb-2">No music yet</div>
          <button onClick={() => setShowImport(true)} className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium text-white">Import Music Folder</button>
        </div>
      ) : (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-[10px] text-zinc-500 uppercase border-b border-zinc-800">
              <th className="px-2 py-1.5 w-7"><input type="checkbox" checked={selectedIds.size === filtered.length && filtered.length > 0} onChange={selectAll} /></th>
              <th className="px-2 py-1.5 w-7">#</th>
              <th className="px-2 py-1.5">Title</th>
              <th className="px-2 py-1.5">Artist</th>
              <th className="px-2 py-1.5">Cat</th>
              <th className="px-2 py-1.5">Fmt</th>
              <th className="px-2 py-1.5 text-right w-28">Load</th>
            </tr></thead>
            <tbody>{filtered.map((s, i) => (
              <tr key={s.id} className="border-b border-zinc-800 hover:bg-zinc-800 group">
                <td className="px-2 py-1.5"><input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} /></td>
                <td className="px-2 py-1.5 text-zinc-600">{i+1}</td>
                <td className="px-2 py-1.5 text-zinc-100">{s.title}</td>
                <td className="px-2 py-1.5 text-zinc-400">{s.artist_name || "Unknown"}</td>
                <td className="px-2 py-1.5">
                  <select value={s.category_code || ""} onChange={async (e) => {
                    const catId = catList.find(c => c.code === e.target.value)?.id || null;
                    await execute("UPDATE songs SET category_id=? WHERE id=?", [catId, s.id]);
                    load();
                  }} className="bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-200 px-1 py-0.5">
                    <option value="">—</option>
                    {catList.map(c => <option key={c.id} value={c.code}>{c.code}</option>)}
                  </select>
                </td>
                <td className="px-2 py-1.5 text-zinc-500 uppercase">{s.file_path ? fmtExt(s.file_path) : "--"}</td>
                <td className="px-2 py-1.5 text-right">
                  <button onClick={() => onLoadA(s)} className="px-1.5 py-0.5 bg-blue-700 hover:bg-blue-600 rounded text-[9px] font-bold text-white mr-0.5">A</button>
                  <button onClick={() => onLoadB(s)} className="px-1.5 py-0.5 bg-emerald-700 hover:bg-emerald-600 rounded text-[9px] font-bold text-white mr-0.5">B</button>
                  <button onClick={() => onQueue(s)} className="px-1.5 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[9px] font-bold text-white">Q</button><button onClick={async () => { if (confirm("Delete " + s.title + "?")) { await execute("DELETE FROM songs WHERE id=?", [s.id]); load(); } }} className="px-1.5 py-0.5 bg-zinc-800 hover:bg-red-900 rounded text-[9px] font-bold text-zinc-500 hover:text-red-400">X</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PH({ title }: { title: string }) {
  return <div className="flex flex-col items-center justify-center h-full text-center"><h1 className="text-xl font-bold mb-2">{title}</h1><p className="text-xs text-zinc-600 mt-2">Coming soon</p></div>;
}

function ClockDisplay() {
  const [time, setTime] = useState(new Date().toLocaleTimeString());
  useEffect(() => { const id = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000); return () => clearInterval(id); }, []);
  return <span className="font-mono text-xs">{time}</span>;
}




















