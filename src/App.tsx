import UserLogin from "./components/UserLogin";
import KeyboardHelp from "./components/KeyboardHelp";
import { UserContext, AppUser, useRole } from "./UserContext";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useState, useEffect, useRef, useCallback } from "react";
import { query, execute, queryOne } from "./db/client";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { engine, DeckState } from "./audio/engine-rodio";
import { fillQueueFromSchedule, refillFromSchedule } from "./audio/loggen";
import { readID3 } from "./audio/id3";
import Waveform from "./components/Waveform";
import OnAirDeck from "./components/OnAirDeck";
import CartWall from "./components/CartWall";
import ImportDialog from "./components/ImportDialog";
import NexGenImport from "./components/NexGenImport";
import SettingsPanel from "./components/SettingsPanel";
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
import ShowPrep from "./components/ShowPrep";
import SplashScreen from "./components/SplashScreen";
import FirstRunWizard from "./components/FirstRunWizard";
import Announcements, { startAnnouncementEngine } from "./components/Announcements";

type Panel = "live" | "library" | "clocks" | "logs" | "spots" | "voicetrack" | "announce" | "streaming" | "settings" | "showprep";

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

// ── Toolbar button — defined at module level so React never remounts it ──
function ToolbarBtn({ label, active, onClick, color }: { label: string; active: boolean; onClick: () => void; color: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 32, padding: "0 14px", borderRadius: 8,
        fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
        cursor: "pointer", fontFamily: "'Inter', sans-serif",
        transition: "all 0.15s ease",
        background: active ? color : "var(--bg-secondary)",
        color: active ? "#000" : "var(--text-tertiary)",
        border: active ? "none" : "1px solid var(--border-primary)",
        boxShadow: active ? `0 2px 12px ${color}40` : "none",
      }}
    >{label}</button>
  );
}

