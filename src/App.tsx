import UserLogin from "./components/UserLogin";
import KeyboardHelp from "./components/KeyboardHelp";
import EtherLogo from "./components/EtherLogo";
import { UserContext, AppUser, useRole } from "./UserContext";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import React, { useState, useEffect, useRef, useCallback } from "react";
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
import Announcements, { startAnnouncementEngine } from "./components/Announcements";
import FirstRunWizard, { VenueProfile, VENUE_LABELS } from "./components/FirstRunWizard";
import SplashScreen from "./components/SplashScreen";
import MicDeck from "./components/MicDeck";
import TrackEditor from "./components/TrackEditor";
import SubscriptionPanel, { PlanTier } from "./components/SubscriptionPanel";

type Panel = "live" | "library" | "clocks" | "logs" | "spots" | "voicetrack" | "announce" | "streaming" | "settings" | "showprep" | "trackedit" | "subscription";

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

// ── SVG icons for Nav items ──────────────────────────────────
const NAV_ICONS: Record<string, JSX.Element> = {
  live:         <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>,
  library:      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>,
  clocks:       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  logs:         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>,
  spots:        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>,
  voicetrack:   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>,
  showprep:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  announce:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg>,
  streaming:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  trackedit:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="14 2 14 8 20 8"/><path d="M20 12V8l-6-6H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h6"/><line x1="10" y1="15" x2="20" y2="5"/><line x1="17" y1="2" x2="22" y2="7"/></svg>,
  subscription: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  settings:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  keyboard:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>,
  podcast:      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>,
};

