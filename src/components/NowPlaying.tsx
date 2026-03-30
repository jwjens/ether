import { useState, useEffect, useRef } from "react";
const getCurrentWindow = () => ({ setTitle: (t: string) => document.title = t, close: () => window.close() });
const listen = (e: string, cb: (ev: any) => void): Promise<() => void> => { const h = (window as any).ether.on(e, (p: any) => cb({ payload: p })); return Promise.resolve(() => (window as any).ether.off(e, h)); };
import { query } from "../db/client";

interface TrackInfo {
  title: string; artist: string;
  position?: number; positionSec?: number;
  duration?: number; durationSec?: number;
  isPlaying: boolean;
  upcoming?: { title: string; artist: string; duration: number }[];
}
interface UpcomingSong {
  title: string; artist_name: string | null; duration_ms: number;
}

function fmtTime(s: number) {
  if (!s || s < 0) return "0:00";
  return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
}
function fmtDur(ms: number) {
  if (!ms) return "--:--";
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

async function fetchAlbumArt(artist: string, title: string): Promise<string | null> {
  const cacheKey = `ether_art_${(artist || "").toLowerCase().replace(/\s+/g, "_")}_${(title || "").toLowerCase().replace(/\s+/g, "_").slice(0, 20)}`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) return cached || null;

  const clean = (s: string) => s
    .replace(/\s*[-–]\s*(remaster(ed)?|\d{4}\s*remaster(ed)?).*/gi, "")
    .replace(/\s*\(feat\..*?\)/gi, "")
    .trim();

  const cleanArtist = clean(artist || "");
  const cleanTitle  = clean(title || "");

  const tryFetch = async (url: string) => {
    try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch { return null; }
  };

  let photoUrl: string | null = null;

  // Strategy 1: Wikipedia artist photo
  if (cleanArtist) {
    const wikiName = cleanArtist.replace(/\s+/g, "_");
    const w = await tryFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiName)}`);
    if (w && w.type !== "disambiguation") {
      const hasImage = w.originalimage?.source || w.thumbnail?.source;
      const looksLikeMusician = w.description?.toLowerCase().match(/sing|music|rap|artist|band|produc|songwrit|dj/) ||
        w.extract?.toLowerCase().match(/sing|music|rap|record|album|song|band/);
      if (hasImage && looksLikeMusician) {
        photoUrl = w.originalimage?.source || w.thumbnail?.source;
      }
    }
  }

  // Strategy 2: iTunes artwork
  if (!photoUrl) {
    const q = encodeURIComponent(`${cleanArtist} ${cleanTitle}`.trim());
    const d = await tryFetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=3`);
    if (d?.results?.[0]?.artworkUrl100) {
      photoUrl = d.results[0].artworkUrl100.replace("100x100bb", "600x600bb");
    }
  }

  sessionStorage.setItem(cacheKey, photoUrl || "");
  return photoUrl;
}

const WMO: Record<number, [string, string]> = {
  0: ["☀️","Clear"], 1: ["🌤","Mostly Clear"], 2: ["⛅","Partly Cloudy"], 3: ["☁️","Overcast"],
  45: ["🌫️","Foggy"], 48: ["🌫️","Icy Fog"], 51: ["🌦","Light Drizzle"], 53: ["🌧","Drizzle"],
  61: ["🌧","Light Rain"], 63: ["🌧","Rain"], 65: ["🌧","Heavy Rain"],
  71: ["❄️","Light Snow"], 73: ["❄️","Snow"], 75: ["❄️","Heavy Snow"],
  80: ["🌦","Showers"], 95: ["⛈️","Thunderstorm"], 99: ["⛈️","Severe Storm"],
};

