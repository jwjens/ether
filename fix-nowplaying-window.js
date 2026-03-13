const fs = require('fs');
let ok = 0, fail = 0;
function write(p, c) {
  try { fs.mkdirSync(require('path').dirname(p), {recursive:true}); fs.writeFileSync(p, c, 'utf8'); console.log('WROTE ' + p); ok++; }
  catch(e) { console.error('FAIL ' + p + ': ' + e.message); fail++; }
}

// 1. NowPlaying.tsx — standalone window component (no onExit prop needed)
write('src/components/NowPlaying.tsx', `import { useState, useEffect } from "react";
import { engine, DeckState } from "../audio/engine";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface RecentPlay { title: string; artist: string | null; played_at: number; }

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
  const [deckA, setDeckA] = useState<DeckState | null>(null);
  const [deckB, setDeckB] = useState<DeckState | null>(null);
  const [time, setTime] = useState(new Date());
  const [albumArt, setAlbumArt] = useState<string | null>(null);
  const [lastTrack, setLastTrack] = useState("");

  useEffect(() => {
    engine.init();
    const unsub = engine.on((id, st) => {
      if (id === "A") setDeckA({ ...st });
      else setDeckB({ ...st });
    });
    return unsub;
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const active = deckA?.status === "playing" ? deckA
    : deckB?.status === "playing" ? deckB
    : deckA?.title ? deckA : deckB;
  const title = active?.title || "Ether Radio";
  const artist = active?.artist || "";
  const pos = active?.positionSec || 0;
  const dur = active?.durationSec || 0;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;
  const isPlaying = active?.status === "playing";
  const timeStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateStr = time.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  // Fetch album art when track changes
  useEffect(() => {
    const key = artist + "|" + title;
    if (key === lastTrack) return;
    setLastTrack(key);
    if (artist && title && title !== "Ether Radio") {
      fetchAlbumArt(artist, title).then(setAlbumArt);
    } else {
      setAlbumArt(null);
    }
  }, [artist, title]);

  const handleClose = async () => {
    if (onExit) { onExit(); return; }
    try { await getCurrentWindow().close(); } catch {}
  };

  return (
    <div className="fixed inset-0 select-none overflow-hidden" style={{ background: "#000", color: "#fff" }}>
      {/* Blurred album art background */}
      {albumArt && (
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage: "url(" + albumArt + ")",
          backgroundSize: "cover", backgroundPosition: "center",
          filter: "blur(60px) brightness(0.3) saturate(1.5)",
          transform: "scale(1.1)",
          zIndex: 0
        }} />
      )}
      <div style={{ position: "relative", zIndex: 1, height: "100%", display: "flex", flexDirection: "column" }}>

        {/* Top bar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "28px 48px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ fontSize: 32, fontWeight: 300, letterSpacing: "-0.04em" }}>
              <span style={{ color: "#60a5fa" }}>Eth</span>
              <span style={{ color: "#fff" }}>er</span>
            </span>
            {isPlaying && (
              <span style={{ padding: "3px 10px", background: "#dc2626", borderRadius: 6, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", animation: "pulse 2s infinite" }}>
                ON AIR
              </span>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 48, fontFamily: "monospace", fontWeight: 700 }}>{timeStr}</div>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.5)" }}>{dateStr}</div>
          </div>
        </div>

        {/* Center — album art + info */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 64, padding: "0 80px" }}>
          {albumArt && (
            <img src={albumArt} alt="Album art"
              style={{ width: 280, height: 280, borderRadius: 16, boxShadow: "0 32px 80px rgba(0,0,0,0.8)", flexShrink: 0 }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 12 }}>
              {isPlaying ? "Now Playing" : "Up Next"}
            </div>
            <div style={{ fontSize: albumArt ? 52 : 72, fontWeight: 700, lineHeight: 1.1, marginBottom: 12, wordBreak: "break-word" }}>
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

        {/* Close button */}
        <div style={{ padding: "0 48px 28px", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={handleClose}
            style={{ padding: "8px 20px", background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8, color: "rgba(255,255,255,0.6)", fontSize: 12, cursor: "pointer" }}>
            CLOSE
          </button>
        </div>
      </div>
      <style>{"\`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }\`"}</style>
    </div>
  );
}
`);

// 2. NowPlayingWindow.tsx — thin wrapper that opens a Tauri window
write('src/components/NowPlayingWindow.tsx', `import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export async function openNowPlayingWindow() {
  const existing = await WebviewWindow.getByLabel("nowplaying");
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow("nowplaying", {
    url: "/#nowplaying",
    title: "Ether — Now Playing",
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    resizable: true,
    decorations: true,
    alwaysOnTop: false,
    focus: true,
  });
}
`);

// 3. Patch App.tsx — replace setShowNowPlaying with openNowPlayingWindow
let app = fs.readFileSync('src/App.tsx', 'utf8');

// Add import for openNowPlayingWindow
if (!app.includes('openNowPlayingWindow')) {
  app = app.replace(
    'import NowPlaying from "./components/NowPlaying";',
    'import NowPlaying from "./components/NowPlaying";\nimport { openNowPlayingWindow } from "./components/NowPlayingWindow";'
  );
}

// Replace the NOW PLAYING button to use openNowPlayingWindow
app = app.replace(
  /onClick=\{[^}]*setShowNowPlaying\(true\)[^}]*\}[^>]*>NOW PLAYING<\/button>/,
  'onClick={() => openNowPlayingWindow()} style={{ padding: "4px 12px", background: "var(--bg-tertiary)", border: "none", borderRadius: 6, fontSize: 10, fontWeight: 700, color: "var(--text-secondary)", cursor: "pointer", letterSpacing: "0.05em" }}>NOW PLAYING</button>'
);

// Remove the overlay render (showNowPlaying && <NowPlaying .../>)
app = app.replace(
  /\{showNowPlaying && <NowPlaying onExit=\{[^}]+\} \/>\}/,
  '{/* Now Playing opens as separate window via openNowPlayingWindow() */}'
);

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('PATCHED src/App.tsx');
ok++;

// 4. main.tsx — render NowPlaying component when hash is #nowplaying
let main = fs.readFileSync('src/main.tsx', 'utf8');
if (!main.includes('nowplaying')) {
  main = main.replace(
    /ReactDOM\.createRoot[^;]+;[\s\S]*$/m,
    `import NowPlaying from "./components/NowPlaying";
const isNowPlaying = window.location.hash === "#nowplaying";
ReactDOM.createRoot(document.getElementById("root")!).render(
  isNowPlaying ? <NowPlaying /> : <App />
);`
  );
  // Fix duplicate import issue — remove the duplicate we might have added
  const lines = main.split('\n');
  const seen = new Set();
  const deduped = lines.filter(l => {
    if (l.trim().startsWith('import NowPlaying')) {
      if (seen.has('NowPlaying')) return false;
      seen.add('NowPlaying');
    }
    return true;
  });
  main = deduped.join('\n');
  fs.writeFileSync('src/main.tsx', main, 'utf8');
  console.log('PATCHED src/main.tsx');
  ok++;
} else {
  console.log('SKIP src/main.tsx (already patched)');
}

console.log('\n' + '='.repeat(40));
console.log('Done. OK:' + ok + ' FAIL:' + fail);
console.log('='.repeat(40));
console.log('\nRun: npm run tauri:dev');
console.log('Then click NOW PLAYING in the header.');
console.log('A second window should open with album art.');