function ToolbarSep() {
  return <div style={{ width: 1, height: 20, background: "var(--border-primary)", margin: "0 2px" }} />;
}

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
  const [stationName, setStationName] = useState("Ether");
  const [darkMode, setDarkMode] = useState(false);
  const [showCarts, setShowCarts] = useState(false);
  const [outputDevice, setOutputDevice] = useState("");
  const [inputDevice, setInputDevice] = useState("");

  useEffect(() => {
    (globalThis as any).__etherEngine = engine;
    return engine.onPlayStart(async (deckId, title, artist, filePath) => {
      try { await execute("INSERT INTO play_log (title, artist, deck, played_at) VALUES (?, ?, ?, unixepoch())", [title, artist, deckId]); }
      catch (e) { console.error('Log write error:', e); }
    });
  }, []);

  useEffect(() => {
    const unlisten = listen("now-playing-request", () => {
      const deckA = engine.getDeck("A");
      const stA = deckA?.getState();
      emit("now-playing-update", {
        title: stA?.title || "Ether Radio", artist: stA?.artist || "",
        positionSec: stA?.positionSec || 0, durationSec: stA?.durationSec || 0,
        isPlaying: stA?.status === "playing" || false,
      }).catch(() => {});
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    engine.setRefillCallback(async () => {
      const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 500");
      return rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" }));
    });
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).isContentEditable) return;
      const dA = engine.getDeck("A"); const dB = engine.getDeck("B");
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

  useEffect(() => {
    const saveQueue = async () => {
      try {
        const queue = engine.getQueue();
        const deckA = engine.getDeck('A')?.getState();
        await execute("UPDATE crash_recovery SET queue_json=?, deck_a_path=?, deck_a_title=?, deck_a_artist=?, deck_a_position=?, was_playing=?, saved_at=unixepoch() WHERE id=1",
          [JSON.stringify(queue), deckA?.filePath || null, deckA?.title || null, deckA?.artist || null, deckA?.positionSec || 0, deckA?.status === 'playing' ? 1 : 0]);
      } catch (e) { console.error('Autosave failed:', e); }
    };
    const id = setInterval(saveQueue, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const row = await queryOne<{queue_json: string, deck_a_path: string | null, deck_a_title: string | null, deck_a_artist: string | null, was_playing: number, saved_at: number}>("SELECT * FROM crash_recovery WHERE id=1");
        if (!row || !row.saved_at) return;
        if (Date.now() / 1000 - row.saved_at > 3600) return;
        const queue = JSON.parse(row.queue_json || '[]');
        if (queue.length > 0) { engine.addToQueue(queue); setQueueLen(queue.length); console.log('Restored', queue.length, 'items from crash recovery'); }
        if (row.deck_a_path && row.deck_a_title) {
          await engine.loadToDeck('A', row.deck_a_path, row.deck_a_title, row.deck_a_artist || '');
          console.log('Restored deck A:', row.deck_a_title);
          setTimeout(() => engine.triggerPreload(), 1000);
        }
        await execute("UPDATE crash_recovery SET queue_json='[]', deck_a_path=NULL, was_playing=0, saved_at=0 WHERE id=1", []);
      } catch (e) { console.error('Crash restore failed:', e); }
    })();
  }, []);

  useEffect(() => {
    if (autoAdv) invoke("watchdog_set", { active: true, thresholdSec: 10.0 }).catch(() => {});
    else invoke("watchdog_set", { active: false, thresholdSec: 10.0 }).catch(() => {});
  }, [autoAdv]);

  useEffect(() => {
    const unlisten = listen("dead-air-detected", async (event) => {
      console.warn("Dead air detected after", event.payload, "seconds - recovering...");
      const q = engine.getQueue();
      if (q.length > 0) {
        const next = q[0]; engine.clearQueue(); engine.addToQueue(q.slice(1));
        await engine.loadToDeck('A', next.filePath, next.title, next.artist);
        engine.getDeck('A')?.play();
        setTimeout(() => engine.triggerPreload(), 1000);
      } else if (autoAdv) {
        await fillQueueFromSchedule().then(async (count) => {
          if (count === 0) {
            const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 100");
            engine.addToQueue(rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" })));
          }
          const q2 = engine.getQueue();
          if (q2.length > 0) {
            const next = q2[0]; engine.clearQueue(); engine.addToQueue(q2.slice(1));
            await engine.loadToDeck('A', next.filePath, next.title, next.artist);
            engine.getDeck('A')?.play();
            setTimeout(() => engine.triggerPreload(), 1000);
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
      engine.init(); engine.continuous = true; setContinuous(true); engine.shuffle = false; setShuffle(false);
      if (engine.getQueue().length === 0) {
        const count = await fillQueueFromSchedule();
        if (count === 0) {
          engine.setRefillCallback(async () => {
            const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 500");
            return rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" }));
          });
          const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 100");
          const items = rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" }));
          engine.addToQueue(items); setQueueLen(items.length);
        }
      }
      const q = engine.getQueue();
      if (q.length > 0 && engine.getDeck('A')?.getState().status !== 'playing') {
        const first = q[0]; engine.clearQueue(); engine.addToQueue(q.slice(1)); setQueueLen(engine.getQueue().length);
        await engine.loadToDeck('A', first.filePath, first.title, first.artist);
        engine.getDeck('A')?.play();
        setTimeout(() => engine.triggerPreload(), 800);
      }
    } else { engine.continuous = false; setContinuous(false); }
  };

  const toggleShuffle = () => { const n = !shuffle; setShuffle(n); engine.shuffle = n; };

  const loadA = useCallback((s: SongRow) => { if (s.file_path) engine.loadToDeck("A", s.file_path, s.title, s.artist_name || ""); }, []);
  const loadB = useCallback((s: SongRow) => { if (s.file_path) engine.loadToDeck("B", s.file_path, s.title, s.artist_name || ""); }, []);
  const addToQueue = useCallback((s: SongRow) => {
    if (s.file_path) { engine.addToQueue([{ filePath: s.file_path, title: s.title, artist: s.artist_name || "" }]); setQueueLen(engine.getQueue().length); }
  }, []);

  const nowPlayingTitle = [deckA, deckB, deckC].find(d => d?.status === "playing")?.title || "";

  if (!currentUser) return <UserLogin onLogin={setCurrentUser} />;

  return (
    <div className={"h-screen flex flex-col " + (darkMode ? "dark-theme" : "")} style={{ background: "var(--bg-primary)", color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <KeyboardHelp />

      {/* ── Header ── */}
      <header style={{ height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <Nav active={panel} set={setPanel} />
          <div style={{ width: 1, height: 24, background: "var(--border-primary)", margin: "0 20px" }} />
          <span className="ether-logo"><span className="eth">Eth</span><span className="er">er</span></span>
          {stationName !== "Ether" && <span style={{ fontSize: 12, color: "var(--text-tertiary)", marginLeft: 10 }}>{stationName}</span>}
          {panel !== "live" && (
            <button
              onClick={() => setPanel("live")}
              style={{
                marginLeft: 16,
                height: 32, padding: "0 14px",
                borderRadius: 8,
                background: "var(--accent-cyan)",
                border: "none",
                color: "#000",
                fontSize: 11, fontWeight: 700,
                letterSpacing: "0.06em",
                cursor: "pointer",
                display: "flex", alignItems: "center", gap: 6,
                boxShadow: "0 2px 8px rgba(6,182,212,0.35)",
              }}
            >
              <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor">
                <polygon points="0,0 8,5 0,10"/>
              </svg>
              ON AIR
            </button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {nowPlayingTitle && (
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "4px 10px", background: "var(--bg-tertiary)", borderRadius: 6 }}>
              ♪ {nowPlayingTitle}
            </div>
          )}
          <ClockDisplay />
          <button onClick={() => setDarkMode(!darkMode)} style={{ width: 32, height: 32, borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {darkMode ? "☀" : "◑"}
          </button>
          <button onClick={() => openNowPlayingWindow()} style={{ height: 32, padding: "0 12px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" as any }}>
            NOW PLAYING
          </button>
          <button onClick={() => setCurrentUser(null)} style={{ height: 32, padding: "0 12px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12 }}>◉</span>{currentUser?.name}
          </button>
          <div style={{
            height: 32, padding: "0 14px", borderRadius: 8,
            fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase" as any,
            display: "flex", alignItems: "center", gap: 6, cursor: "default", transition: "all 0.3s ease",
            background: onAir ? "#ef4444" : "var(--bg-tertiary)",
            color: onAir ? "#fff" : "var(--text-tertiary)",
            border: onAir ? "none" : "1px solid var(--border-primary)",
            boxShadow: onAir ? "0 0 24px rgba(239,68,68,0.4)" : "none",
            animation: onAir ? "onair-pulse 1.8s ease-in-out infinite" : "none",
          }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: onAir ? "#fff" : "var(--text-tertiary)", boxShadow: onAir ? "0 0 6px #fff" : "none" }} />
            {onAir ? "ON AIR" : "OFF AIR"}
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <main style={{ flex: 1, overflow: "hidden", padding: 16, display: "flex", flexDirection: "column" }}>
          {panel === "live" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <LivePanel deckA={deckA} deckB={deckB} deckC={deckC} autoAdv={autoAdv} shuffle={shuffle} toggleAuto={toggleAuto} toggleShuffle={toggleShuffle} queueLen={queueLen} showCarts={showCarts} toggleCarts={() => setShowCarts(!showCarts)} />
            </div>
          )}
          {panel !== "live" && (
            <div style={{ flex: 1, overflowY: "auto" }}>
              {panel === "library" && <LibraryPanel onLoadA={loadA} onLoadB={loadB} onQueue={addToQueue} />}
              {panel === "clocks" && <Scheduler />}
              {panel === "logs" && <Logs />}
              {panel === "spots" && <Spots />}
              {panel === "streaming" && <StreamManager />}
              {panel === "announce" && <Announcements />}
              {panel === "voicetrack" && <VoiceTracker inputDeviceId={inputDevice || undefined} />}
              {panel === "showprep" && <ShowPrep />}
              {panel === "settings" && <SettingsPanel />}
            </div>
          )}
          <DMCANotice />
        </main>
      </div>

      {/* ── Footer ── */}
      <footer style={{ height: 26, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", background: "var(--bg-secondary)", borderTop: "1px solid var(--border-primary)", fontSize: 10, color: "var(--text-tertiary)", flexShrink: 0, letterSpacing: "0.02em", fontFamily: "'DM Mono', monospace" }}>
        <span style={{ color: onAir ? "var(--accent-green)" : "var(--text-tertiary)" }}>
          {onAir ? `● ${nowPlayingTitle}` : "○ Off Air"}
        </span>
        <div style={{ display: "flex", gap: 16 }}>
          {autoAdv && <span style={{ color: "var(--accent-cyan)" }}>AUTO</span>}
          {shuffle && <span style={{ color: "var(--accent-amber)" }}>SHUFFLE</span>}
          {continuous && <span>24/7</span>}
          <span>Queue: {queueLen}</span>
          <span style={{ color: "var(--border-secondary)" }}>Space · B · X · Esc</span>
        </div>
      </footer>
    </div>
  );
}

// ── Nav ──────────────────────────────────────────────────────

function Nav({ active, set }: { active: Panel; set: (p: Panel) => void }) {
  const [open, setOpen] = useState(false);
  const items: { id: Panel; label: string; icon: string }[] = [
    { id: "live", label: "Live Assist", icon: "▶" },
    { id: "library", label: "Library", icon: "♪" },
    { id: "clocks", label: "Schedule", icon: "⏱" },
    { id: "logs", label: "Logs", icon: "📋" },
    { id: "spots", label: "Spots", icon: "📢" },
    { id: "voicetrack" as Panel, label: "Voice Track", icon: "🎙" },
    { id: "showprep" as Panel, label: "Show Prep", icon: "📝" },
    { id: "announce" as Panel, label: "Announce", icon: "📡" },
    { id: "streaming" as Panel, label: "Stream", icon: "🌐" },
    { id: "settings", label: "Settings", icon: "⚙" },
  ];
  const current = items.find(i => i.id === active);
  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", height: 36, background: open ? "var(--bg-tertiary)" : "transparent", border: "1px solid " + (open ? "var(--border-secondary)" : "var(--border-primary)"), borderRadius: 9, color: "var(--text-primary)", cursor: "pointer", fontSize: 12, fontWeight: 500 }}>
        <span style={{ fontSize: 14, opacity: 0.6 }}>☰</span>
        <span>{current?.label || "Menu"}</span>
        <span style={{ fontSize: 8, color: "var(--text-tertiary)", marginLeft: 2 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <>
        <div style={{ position: "fixed", inset: 0, zIndex: 98 }} onClick={() => setOpen(false)} />
        <div style={{ position: "absolute", top: "calc(100% + 8px)", left: 0, zIndex: 99, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 14, boxShadow: "var(--shadow-lg)", minWidth: 220, overflow: "hidden", padding: "6px" }}>
          {items.map(i => (
            <button key={i.id} onClick={() => { set(i.id); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", textAlign: "left" as any, fontSize: 13, fontWeight: active === i.id ? 600 : 400, color: active === i.id ? "#22d3ee" : "var(--text-secondary)", background: active === i.id ? "rgba(34,211,238,0.08)" : "transparent", border: "none", borderRadius: 9, cursor: "pointer" }}>
              <span style={{ fontSize: 14, width: 20, textAlign: "center" as any, opacity: 0.7 }}>{i.icon}</span>
              {i.label}
              {active === i.id && <div style={{ marginLeft: "auto", width: 5, height: 5, borderRadius: "50%", background: "#22d3ee" }} />}
            </button>
          ))}
          <div style={{ borderTop: "1px solid var(--border-primary)", marginTop: 6, paddingTop: 6 }}>
            <button
              onClick={() => { setOpen(false); window.dispatchEvent(new KeyboardEvent("keydown", { code: "Slash", shiftKey: true })); }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", textAlign: "left" as any, fontSize: 13, fontWeight: 400, color: "var(--text-secondary)", background: "transparent", border: "none", borderRadius: 9, cursor: "pointer" }}
            >
              <span style={{ fontSize: 14, width: 20, textAlign: "center" as any, opacity: 0.7 }}>⌨</span>
              Keyboard Shortcuts
              <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>⇧?</span>
            </button>
          </div>
          <div style={{ padding: "6px 12px 4px", fontSize: 9, color: "var(--text-tertiary)", borderTop: "1px solid var(--border-primary)", marginTop: 2, letterSpacing: "0.05em" }}>
            ETHER v1.5 · FREE FOREVER
          </div>
        </div>
      </>}
    </div>
  );
}

// ── Live Panel ───────────────────────────────────────────────

function LivePanel({ deckA, deckB, deckC, autoAdv, shuffle, toggleAuto, toggleShuffle, queueLen, showCarts, toggleCarts }: {
  deckA: DeckState | null; deckB: DeckState | null; deckC: DeckState | null;
  autoAdv: boolean; shuffle: boolean;
  toggleAuto: () => void | Promise<void>; toggleShuffle: () => void;
  queueLen: number; showCarts: boolean; toggleCarts: () => void;
}) {
  const [autoXfade, setAutoXfade] = useState(true);
  const [xfadeActive, setXfadeActive] = useState(false);

  const handleXfade = () => {
    const didFire =
      (deckA?.status === "playing" && deckB?.filePath) ? (engine.crossfade("A", "B", 2000), true) :
      (deckB?.status === "playing" && deckA?.filePath) ? (engine.crossfade("B", "A", 2000), true) : false;
    if (didFire) { setXfadeActive(true); setTimeout(() => setXfadeActive(false), 1000); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 12 }}>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", flexShrink: 0, gap: 6 }}>
        <ToolbarBtn label="SHUFFLE" active={shuffle} onClick={toggleShuffle} color="#fbbf24" />
        <ToolbarBtn label={autoAdv ? "AUTO ON" : "AUTO"} active={autoAdv} onClick={() => toggleAuto()} color="#22d3ee" />
        <ToolbarSep />
        <ToolbarBtn label="CARTS" active={showCarts} onClick={toggleCarts} color="#f97316" />
        <ToolbarSep />
        <ToolbarBtn label="AUTO-X" active={autoXfade} onClick={() => { const n = !autoXfade; setAutoXfade(n); engine.outroCrossfade = n; }} color="#a78bfa" />
        <ToolbarBtn label="XFADE" active={xfadeActive} onClick={handleXfade} color="#a78bfa" />
      </div>

      {/* Main layout */}
      <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0, overflow: "hidden" }}>
        {/* Queue */}
        <div style={{ width: 360, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <UpNext queueLen={queueLen} onQueueChange={() => {}} />
        </div>

        {/* Decks + search */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", gap: 10 }}>
          <div style={{ display: "flex", gap: 10, flex: 1, minHeight: 0 }}>
            {[
              { deck: deckA, id: "A" as const, play: () => engine.getDeck("A")?.play(), pause: () => engine.getDeck("A")?.pause(), resume: () => engine.getDeck("A")?.resume(), stop: () => engine.getDeck("A")?.stop(), vol: (v: number) => engine.getDeck("A")?.setVolume(v) },
              { deck: deckB, id: "B" as const, play: () => engine.getDeck("B")?.play(), pause: () => engine.getDeck("B")?.pause(), resume: () => engine.getDeck("B")?.resume(), stop: () => engine.getDeck("B")?.stop(), vol: (v: number) => engine.getDeck("B")?.setVolume(v) },
              { deck: deckC, id: "C" as const, play: () => engine.getDeck("C")?.play(), pause: () => engine.getDeck("C")?.pause(), resume: () => engine.getDeck("C")?.resume(), stop: () => engine.getDeck("C")?.stop(), vol: (v: number) => engine.getDeck("C")?.setVolume(v) },
            ].map(({ deck, id, play, pause, resume, stop, vol }) => {
              const isActive = deck?.status === "playing" || deck?.status === "paused";
              return (
                <div key={id} style={{ flex: isActive ? 2.2 : 1, display: "flex", flexDirection: "column", transition: "flex 0.5s cubic-bezier(0.4,0,0.2,1)", minWidth: 0 }}>
                  <OnAirDeck deck={deck} label={"Deck " + id} deckId={id} onPlay={play} onPause={pause} onResume={resume} onStop={stop} onVolume={vol} />
                </div>
              );
            })}
          </div>

          {/* Search strip */}
          <div style={{ flexShrink: 0, background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border-primary)" }}>
            {showCarts ? <CartWall /> : <JockStrip deckA={deckA} deckB={deckB} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Library Panel ────────────────────────────────────────────

function LibraryPanel({ onLoadA, onLoadB, onQueue }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void; onQueue: (s: SongRow) => void }) {
  const [showImport, setShowImport] = useState(false);
  const [showNexGen, setShowNexGen] = useState(false);
  const [catList, setCatList] = useState<{ id: number; code: string; color: string | null }[]>([]);
  const [songs, setSongs] = useState<SongRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [count, setCount] = useState(0);
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

  const toggleSelect = (id: number) => { setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); };
  const selectAll = () => { setSelectedIds(prev => prev.size === filtered.length ? new Set() : new Set(filtered.map(s => s.id))); };
  const deleteSelected = async () => {
    if (!confirm("Delete " + selectedIds.size + " song(s)?")) return;
    for (const id of selectedIds) await execute("DELETE FROM songs WHERE id=?", [id]);
    setSelectedIds(new Set()); load();
  };
  const deleteAll = async () => {
    if (!confirm("Delete ALL " + count + " songs?")) return;
    await execute("DELETE FROM songs", []); setSelectedIds(new Set()); load();
  };
  const analyzeLufs = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const songs = await query<{id: number, file_path: string}>("SELECT id, file_path FROM songs WHERE file_path IS NOT NULL AND gain_db = 0 LIMIT 50");
    if (songs.length === 0) { setStatus("All songs already analyzed"); setTimeout(() => setStatus(""), 3000); return; }
    setStatus("Analyzing... 0/" + songs.length); let done = 0;
    for (const song of songs) {
      try { const gain = await invoke<number>("analyze_lufs", { filePath: song.file_path }); await execute("UPDATE songs SET gain_db=? WHERE id=?", [gain, song.id]); } catch {}
      done++; setStatus("Analyzing... " + done + "/" + songs.length);
    }
    setStatus("Done! Analyzed " + done + " songs."); setTimeout(() => setStatus(""), 4000);
  };
  const relocateLibrary = async () => {
    const folder = await open({ directory: true, title: "Select new music folder location" });
    if (!folder) return;
    const newBase = (folder as string).replace(/\\/g, "/");
    const broken = await query<{id: number, file_path: string}>("SELECT id, file_path FROM songs WHERE file_path IS NOT NULL");
    let fixed = 0;
    for (const song of broken) {
      const filename = song.file_path.split(/[\/]/).pop();
      if (!filename) continue;
      await execute("UPDATE songs SET file_path=? WHERE id=? AND file_path!=?", [newBase + "/" + filename, song.id, newBase + "/" + filename]); fixed++;
    }
    setStatus("Relocated " + fixed + " songs"); setTimeout(() => setStatus(""), 4000); load();
  };
  const queueAll = () => { engine.addToQueue(filtered.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" }))); };
  const filtered = search ? songs.filter(s => (s.title||"").toLowerCase().includes(search.toLowerCase()) || (s.artist_name||"").toLowerCase().includes(search.toLowerCase())) : songs;

  const S = { // shared inline style shortcuts
    btn: (bg: string, color = "#fff") => ({ padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 600 as any, background: bg, color, border: "none", cursor: "pointer" as any }),
    btnOutline: { padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600 as any, background: "var(--bg-tertiary)", color: "var(--text-tertiary)" as any, border: "1px solid var(--border-primary)", cursor: "pointer" as any },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" as any, gap: 14, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Syne', sans-serif" }}>Song Library</h1>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>{count} tracks</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={relocateLibrary} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer" }}>📁 Relocate</button>
          <button onClick={analyzeLufs} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer" }}>🎚 Normalize</button>
          <button onClick={() => setShowNexGen(!showNexGen)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer" }}>{showNexGen ? "Cancel" : "NexGen / ENCO"}</button>
          <button onClick={() => setShowImport(!showImport)} style={{ padding: "7px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", boxShadow: "0 2px 8px rgba(14,165,233,0.35)" }}>{showImport ? "Cancel" : "＋ Import Music"}</button>
        </div>
      </div>

      {/* Search + filters row */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: "8px 14px" }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.35, flexShrink: 0, color: "var(--text-primary)" }}>
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <input type="text" placeholder="Search songs or artists..." value={search} onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 13, color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif" }} />
          {search && <button onMouseDown={e => { e.preventDefault(); setSearch(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)", fontSize: 16 }}>×</button>}
        </div>
        <select onChange={async (e) => { if (!e.target.value) return; const catId = catList.find(c => c.code === e.target.value)?.id || null; for (const s of filtered) await execute("UPDATE songs SET category_id=? WHERE id=?", [catId, s.id]); e.target.value = ""; load(); }}
          style={{ padding: "8px 12px", borderRadius: 8, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", outline: "none", cursor: "pointer" }}>
          <option value="">Assign category...</option>
          {catList.map(c => <option key={c.id} value={c.code}>All → {c.code}</option>)}
        </select>
        <button onClick={queueAll} style={S.btn("var(--accent-green)", "#000")}>Queue All</button>
        {selectedIds.size > 0 && <button onClick={deleteSelected} style={S.btn("var(--accent-red)")}>Delete {selectedIds.size}</button>}
        <button onClick={deleteAll} style={{ ...S.btnOutline, color: "var(--accent-red)" as any }}>Delete All</button>
      </div>

      {status && <div style={{ padding: "10px 14px", background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 8, fontSize: 12, color: "var(--accent-blue)" }}>{status}</div>}
      {showImport && <ImportDialog onDone={() => { setShowImport(false); load(); }} />}
      {showNexGen && <NexGenImport onDone={() => { setShowNexGen(false); load(); }} />}

      {/* Table */}
      {loading ? (
        <div style={{ fontSize: 13, color: "var(--text-tertiary)", padding: 24 }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center" as any, padding: "64px 24px" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🎵</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>No music yet</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 20 }}>Import a folder to get started</div>
          <button onClick={() => setShowImport(true)} style={S.btn("var(--accent-blue)")}>Import Music Folder</button>
        </div>
      ) : (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as any, fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
                <th style={{ padding: "10px 12px", width: 32 }}><input type="checkbox" checked={selectedIds.size === filtered.length && filtered.length > 0} onChange={selectAll} /></th>
                <th style={{ padding: "10px 6px", width: 36, fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", textAlign: "left" as any }}>#</th>
                <th style={{ padding: "10px 12px", fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", textAlign: "left" as any }}>Title</th>
                <th style={{ padding: "10px 12px", fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", textAlign: "left" as any }}>Artist</th>
                <th style={{ padding: "10px 12px", fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", textAlign: "left" as any, width: 80 }}>Category</th>
                <th style={{ padding: "10px 12px", fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", textAlign: "left" as any, width: 56 }}>Format</th>
                <th style={{ padding: "10px 12px", width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <tr key={s.id}
                  style={{ borderBottom: i < filtered.length - 1 ? "1px solid var(--border-primary)" : "none" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <td style={{ padding: "10px 12px" }}><input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} /></td>
                  <td style={{ padding: "10px 6px", fontSize: 11, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>{i + 1}</td>
                  <td style={{ padding: "10px 12px", color: "var(--text-primary)", fontWeight: 500, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{s.title}</td>
                  <td style={{ padding: "10px 12px", color: "var(--text-secondary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{s.artist_name || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <select value={s.category_code || ""} onChange={async (e) => { const catId = catList.find(c => c.code === e.target.value)?.id || null; await execute("UPDATE songs SET category_id=? WHERE id=?", [catId, s.id]); load(); }}
                      style={{ padding: "3px 6px", borderRadius: 6, fontSize: 11, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", outline: "none", cursor: "pointer" }}>
                      <option value="">—</option>
                      {catList.map(c => <option key={c.id} value={c.code}>{c.code}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: "10px 12px", fontSize: 10, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", textTransform: "uppercase" as any }}>{s.file_path ? fmtExt(s.file_path) : "—"}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right" as any }}>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button onClick={() => onLoadA(s)} style={{ padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "rgba(56,189,248,0.15)", color: "var(--accent-blue)", border: "none", cursor: "pointer" }}>A</button>
                      <button onClick={() => onLoadB(s)} style={{ padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "rgba(52,211,153,0.15)", color: "var(--accent-green)", border: "none", cursor: "pointer" }}>B</button>
                      <button onClick={() => onQueue(s)} style={{ padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Q</button>
                      <button onClick={async () => { if (confirm("Delete " + s.title + "?")) { await execute("DELETE FROM songs WHERE id=?", [s.id]); load(); } }} style={{ padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer" }}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ClockDisplay() {
  const [time, setTime] = useState(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  useEffect(() => {
    const id = setInterval(() => setTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })), 1000);
    return () => clearInterval(id);
  }, []);
  return <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "var(--text-secondary)", letterSpacing: "0.05em" }}>{time}</span>;
}