const MOCK_ADS = [
  { bg: "linear-gradient(135deg,#0f172a,#1e1b4b)", accent: "#a78bfa", logo: "⚡", headline: "Ether Technologies", sub: "Professional Broadcast Automation", tag: "FREE TO DOWNLOAD", url: "etherradio.app" },
  { bg: "linear-gradient(135deg,#0c1a0c,#052e16)", accent: "#34d399", logo: "📻", headline: "Broadcast Smarter", sub: "Replace RCS Zetta & WideOrbit — for $0", tag: "OPEN SOURCE", url: "github.com/jwjens/ether" },
  { bg: "linear-gradient(135deg,#0c1929,#0f2744)", accent: "#38bdf8", logo: "🎙️", headline: "Ether Pro", sub: "Cloud backup · Analytics · Remote dashboard", tag: "$19 / MONTH", url: "etherradio.app/#pricing" },
  { bg: "linear-gradient(135deg,#1a0a2e,#2d1b69)", accent: "#c084fc", logo: "🏢", headline: "Ether Station", sub: "Multi-station · NexGen import · ASIO audio", tag: "$79 / MONTH", url: "etherradio.app/#pricing" },
];

function MockAdRotator() {
  const [idx, setIdx] = useState(0);
  const [fade, setFade] = useState(true);
  useEffect(() => {
    const id = setInterval(() => {
      setFade(false);
      setTimeout(() => { setIdx(i => (i + 1) % MOCK_ADS.length); setFade(true); }, 400);
    }, 6000);
    return () => clearInterval(id);
  }, []);
  const ad = MOCK_ADS[idx];
  return (
    <div style={{ width: "100%", height: "100%", background: ad.bg, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", padding: 48, textAlign: "center" as const, opacity: fade ? 1 : 0, transition: "opacity 0.4s ease", position: "relative" as const }}>
      <div style={{ position: "absolute" as const, bottom: 18, display: "flex", gap: 6 }}>
        {MOCK_ADS.map((_, i) => <div key={i} style={{ width: i === idx ? 18 : 6, height: 6, borderRadius: 3, background: i === idx ? ad.accent : "rgba(255,255,255,0.2)", transition: "all 0.3s" }} />)}
      </div>
      <div style={{ fontSize: 56, marginBottom: 16 }}>{ad.logo}</div>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.2em", color: ad.accent, marginBottom: 12, textTransform: "uppercase" as const }}>{ad.tag}</div>
      <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 36, fontWeight: 800, letterSpacing: "-0.02em", color: "#f0f0f8", marginBottom: 12, lineHeight: 1.1 }}>{ad.headline}</div>
      <div style={{ fontSize: 16, color: "rgba(255,255,255,0.5)", marginBottom: 24, lineHeight: 1.6 }}>{ad.sub}</div>
      <div style={{ padding: "8px 20px", borderRadius: 20, border: `1px solid ${ad.accent}50`, fontSize: 11, color: ad.accent, fontFamily: "'DM Mono',monospace", letterSpacing: "0.08em" }}>{ad.url}</div>
    </div>
  );
}