export default function App() {
  const [splashDone, setSplashDone] = useState(false);
  const [wizardDone, setWizardDone] = useState(false);
  const [firstRunChecked, setFirstRunChecked] = useState(false);
  const [stationName, setStationName] = useState("Ether");
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [currentPlan, setCurrentPlan] = useState<PlanTier>("free");
  const [panel, setPanel] = useState<Panel>("live");
  const [onAir, setOnAir] = useState(false);
  const [deckA, setDeckA] = useState<DeckState | null>(null);
  const [deckB, setDeckB] = useState<DeckState | null>(null);
  const [deckC, setDeckC] = useState<DeckState | null>(null);
  const [autoAdv, setAutoAdv] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [queueLen, setQueueLen] = useState(0);
  const [darkMode, setDarkMode] = useState(false);
  const [showCarts, setShowCarts] = useState(false);
  const [outputDevice, setOutputDevice] = useState("");
  const [inputDevice, setInputDevice] = useState("");
  const [editSong, setEditSong] = useState<any>(null);

  // Check if first run is complete
  useEffect(() => {
    (async () => {
      try {
        const rows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'first_run_complete'");
        if (rows.length > 0 && rows[0].value === "1") setWizardDone(true);
        const nameRows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'station_name'");
        if (nameRows.length > 0 && nameRows[0].value) setStationName(nameRows[0].value);
        const planRows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'plan_tier'");
        if (planRows.length > 0) setCurrentPlan(planRows[0].value as PlanTier);
      } catch {}
      setFirstRunChecked(true);
    })();
  }, []);

  const handleWizardComplete = (profile: VenueProfile) => {
    setStationName(profile.name);
    setWizardDone(true);
  };

  useEffect(() => {
    (globalThis as any).__etherEngine = engine;
    const addCol = async (col: string) => {
      try { await execute(`ALTER TABLE songs ADD COLUMN ${col} REAL DEFAULT 0`, []); } catch {}
    };
    addCol("cue_in"); addCol("cue_out"); addCol("intro_end"); addCol("outro_start");
    return engine.onPlayStart(async (deckId, title, artist, _filePath) => {
      try { await execute("INSERT INTO play_log (title, artist, deck, played_at) VALUES (?, ?, ?, unixepoch())", [title, artist, deckId]); }
      catch (e) { console.error('Log write error:', e); }
    });
  }, []);

  useEffect(() => {
    const unlisten = listen("now-playing-request", async () => {
      const dA = engine.getDeck("A");
      const stA = dA?.getState();
      let widget = "upcoming";
      try {
        const rows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'nowplaying_widget'");
        if (rows.length > 0) widget = rows[0].value;
      } catch {}
      emit("now-playing-update", {
        title: stA?.title || "Ether Radio", artist: stA?.artist || "",
        position: stA?.positionSec || 0, duration: stA?.durationSec || 0,
        widget,
        upcoming: engine.getQueue().slice(0, 10).map(q => ({ title: q.title, artist: q.artist, duration: 0 })),
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
        const dA = engine.getDeck('A')?.getState();
        await execute("UPDATE crash_recovery SET queue_json=?, deck_a_path=?, deck_a_title=?, deck_a_artist=?, deck_a_position=?, was_playing=?, saved_at=unixepoch() WHERE id=1",
          [JSON.stringify(queue), dA?.filePath || null, dA?.title || null, dA?.artist || null, dA?.positionSec || 0, dA?.status === 'playing' ? 1 : 0]);
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

  if (!splashDone) return <SplashScreen onDone={() => setSplashDone(true)} />;
  if (firstRunChecked && !wizardDone) return <FirstRunWizard onComplete={handleWizardComplete} />;
  if (!currentUser) return <UserLogin onLogin={setCurrentUser} />;

  return (
    <div className={"h-screen flex flex-col " + (darkMode ? "dark-theme" : "")} style={{ background: "var(--bg-primary)", color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <KeyboardHelp />

      {/* ── Header ── */}
      <header style={{ height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <Nav active={panel} set={setPanel} />
          <div style={{ width: 1, height: 24, background: "var(--border-primary)", margin: "0 20px" }} />

          {/* ── New logo ── */}
          <EtherLogo size={28} />
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
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "4px 10px", background: "var(--bg-tertiary)", borderRadius: 6, display: "flex", alignItems: "center", gap: 5 }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, opacity: 0.5 }}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
              {nowPlayingTitle}
            </div>
          )}
          <ClockDisplay />
          <button onClick={() => setDarkMode(!darkMode)} style={{ width: 32, height: 32, borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {darkMode ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            )}
          </button>
          <button onClick={() => openNowPlayingWindow()} style={{ height: 32, padding: "0 12px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" as any }}>
            NOW PLAYING
          </button>
          {currentPlan === "free" && (
            <button onClick={() => setPanel("subscription")} style={{
              height: 32, padding: "0 12px", borderRadius: 8,
              background: "#7c3aed", border: "none",
              color: "#fff", cursor: "pointer",
              fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
              display: "flex", alignItems: "center", gap: 5,
              textTransform: "uppercase" as any,
            }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              Upgrade
            </button>
          )}
          <button onClick={() => setCurrentUser(null)} style={{ height: 32, padding: "0 12px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            {currentUser?.name}
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
              <LivePanel deckA={deckA} deckB={deckB} deckC={deckC} autoAdv={autoAdv} shuffle={shuffle} toggleAuto={toggleAuto} toggleShuffle={toggleShuffle} queueLen={queueLen} showCarts={showCarts} toggleCarts={() => setShowCarts(!showCarts)} inputDevice={inputDevice} />
            </div>
          )}
          {panel !== "live" && (
            <div style={{ flex: 1, overflowY: "auto" }}>
              {panel === "library" && <LibraryPanel onLoadA={loadA} onLoadB={loadB} onQueue={addToQueue} onEdit={(s) => { setEditSong(s); setPanel("trackedit"); }} />}
              {panel === "clocks" && <Scheduler />}
              {panel === "logs" && <Logs />}
              {panel === "spots" && <Spots />}
              {panel === "streaming" && <StreamManager />}
              {panel === "announce" && <Announcements />}
              {panel === "voicetrack" && <VoiceTracker inputDeviceId={inputDevice || undefined} />}
              {panel === "showprep" && <ShowPrep onGoLive={() => setPanel("live")} />}
              {panel === "settings" && <SettingsPanel />}
              {panel === "trackedit" && <TrackEditor song={editSong} onClose={() => setPanel("library")} />}
              {panel === "subscription" && <SubscriptionPanel />}
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
  const [venueType, setVenueType] = useState<string>("radio");

  useEffect(() => {
    query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'venue_type'")
      .then(rows => { if (rows.length > 0) setVenueType(rows[0].value); })
      .catch(() => {});
  }, []);

  const labels: Record<string, Record<string, string>> = {
    radio:   { library: "Song Library", spots: "Spots & Promos", clocks: "Program Clock", logs: "Play Log", voicetrack: "Voice Track", live: "Live Assist" },
    venue:   { library: "Music Library", spots: "Announcements", clocks: "Event Schedule", logs: "Activity Log", voicetrack: "Voice Track", live: "Live Assist" },
    retail:  { library: "Music Library", spots: "Store Messages", clocks: "Playlist Schedule", logs: "Playback Log", voicetrack: "Voice Track", live: "Live Assist" },
    worship: { library: "Worship Library", spots: "Ministry Audio", clocks: "Service Schedule", logs: "Service Log", voicetrack: "Voice Track", live: "Live Assist" },
    podcast: { library: "Episode Library", spots: "Sponsorships", clocks: "Release Schedule", logs: "Episode Log", voicetrack: "Podcast Studio", live: "Live Assist" },
  };
  const L = labels[venueType] || labels.radio;

  const primaryItems: { id: Panel; label: string; iconKey: string }[] = [
    { id: "live",       label: L.live,       iconKey: "live" },
    { id: "library",    label: L.library,    iconKey: "library" },
    { id: "clocks",     label: L.clocks,     iconKey: "clocks" },
    { id: "logs",       label: L.logs,       iconKey: "logs" },
    { id: "spots",      label: L.spots,      iconKey: "spots" },
    { id: "voicetrack", label: L.voicetrack, iconKey: "voicetrack" },
    { id: "showprep",   label: "Show Prep",  iconKey: "showprep" },
  ];

  const extraItems: { id: Panel; label: string; iconKey: string; badge?: string }[] = [
    { id: "announce",     label: "Announcements", iconKey: "announce" },
    { id: "streaming",    label: "Streaming",     iconKey: "streaming" },
    { id: "trackedit",    label: "Track Editor",  iconKey: "trackedit",    badge: "CUE" },
    { id: "subscription", label: "Subscription",  iconKey: "subscription" },
    ...(venueType !== "podcast" ? [{ id: "voicetrack" as Panel, label: "Podcast Studio", iconKey: "podcast", badge: "NEW" }] : []),
    { id: "settings",     label: "Settings",      iconKey: "settings" },
  ];

  const allItems = [...primaryItems, ...extraItems];
  const current = allItems.find(i => i.id === active) || primaryItems[0];

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", height: 36, background: open ? "var(--bg-tertiary)" : "transparent", border: "1px solid " + (open ? "var(--border-secondary)" : "var(--border-primary)"), borderRadius: 9, color: "var(--text-primary)", cursor: "pointer", fontSize: 12, fontWeight: 500 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ opacity: 0.6 }}><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        <span>{current?.label || "Menu"}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ opacity: 0.4 }}>
          {open ? <polygon points="0,6 4,2 8,6"/> : <polygon points="0,2 4,6 8,2"/>}
        </svg>
      </button>
      {open && <>
        <div style={{ position: "fixed", inset: 0, zIndex: 98 }} onClick={() => setOpen(false)} />
        <div style={{ position: "absolute", top: "calc(100% + 8px)", left: 0, zIndex: 99, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 14, boxShadow: "var(--shadow-lg)", minWidth: 230, overflow: "hidden", padding: "6px" }}>

          {primaryItems.map(i => (
            <button key={i.id + i.label} onClick={() => { set(i.id); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", textAlign: "left" as any, fontSize: 13, fontWeight: active === i.id ? 600 : 400, color: active === i.id ? "#22d3ee" : "var(--text-secondary)", background: active === i.id ? "rgba(34,211,238,0.08)" : "transparent", border: "none", borderRadius: 9, cursor: "pointer" }}>
              <span style={{ width: 20, display: "flex", justifyContent: "center", opacity: 0.7, color: active === i.id ? "#22d3ee" : "var(--text-secondary)" }}>{NAV_ICONS[i.iconKey]}</span>
              {i.label}
              {active === i.id && <div style={{ marginLeft: "auto", width: 5, height: 5, borderRadius: "50%", background: "#22d3ee" }} />}
            </button>
          ))}

          <div style={{ borderTop: "1px solid var(--border-primary)", margin: "6px 0", padding: "6px 12px 4px" }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "var(--text-tertiary)", textTransform: "uppercase" as any }}>More Features</span>
          </div>

          {extraItems.map(i => (
            <button key={i.id + i.label} onClick={() => { set(i.id); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", textAlign: "left" as any, fontSize: 13, fontWeight: active === i.id ? 600 : 400, color: active === i.id ? "#22d3ee" : "var(--text-secondary)", background: active === i.id ? "rgba(34,211,238,0.08)" : "transparent", border: "none", borderRadius: 9, cursor: "pointer" }}>
              <span style={{ width: 20, display: "flex", justifyContent: "center", opacity: 0.7, color: active === i.id ? "#22d3ee" : "var(--text-secondary)" }}>{NAV_ICONS[i.iconKey]}</span>
              {i.label}
              {i.badge && <span style={{ marginLeft: 6, fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", background: "rgba(167,139,250,0.2)", color: "#a78bfa", padding: "2px 6px", borderRadius: 4 }}>{i.badge}</span>}
              {active === i.id && <div style={{ marginLeft: "auto", width: 5, height: 5, borderRadius: "50%", background: "#22d3ee" }} />}
            </button>
          ))}

          <div style={{ borderTop: "1px solid var(--border-primary)", marginTop: 6, paddingTop: 6 }}>
            <button
              onClick={() => { setOpen(false); window.dispatchEvent(new KeyboardEvent("keydown", { code: "Slash", shiftKey: true })); }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", textAlign: "left" as any, fontSize: 13, fontWeight: 400, color: "var(--text-secondary)", background: "transparent", border: "none", borderRadius: 9, cursor: "pointer" }}
            >
              <span style={{ width: 20, display: "flex", justifyContent: "center", opacity: 0.7 }}>{NAV_ICONS.keyboard}</span>
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

// ── Drag handle icon ────────────────────────────────────────
function DragHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      title="Drag to reorder panels"
      style={{
        cursor: "grab", padding: "4px 6px", borderRadius: 6, flexShrink: 0,
        color: "var(--text-tertiary)", display: "flex", alignItems: "center",
        transition: "color 0.15s, background 0.15s",
        userSelect: "none",
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="9" cy="5" r="1" fill="currentColor" stroke="none"/>
        <circle cx="15" cy="5" r="1" fill="currentColor" stroke="none"/>
        <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/>
        <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none"/>
        <circle cx="9" cy="19" r="1" fill="currentColor" stroke="none"/>
        <circle cx="15" cy="19" r="1" fill="currentColor" stroke="none"/>
      </svg>
    </div>
  );
}

function LivePanel({ deckA, deckB, deckC, autoAdv, shuffle, toggleAuto, toggleShuffle, queueLen, showCarts, toggleCarts, inputDevice }: {
  deckA: DeckState | null; deckB: DeckState | null; deckC: DeckState | null;
  autoAdv: boolean; shuffle: boolean;
  toggleAuto: () => void | Promise<void>; toggleShuffle: () => void;
  queueLen: number; showCarts: boolean; toggleCarts: () => void;
  inputDevice: string;
}) {
  const [autoXfade, setAutoXfade] = useState(true);
  const [xfadeActive, setXfadeActive] = useState(false);
  // Panel widths — resizable via drag divider
  const [queueWidth, setQueueWidth] = useState(360);
  const resizingRef = useRef(false);

  const startResizeQueue = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = queueWidth;
    resizingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      // If queue is on the left, dragging right = wider; if on the right, dragging left = wider
      const dir = panelOrder[0] === "queue" ? 1 : -1;
      const next = Math.max(220, Math.min(560, startW + (ev.clientX - startX) * dir));
      setQueueWidth(next);
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Deck column widths — resizable. null = flex (auto). number = fixed px.
  const [deckWidths, setDeckWidths] = useState<Record<string, number | null>>({ A: null, B: null, C: null, mic: 185 });

  const startResizeDeck = (leftSlot: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    // Snapshot current rendered widths of all slots
    const items = Array.from(deckRowRef.current?.querySelectorAll("[data-deck-slot]") ?? []);
    const leftEl = items.find(el => (el as HTMLElement).dataset.deckSlot === leftSlot) as HTMLElement | undefined;
    const rightIdx = deckOrder.indexOf(leftSlot as any) + 1;
    const rightSlot = deckOrder[rightIdx];
    const rightEl = items.find(el => (el as HTMLElement).dataset.deckSlot === rightSlot) as HTMLElement | undefined;
    const startLeft = leftEl?.getBoundingClientRect().width ?? 200;
    const startRight = rightEl?.getBoundingClientRect().width ?? 200;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newLeft = Math.max(160, startLeft + delta);
      const newRight = Math.max(160, startRight - delta);
      setDeckWidths(prev => ({ ...prev, [leftSlot]: newLeft, [rightSlot]: newRight }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // "queue" | "decks" — user can swap their horizontal order
  const [panelOrder, setPanelOrder] = useState<["queue" | "decks", "queue" | "decks"]>(["queue", "decks"]);
  const [dragging, setDragging] = useState<"queue" | "decks" | null>(null);
  const [dropTarget, setDropTarget] = useState<"queue" | "decks" | null>(null);
  const dragStartXRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Individual deck order — A, B, C, mic can be dragged to any position
  type DeckSlot = "A" | "B" | "C" | "mic";
  const [deckOrder, setDeckOrder] = useState<DeckSlot[]>(["A", "B", "C", "mic"]);
  const [draggingDeck, setDraggingDeck] = useState<DeckSlot | null>(null);
  const [dropDeck, setDropDeck] = useState<DeckSlot | null>(null);
  const deckRowRef = useRef<HTMLDivElement>(null);

  const startDeckDrag = (slot: DeckSlot) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingDeck(slot);

    const onMouseMove = (ev: MouseEvent) => {
      if (!deckRowRef.current) return;
      const items = Array.from(deckRowRef.current.querySelectorAll("[data-deck-slot]"));
      let target: DeckSlot | null = null;
      for (const el of items) {
        const rect = el.getBoundingClientRect();
        if (ev.clientX >= rect.left && ev.clientX <= rect.right) {
          target = (el as HTMLElement).dataset.deckSlot as DeckSlot;
          break;
        }
      }
      setDropDeck(target && target !== slot ? target : null);
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      setDraggingDeck(null);
      setDropDeck(cur => {
        if (cur && cur !== slot) {
          setDeckOrder(prev => {
            const next = [...prev];
            const from = next.indexOf(slot);
            const to = next.indexOf(cur);
            next.splice(from, 1);
            next.splice(to, 0, slot);
            return next;
          });
        }
        return null;
      });
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const handleXfade = () => {
    const didFire =
      (deckA?.status === "playing" && deckB?.filePath) ? (engine.crossfade("A", "B", 2000), true) :
      (deckB?.status === "playing" && deckA?.filePath) ? (engine.crossfade("B", "A", 2000), true) : false;
    if (didFire) { setXfadeActive(true); setTimeout(() => setXfadeActive(false), 1000); }
  };

  const startDrag = (panel: "queue" | "decks") => (e: React.MouseEvent) => {
    e.preventDefault();
    dragStartXRef.current = e.clientX;
    setDragging(panel);

    const onMouseMove = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      // whichever half of the container the cursor is in = drop target
      const hovering = ev.clientX < mid ? panelOrder[0] : panelOrder[1];
      setDropTarget(hovering !== panel ? hovering : null);
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      setDragging(null);
      setDropTarget(dt => {
        if (dt && dt !== panel) {
          setPanelOrder(prev => [prev[1], prev[0]]);
        }
        return null;
      });
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const queuePanel = (
    <div
      key="queue"
      style={{
        width: queueWidth, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden",
        opacity: dragging === "queue" ? 0.55 : 1,
        outline: dropTarget === "queue" ? "2px solid #38bdf8" : "none",
        outlineOffset: 2, borderRadius: 14,
        transition: "opacity 0.15s, outline 0.1s",
      }}
    >
      <UpNext queueLen={queueLen} onQueueChange={() => {}} />
    </div>
  );

  const decksPanel = (
    <div
      key="decks"
      style={{
        flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", gap: 10,
        opacity: dragging === "decks" ? 0.55 : 1,
        outline: dropTarget === "decks" ? "2px solid #38bdf8" : "none",
        outlineOffset: 2, borderRadius: 14,
        transition: "opacity 0.15s, outline 0.1s",
      }}
    >
      <div ref={deckRowRef} style={{ display: "flex", gap: 0, flex: 1, minHeight: 0, cursor: draggingDeck ? "grabbing" : "auto" }}>
        {deckOrder.map((slot, i) => {
          const isDragging = draggingDeck === slot;
          const isDropTarget = dropDeck === slot;
          const hasRight = i < deckOrder.length - 1;
          const fixedW = deckWidths[slot];

          const divider = hasRight ? (
            <div
              onMouseDown={startResizeDeck(slot)}
              style={{
                width: 8, flexShrink: 0, cursor: "col-resize",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <div style={{
                width: 3, height: 32, borderRadius: 2,
                background: "var(--border-secondary)",
                pointerEvents: "none",
                transition: "background 0.15s, height 0.15s",
              }}
                onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = "var(--accent-blue)"; el.style.height = "50px"; }}
                onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "var(--border-secondary)"; el.style.height = "32px"; }}
              />
            </div>
          ) : null;

          if (slot === "mic") {
            return (
              <React.Fragment key="mic">
                <div
                  data-deck-slot="mic"
                  style={{
                    width: fixedW ?? 185, flexShrink: 0, display: "flex", flexDirection: "column",
                    opacity: isDragging ? 0.45 : 1,
                    outline: isDropTarget ? "2px solid #38bdf8" : "none",
                    outlineOffset: 2, borderRadius: 18,
                    transition: "opacity 0.15s, outline 0.1s",
                  }}
                >
                  <MicDeck inputDeviceId={inputDevice || undefined} onDragStart={startDeckDrag("mic")} />
                </div>
                {divider}
              </React.Fragment>
            );
          }
          const deckMap = { A: deckA, B: deckB, C: deckC };
          const deck = deckMap[slot as "A"|"B"|"C"];
          const isActive = deck?.status === "playing" || deck?.status === "paused";
          const play    = () => engine.getDeck(slot)?.play();
          const pause   = () => engine.getDeck(slot)?.pause();
          const resume  = () => engine.getDeck(slot)?.resume();
          const stop    = () => engine.getDeck(slot)?.stop();
          const vol     = (v: number) => engine.getDeck(slot)?.setVolume(v);

          // If user has manually set a width, use it; otherwise use flex expansion
          const sizeStyle = fixedW !== null
            ? { width: fixedW, flexShrink: 0 }
            : { flex: isActive ? 2.2 : 1, transition: "flex 0.5s cubic-bezier(0.4,0,0.2,1)" };

          return (
            <React.Fragment key={slot}>
              <div
                data-deck-slot={slot}
                style={{
                  ...sizeStyle, display: "flex", flexDirection: "column", minWidth: 0,
                  opacity: isDragging ? 0.45 : 1,
                  outline: isDropTarget ? "2px solid #38bdf8" : "none",
                  outlineOffset: 2, borderRadius: 18,
                }}
              >
                <OnAirDeck deck={deck} label={"Deck " + slot} deckId={slot as "A"|"B"|"C"} onPlay={play} onPause={pause} onResume={resume} onStop={stop} onVolume={vol} onDragStart={startDeckDrag(slot as DeckSlot)} />
              </div>
              {divider}
            </React.Fragment>
          );
        })}
      </div>

      {/* Cart wall — only shown when CARTS mode active */}
      {showCarts && (
        <div style={{ flexShrink: 0, background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border-primary)" }}>
          <CartWall />
        </div>
      )}
    </div>
  );

  const panels: Record<string, JSX.Element> = { queue: queuePanel, decks: decksPanel };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 12 }}>

      {/* Toolbar + inline search */}
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0, gap: 6 }}>
        <ToolbarBtn label="SHUFFLE" active={shuffle} onClick={toggleShuffle} color="#fbbf24" />
        <ToolbarBtn label={autoAdv ? "AUTO ON" : "AUTO"} active={autoAdv} onClick={() => toggleAuto()} color="#22d3ee" />
        <ToolbarSep />
        <ToolbarBtn label="CARTS" active={showCarts} onClick={toggleCarts} color="#f97316" />
        <ToolbarSep />
        <ToolbarBtn label="AUTO-X" active={autoXfade} onClick={() => { const n = !autoXfade; setAutoXfade(n); engine.outroCrossfade = n; }} color="#a78bfa" />
        <ToolbarBtn label="XFADE" active={xfadeActive} onClick={handleXfade} color="#a78bfa" />
        <ToolbarSep />
        {/* Search lives here — results open downward */}
        <div style={{ flex: 1, minWidth: 0, position: "relative" as const }}>
          {!showCarts && <JockStrip deckA={deckA} deckB={deckB} dropDown />}
        </div>
      </div>

      {/* Main layout — drag-reorderable + resizable */}
      <div
        ref={containerRef}
        style={{
          display: "flex", gap: 0, flex: 1, minHeight: 0, overflow: "hidden",
          cursor: dragging ? "grabbing" : resizingRef.current ? "col-resize" : "auto",
        }}
      >
        {panelOrder.map((p, i) => (
          <React.Fragment key={p}>
            {panels[p]}
            {i < panelOrder.length - 1 && (
              <div
                onMouseDown={startResizeQueue}
                style={{
                  width: 10, flexShrink: 0, cursor: "col-resize",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  position: "relative",
                }}
              >
                <div style={{
                  width: 3, height: 40, borderRadius: 2,
                  background: "var(--border-secondary)",
                  transition: "background 0.15s, height 0.15s",
                  pointerEvents: "none",
                }}
                  onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = "var(--accent-blue)"; el.style.height = "60px"; }}
                  onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "var(--border-secondary)"; el.style.height = "40px"; }}
                />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// ── Library Panel ────────────────────────────────────────────

function LibraryPanel({ onLoadA, onLoadB, onQueue, onEdit }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void; onQueue: (s: SongRow) => void; onEdit: (s: SongRow) => void }) {
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

  const S = {
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
          <button onClick={relocateLibrary} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            Relocate
          </button>
          <button onClick={analyzeLufs} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
            Normalize
          </button>
          <button onClick={() => setShowNexGen(!showNexGen)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer" }}>{showNexGen ? "Cancel" : "NexGen / ENCO"}</button>
          <button onClick={() => setShowImport(!showImport)} style={{ padding: "7px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", boxShadow: "0 2px 8px rgba(14,165,233,0.35)" }}>{showImport ? "Cancel" : "+ Import Music"}</button>
        </div>
      </div>

      {/* Search + filters row */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: "8px 14px" }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.35, flexShrink: 0, color: "var(--text-primary)" }}>
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <input type="text" placeholder="Quick search — type to find a song..." value={search} onChange={e => setSearch(e.target.value)}
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
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, opacity: 0.4 }}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
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
                      <button onClick={() => onEdit(s)} style={{ padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "rgba(167,139,250,0.15)", color: "#a78bfa", border: "none", cursor: "pointer" }} title="Edit cue points">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="10" y1="15" x2="20" y2="5"/><line x1="17" y1="2" x2="22" y2="7"/><polyline points="20 12 20 22 4 22 4 6 14 6"/></svg>
                      </button>
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
