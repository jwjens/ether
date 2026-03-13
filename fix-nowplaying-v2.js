const fs = require('fs');

// 1. Rewrite NowPlaying.tsx with new layout + Instagram widget
fs.writeFileSync('src/components/NowPlaying.tsx', `import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { query } from "../db/client";
import ovLogo from "../assets/cropped-lOVe.png";

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
  const [igHandle, setIgHandle] = useState("");
  const [igEnabled, setIgEnabled] = useState(false);
  const [adImages, setAdImages] = useState<string[]>([]);
  const [adIndex, setAdIndex] = useState(0);

  // Load Instagram settings from DB
  useEffect(() => {
    (async () => {
      try {
        const rows = await query<{key: string, value: string}>("SELECT key, value FROM station_config_kv WHERE key IN ('ig_handle','ig_enabled','ad_images') LIMIT 10");
        for (const r of rows) {
          if (r.key === 'ig_handle') setIgHandle(r.value);
          if (r.key === 'ig_enabled') setIgEnabled(r.value === '1');
          if (r.key === 'ad_images') {
            try { setAdImages(JSON.parse(r.value)); } catch {}
          }
        }
      } catch {}
    })();
  }, []);

  // Rotate ad images
  useEffect(() => {
    if (adImages.length < 2) return;
    const id = setInterval(() => setAdIndex(i => (i + 1) % adImages.length), 8000);
    return () => clearInterval(id);
  }, [adImages]);

  useEffect(() => {
    const unlisten = listen<TrackInfo>("now-playing-update", (event) => {
      setTrack(event.payload);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

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

  // Right panel: ads > instagram > placeholder
  const showAds = adImages.length > 0;
  const showIg = !showAds && igEnabled && igHandle;
  const igSrc = igHandle.startsWith('#')
    ? \`https://www.instagram.com/explore/tags/\${igHandle.replace('#','')}/embed\`
    : \`https://www.instagram.com/\${igHandle.replace('@','')}/embed\`;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0a0a0a", color: "#fff", overflow: "hidden", fontFamily: "system-ui, sans-serif" }}>
      {/* Blurred album art background */}
      {albumArt && (
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage: \`url(\${albumArt})\`,
          backgroundSize: "cover", backgroundPosition: "center",
          filter: "blur(80px) brightness(0.2) saturate(1.8)",
          transform: "scale(1.15)", zIndex: 0
        }} />
      )}

      <div style={{ position: "relative", zIndex: 1, height: "100%", display: "flex", flexDirection: "column" }}>

        {/* Top bar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 36px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ fontSize: 28, fontWeight: 300, letterSpacing: "-0.04em" }}>
              <span style={{ color: "#60a5fa" }}>Eth</span><span style={{ color: "#fff" }}>er</span>
            </span>
            {isPlaying && (
              <span style={{ padding: "3px 10px", background: "#dc2626", borderRadius: 6, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em" }}>ON AIR</span>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 40, fontFamily: "monospace", fontWeight: 700, lineHeight: 1 }}>{timeStr}</div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{dateStr}</div>
          </div>
        </div>

        {/* Main content: album art | right panel */}
        <div style={{ flex: 1, display: "flex", gap: 32, padding: "20px 36px", minHeight: 0 }}>

          {/* Left: Album art */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {albumArt ? (
              <img src={albumArt} alt="Album art" style={{ width: 320, height: 320, borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.8)", objectFit: "cover" }} />
            ) : (
              <div style={{ width: 320, height: 320, borderRadius: 16, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 64, opacity: 0.2 }}>♪</span>
              </div>
            )}
          </div>

          {/* Right: Ad / Instagram / placeholder */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div style={{ flex: 1, borderRadius: 16, overflow: "hidden", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", position: "relative" }}>
              {showAds && (
                <img src={adImages[adIndex]} alt="Ad" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
              )}
              {showIg && (
                <iframe src={igSrc} style={{ width: "100%", height: "100%", border: "none" }} title="Instagram" />
              )}
              {!showAds && !showIg && (
                <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
                  <img src={ovLogo} alt="Opportunity Village" style={{ maxWidth: 220, maxHeight: 120, objectFit: "contain", opacity: 0.85 }} />
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.25)", letterSpacing: "0.15em", textTransform: "uppercase" }}>Powered by Ether</div>
                </div>
              )}
            </div>

            {/* OV Logo watermark bottom of right panel */}
            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginTop: 10, gap: 10 }}>
              <img src={ovLogo} alt="OV" style={{ height: 28, opacity: 0.5, objectFit: "contain" }} />
            </div>
          </div>
        </div>

        {/* Bottom: Song info + progress */}
        <div style={{ padding: "0 36px 20px" }}>
          <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 14, padding: "16px 24px", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", letterSpacing: "0.2em", textTransform: "uppercase" as any, marginBottom: 4 }}>
                  {isPlaying ? "Now Playing" : "Up Next"}
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
                {artist && <div style={{ fontSize: 16, color: "rgba(255,255,255,0.55)", marginTop: 2 }}>{artist}</div>}
              </div>
              <button onClick={handleClose} style={{ marginLeft: 20, flexShrink: 0, padding: "6px 16px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, color: "rgba(255,255,255,0.5)", fontSize: 11, cursor: "pointer", letterSpacing: "0.08em" }}>CLOSE</button>
            </div>
            {dur > 0 && (
              <>
                <div style={{ height: 3, background: "rgba(255,255,255,0.1)", borderRadius: 2, overflow: "hidden", marginBottom: 6 }}>
                  <div style={{ height: "100%", width: pct + "%", background: "#60a5fa", borderRadius: 2, transition: "width 0.5s linear" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontFamily: "monospace", color: "rgba(255,255,255,0.3)" }}>
                  <span>{fmtTime(pos)}</span>
                  <span>-{fmtTime(dur - pos)}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
`);

console.log('NowPlaying.tsx written');