export default function NowPlaying({ onExit }: { onExit?: () => void }) {
  const [track, setTrack] = useState<TrackInfo>({ title: "", artist: "", positionSec: 0, durationSec: 0, isPlaying: false });
  const [albumArt, setAlbumArt] = useState<string | null>(null);
  const [lastTrack, setLastTrack] = useState("");
  const [upcoming, setUpcoming] = useState<UpcomingSong[]>([]);
  const [stationName, setStationName] = useState("Ether");
  const [widgetType, setWidgetType] = useState<"sponsor"|"instagram"|"weather"|"twitter">("sponsor");
  const [adImages, setAdImages] = useState<string[]>([]);
  const [adIndex, setAdIndex] = useState(0);
  const [igHandle, setIgHandle] = useState("");
  const [weatherData, setWeatherData] = useState<any>(null);
  const [weatherCity, setWeatherCity] = useState("Las Vegas");
  const [weatherLat, setWeatherLat] = useState(36.1699);
  const [weatherLon, setWeatherLon] = useState(-115.1398);

  const clockRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const posSpanRef = useRef<HTMLSpanElement>(null);
  const remSpanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const rows = await query<{key:string;value:string}>("SELECT key, value FROM station_config_kv WHERE key IN ('station_name','ad_images','ig_handle','now_playing_widget','weather_city','weather_lat','weather_lon')");
        for (const r of rows) {
          if (r.key === "station_name") setStationName(r.value || "Ether");
          if (r.key === "ad_images") { try { setAdImages(JSON.parse(r.value)); } catch {} }
          if (r.key === "ig_handle") setIgHandle(r.value);
          if (r.key === "now_playing_widget") setWidgetType((r.value as any) || "sponsor");
          if (r.key === "weather_city") setWeatherCity(r.value);
          if (r.key === "weather_lat") setWeatherLat(parseFloat(r.value) || 36.1699);
          if (r.key === "weather_lon") setWeatherLon(parseFloat(r.value) || -115.1398);
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (widgetType !== "weather") return;
    const load = async () => {
      try {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${weatherLat}&longitude=${weatherLon}&current_weather=true&temperature_unit=fahrenheit`);
        const d = await r.json();
        setWeatherData(d.current_weather);
      } catch {}
    };
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [widgetType, weatherLat, weatherLon]);

  useEffect(() => {
    if (adImages.length < 2) return;
    const id = setInterval(() => setAdIndex(i => (i + 1) % adImages.length), 8000);
    return () => clearInterval(id);
  }, [adImages]);

  const loadUpcoming = async () => {
    // upcoming populated from event payload
  };
  useEffect(() => { loadUpcoming(); }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const n = new Date();
      if (clockRef.current) clockRef.current.textContent = n.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (dateRef.current) dateRef.current.textContent = n.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setTimeout(() => (window as any).ether.emit("now-playing-request", {}), 500);
  }, []);

  useEffect(() => {
    const unlisten = listen<TrackInfo>("now-playing-update", (event) => {
      const p = event.payload;
      const posSec = p.positionSec ?? p.position ?? 0;
      const durSec = p.durationSec ?? p.duration ?? 0;
      // Update upcoming from payload
      if (p.upcoming && p.upcoming.length > 0) {
        setUpcoming(p.upcoming.map(q => ({ title: q.title, artist_name: q.artist, duration_ms: (q.duration || 0) * 1000 })));
      }
      setTrack(prev => {
        if (prev.title !== p.title || prev.artist !== p.artist || prev.isPlaying !== p.isPlaying) { return { ...p, positionSec: posSec, durationSec: durSec }; }
        if (progressRef.current && durSec > 0) progressRef.current.style.width = (posSec / durSec * 100) + "%";
        if (posSpanRef.current) posSpanRef.current.textContent = fmtTime(posSec);
        if (remSpanRef.current) remSpanRef.current.textContent = "-" + fmtTime(durSec - posSec);
        return prev;
      });
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    const key = track.artist + "|" + track.title;
    if (key === lastTrack) return;
    setLastTrack(key);
    setAlbumArt(null);
    if (track.artist || track.title) {
      const timer = setTimeout(() => {
        fetchAlbumArt(track.artist, track.title).then(url => {
          if (url) setAlbumArt(url);
        });
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [track.artist, track.title]);

  const { title, artist, positionSec: pos = 0, durationSec: dur = 0, isPlaying } = track;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;
  const now = new Date();
  const wCode = weatherData?.weathercode ?? -1;
  const [wIcon, wDesc] = WMO[wCode] ?? ["🌡️", ""];
  const igSrc = igHandle.startsWith("#")
    ? `https://www.instagram.com/explore/tags/${igHandle.replace("#", "")}/embed`
    : `https://www.instagram.com/${igHandle.replace("@", "")}/embed`;

  const handleClose = async () => {
    if (onExit) { onExit(); return; }
    try { await getCurrentWindow().close(); } catch {}
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#080810", color: "#fff", overflow: "hidden", fontFamily: "'Inter', system-ui, sans-serif", display: "flex", flexDirection: "column" }}>
      {albumArt && <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${albumArt})`, backgroundSize: "cover", backgroundPosition: "center", filter: "blur(80px) brightness(0.12) saturate(1.8)", transform: "scale(1.15)", zIndex: 0 }} />}
      {!albumArt && <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,#080810 0%,#0f0f2e 50%,#080810 100%)", zIndex: 0 }} />}

      <div style={{ position: "relative", zIndex: 1, height: "100%", display: "flex", flexDirection: "column" }}>

        {/* Top bar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 32px 14px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <svg width="42" height="42" viewBox="0 0 512 512" style={{ borderRadius: 10, flexShrink: 0 }}>
              <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#06b6d4"/><stop offset="100%" stopColor="#8b5cf6"/></linearGradient></defs>
              <rect width="512" height="512" rx="112" fill="url(#lg)"/>
              <rect x="128" y="136" width="256" height="56" rx="16" fill="#0a0a18"/>
              <rect x="128" y="228" width="192" height="52" rx="16" fill="#0a0a18"/>
              <rect x="128" y="320" width="256" height="56" rx="16" fill="#0a0a18"/>
              <rect x="128" y="136" width="56" height="240" rx="16" fill="#0a0a18"/>
            </svg>
            <div>
              <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1 }}>{stationName}</div>
              <div style={{ fontSize: 8, letterSpacing: "0.24em", color: "#22d3ee", textTransform: "uppercase" as const, marginTop: 2 }}>Powered by Ether</div>
            </div>
            {isPlaying && <span style={{ padding: "4px 12px", background: "#dc2626", borderRadius: 6, fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", boxShadow: "0 0 16px rgba(220,38,38,0.5)", marginLeft: 4 }}>ON AIR</span>}
          </div>
          <div style={{ textAlign: "right" }}>
            <div ref={clockRef} style={{ fontFamily: "'DM Mono', monospace", fontSize: 40, fontWeight: 300, lineHeight: 1, letterSpacing: "-0.02em" }}>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
            <div ref={dateRef} style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", marginTop: 3 }}>{now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
          </div>
        </div>

        {/* Main area */}
        <div style={{ flex: 1, display: "flex", gap: 16, padding: "0 32px", minHeight: 0 }}>

          {/* Left: Upcoming */}
          <div style={{ width: 320, flexShrink: 0, background: "rgba(0,0,0,0.45)", borderRadius: 18, border: "1px solid rgba(255,255,255,0.07)", padding: "18px 18px", display: "flex", flexDirection: "column", backdropFilter: "blur(20px)" }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.24em", color: "rgba(255,255,255,0.22)", textTransform: "uppercase" as const, marginBottom: 12 }}>Up Next</div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, overflow: "hidden" }}>
              {upcoming.length === 0
                ? <div style={{ color: "rgba(255,255,255,0.15)", fontSize: 13, marginTop: 32, textAlign: "center" as const }}>Queue is empty</div>
                : upcoming.map((s, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", borderRadius: 11, background: i === 0 ? "rgba(34,211,238,0.09)" : "rgba(255,255,255,0.025)", border: `1px solid ${i === 0 ? "rgba(34,211,238,0.2)" : "rgba(255,255,255,0.035)"}` }}>
                    <div style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0, background: i === 0 ? "rgba(34,211,238,0.18)" : "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: i === 0 ? "#22d3ee" : "rgba(255,255,255,0.22)", fontFamily: "'DM Mono', monospace" }}>{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: i === 0 ? 600 : 400, color: i === 0 ? "#f0f0f8" : "rgba(255,255,255,0.6)", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 1, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>{s.artist_name || "Unknown Artist"}</div>
                    </div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.18)", flexShrink: 0 }}>{fmtDur(s.duration_ms)}</div>
                  </div>
                ))}
            </div>
          </div>

          {/* Right: Big widget */}
          <div style={{ flex: 1, borderRadius: 18, overflow: "hidden", background: "rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.07)", position: "relative", backdropFilter: "blur(20px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {widgetType === "sponsor" && adImages.length > 0 && <img src={adImages[adIndex]} alt="Sponsor" style={{ width: "100%", height: "100%", objectFit: "contain" }} />}
            {widgetType === "sponsor" && adImages.length === 0 && (
              <MockAdRotator />
            )}
            {widgetType === "instagram" && igHandle && <iframe src={igSrc} style={{ width: "100%", height: "100%", border: "none" }} title="Instagram" />}
            {widgetType === "instagram" && !igHandle && (
              <div style={{ textAlign: "center" as const, padding: 48 }}>
                <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 20 }}><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.5" fill="rgba(255,255,255,0.12)" stroke="none"/></svg>
                <div style={{ fontSize: 15, color: "rgba(255,255,255,0.18)" }}>Set Instagram handle in Settings → Now Playing</div>
              </div>
            )}
            {widgetType === "weather" && (
              <div style={{ textAlign: "center" as const }}>
                {weatherData ? (
                  <>
                    <div style={{ fontSize: 96, lineHeight: 1, marginBottom: 16 }}>{wIcon}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 88, fontWeight: 300, letterSpacing: "-0.04em", lineHeight: 1, marginBottom: 10 }}>{Math.round(weatherData.temperature)}°</div>
                    <div style={{ fontSize: 24, color: "rgba(255,255,255,0.45)", marginBottom: 8 }}>{wDesc}</div>
                    <div style={{ fontSize: 14, color: "rgba(255,255,255,0.25)", letterSpacing: "0.16em", textTransform: "uppercase" as const }}>{weatherCity}</div>
                  </>
                ) : <div style={{ color: "rgba(255,255,255,0.18)", fontSize: 14 }}>Loading weather...</div>}
              </div>
            )}
            {widgetType === "twitter" && (
              <div style={{ textAlign: "center" as const, padding: 48 }}>
                <div style={{ fontSize: 72, marginBottom: 20, opacity: 0.12, fontFamily: "serif" }}>𝕏</div>
                <div style={{ fontSize: 15, color: "rgba(255,255,255,0.18)", lineHeight: 2 }}>Twitter / X Ticker<br/>Coming soon in Ether Pro</div>
              </div>
            )}
          </div>
        </div>

        {/* Bottom: album art + info */}
        <div style={{ padding: "14px 32px 22px", flexShrink: 0 }}>
          <div style={{ background: "rgba(0,0,0,0.7)", borderRadius: 18, padding: "16px 22px", backdropFilter: "blur(24px)", border: "1px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", gap: 20 }}>
            <div style={{ flexShrink: 0 }}>
              {albumArt
                ? <img src={albumArt} alt="Art" style={{ width: 100, height: 100, borderRadius: 14, objectFit: "cover", boxShadow: "0 8px 32px rgba(0,0,0,0.7)" }} />
                : <div style={{ width: 100, height: 100, borderRadius: 14, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.2 }}>
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                  </div>}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {isPlaying && <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.22em", color: "#22d3ee", textTransform: "uppercase" as const, marginBottom: 4 }}>Now Playing</div>}
              <div style={{ fontSize: 32, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.03em", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
              {artist && <div style={{ fontSize: 17, color: "rgba(255,255,255,0.45)", marginTop: 4, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>{artist}</div>}
              {dur > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ height: 3, background: "rgba(255,255,255,0.1)", borderRadius: 2, overflow: "hidden", marginBottom: 5 }}>
                    <div ref={progressRef} style={{ height: "100%", width: pct + "%", background: "linear-gradient(90deg,#22d3ee,#8b5cf6)", borderRadius: 2, transition: "width 0.5s linear" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: "'DM Mono', monospace", color: "rgba(255,255,255,0.28)" }}>
                    <span ref={posSpanRef}>{fmtTime(pos)}</span>
                    <span ref={remSpanRef}>-{fmtTime(dur - pos)}</span>
                  </div>
                </div>
              )}
            </div>
            <button onClick={handleClose} style={{ flexShrink: 0, padding: "10px 20px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, color: "rgba(255,255,255,0.4)", fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", cursor: "pointer", textTransform: "uppercase" as const }}>CLOSE</button>
          </div>
        </div>
      </div>
    </div>
  );
}

