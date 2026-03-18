import { useState, useEffect, useRef } from "react";
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
  const [time] = useState(new Date());
  const clockRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLDivElement>(null);
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

  const posRef = useRef<{pos: number, dur: number}>({pos: 0, dur: 0});
  const progressRef = useRef<HTMLDivElement>(null);
  const posSpanRef = useRef<HTMLSpanElement>(null);
  const remSpanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // Request current track from main window on open
    import("@tauri-apps/api/event").then(({ emit: emitFn }) => {
      setTimeout(() => emitFn("now-playing-request", {}).catch(() => {}), 500);
    });
  }, []);

  useEffect(() => {
    const unlisten = listen<TrackInfo>("now-playing-update", (event) => {
      const p = event.payload;
      // Only trigger React re-render when track/artist/status changes
      setTrack(prev => {
        if (prev.title !== p.title || prev.artist !== p.artist || prev.isPlaying !== p.isPlaying) {
          return p;
        }
        // Update position via DOM directly to avoid re-render
        posRef.current = { pos: p.positionSec, dur: p.durationSec };
        if (progressRef.current && p.durationSec > 0) {
          progressRef.current.style.width = (p.positionSec / p.durationSec * 100) + "%";
        }
        if (posSpanRef.current) posSpanRef.current.textContent = fmtTime(p.positionSec);
        if (remSpanRef.current) remSpanRef.current.textContent = "-" + fmtTime(p.durationSec - p.positionSec);
        return prev;
      });
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      if (clockRef.current) clockRef.current.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (dateRef.current) dateRef.current.textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    }, 1000);
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
    ? `https://www.instagram.com/explore/tags/${igHandle.replace('#','')}/embed`
    : `https://www.instagram.com/${igHandle.replace('@','')}/embed`;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0a0a0a", color: "#fff", overflow: "hidden", fontFamily: "system-ui, sans-serif", willChange: "auto" }}>
      {/* Blurred album art background */}
{albumArt && (
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage: `url(${albumArt})`,
          backgroundSize: "cover", backgroundPosition: "center",
          filter: "blur(80px) brightness(0.2) saturate(1.8)",
          transform: "scale(1.15) translateZ(0)",
          willChange: "transform",
          zIndex: 0
        }} />
      )}
      {!albumArt && <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)", zIndex: 0 }} />}

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
            <div ref={clockRef} style={{ fontSize: 40, fontFamily: "monospace", fontWeight: 700, lineHeight: 1 }}>{timeStr}</div>
            <div ref={dateRef} style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{dateStr}</div>
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
                  <img src={ovLogo} alt="Opportunity Village" style={{ width: "90%", height: "80%", objectFit: "contain", opacity: 0.98 }} />
                </div>
              )}
            </div>

            {/* OV Logo watermark bottom of right panel */}
            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginTop: 10, gap: 10 }}>
              <img src={ovLogo} alt="OV" style={{ height: 48, opacity: 0.6, objectFit: "contain" }} />
            </div>
          </div>
        </div>

        {/* Bottom: Song info + progress - hide when no track */}
        <div style={{ padding: "0 36px 20px", display: title === "Ether Radio" ? "none" : "block" }}>
          <div style={{ background: "rgba(0,0,0,0.75)", borderRadius: 14, padding: "20px 28px", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.15)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 16, color: "#ffffff", letterSpacing: "0.2em", textTransform: "uppercase" as any, marginBottom: 8, fontWeight: 700 }}>
                  {isPlaying ? "Now Playing" : ""}
                </div>
                <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "#ffffff" }}>{title}</div>
                {artist && <div style={{ fontSize: 28, color: "#ffffff", marginTop: 6, fontWeight: 400 }}>{artist}</div>}
              </div>
              <button onClick={handleClose} style={{ marginLeft: 20, flexShrink: 0, padding: "6px 16px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, color: "#ffffff", fontSize: 13, cursor: "pointer", letterSpacing: "0.08em" }}>CLOSE</button>
            </div>
            {dur > 0 && (
              <>
                <div style={{ height: 5, background: "rgba(255,255,255,0.2)", borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
                  <div style={{ height: "100%", width: pct + "%", background: "#60a5fa", borderRadius: 2, transition: "width 0.5s linear" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, fontFamily: "monospace", color: "rgba(255,255,255,0.8)" }}>
                  <span ref={posSpanRef}>{fmtTime(pos)}</span>
                  <span ref={remSpanRef}>-{fmtTime(dur - pos)}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
