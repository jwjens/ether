const fs = require('fs');

// 1. Rewrite NowPlaying.tsx to use Tauri events instead of engine
fs.writeFileSync('src/components/NowPlaying.tsx', `import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

interface TrackInfo {
  title: string;
  artist: string;
  positionSec: number;
  durationSec: number;
  isPlaying: boolean;
}

function fmtTime(s: number) {
  if (!s || s < 0) return "0:00";
  return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
}

async function fetchAlbumArt(artist: string, title: string): Promise<string | null> {
  try {
    const q = encodeURIComponent(artist + " " + title);
    const r = await fetch("https://itunes.apple.com/search?term=" + q + "&media=music&limit=1");
    const d = await r.json();
    if (d.results && d.results[0] && d.results[0].artworkUrl100) {
      return d.results[0].artworkUrl100.replace("100x100bb", "600x600bb");
    }
  } catch {}
  return null;
}

export default function NowPlaying({ onExit }: { onExit?: () => void }) {
  const [track, setTrack] = useState<TrackInfo>({ title: "Ether Radio", artist: "", positionSec: 0, durationSec: 0, isPlaying: false });
  const [time, setTime] = useState(new Date());
  const [albumArt, setAlbumArt] = useState<string | null>(null);
  const [lastTrack, setLastTrack] = useState("");

  useEffect(() => {
    // Listen for track updates from main window
    const unlisten = listen<TrackInfo>("now-playing-update", (event) => {
      setTrack(event.payload);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Fetch album art when track changes
  useEffect(() => {
    const key = track.artist + "|" + track.title;
    if (key === lastTrack) return;
    setLastTrack(key);
    if (track.artist && track.title && track.title !== "Ether Radio") {
      fetchAlbumArt(track.artist, track.title).then(setAlbumArt);
    } else {
      setAlbumArt(null);
    }
  }, [track.artist, track.title]);

  const { title, artist, positionSec: pos, durationSec: dur, isPlaying } = track;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;
  const timeStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateStr = time.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  const handleClose = async () => {
    if (onExit) { onExit(); return; }
    try { await getCurrentWindow().close(); } catch {}
  };

  return (
    <div className="fixed inset-0 select-none overflow-hidden" style={{ background: "#000", color: "#fff" }}>
      {albumArt && (
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage: "url(" + albumArt + ")",
          backgroundSize: "cover", backgroundPosition: "center",
          filter: "blur(60px) brightness(0.3) saturate(1.5)",
          transform: "scale(1.1)", zIndex: 0
        }} />
      )}
      <div style={{ position: "relative", zIndex: 1, height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "28px 48px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ fontSize: 32, fontWeight: 300, letterSpacing: "-0.04em" }}>
              <span style={{ color: "#60a5fa" }}>Eth</span>
              <span style={{ color: "#fff" }}>er</span>
            </span>
            {isPlaying && (
              <span style={{ padding: "3px 10px", background: "#dc2626", borderRadius: 6, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em" }}>
                ON AIR
              </span>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 48, fontFamily: "monospace", fontWeight: 700 }}>{timeStr}</div>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.5)" }}>{dateStr}</div>
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 64, padding: "0 80px" }}>
          {albumArt && (
            <img src={albumArt} alt="Album art"
              style={{ width: 280, height: 280, borderRadius: 16, boxShadow: "0 32px 80px rgba(0,0,0,0.8)", flexShrink: 0 }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", letterSpacing: "0.2em", textTransform: "uppercase" as any, marginBottom: 12 }}>
              {isPlaying ? "Now Playing" : "Up Next"}
            </div>
            <div style={{ fontSize: albumArt ? 52 : 72, fontWeight: 700, lineHeight: 1.1, marginBottom: 12, wordBreak: "break-word" as any }}>
              {title}
            </div>
            {artist && (
              <div style={{ fontSize: albumArt ? 28 : 36, color: "rgba(255,255,255,0.6)", marginBottom: 40 }}>
                {artist}
              </div>
            )}
            {dur > 0 && (
              <div style={{ maxWidth: 600 }}>
                <div style={{ height: 4, background: "rgba(255,255,255,0.15)", borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
                  <div style={{ height: "100%", width: pct + "%", background: "#60a5fa", borderRadius: 2, transition: "width 0.5s linear" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, fontFamily: "monospace", color: "rgba(255,255,255,0.4)" }}>
                  <span>{fmtTime(pos)}</span>
                  <span>-{fmtTime(dur - pos)}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: "0 48px 28px", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={handleClose}
            style={{ padding: "8px 20px", background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8, color: "rgba(255,255,255,0.6)", fontSize: 12, cursor: "pointer" }}>
            CLOSE
          </button>
        </div>
      </div>
    </div>
  );
}
`);

console.log('NowPlaying.tsx written');
console.log('');
console.log('Now you need to emit events from App.tsx engine listener.');
console.log('Run fix-nowplaying-emitter.js next.');
