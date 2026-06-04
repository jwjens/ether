import VUMeter from "./VUMeter";
import ArtistCard from "./ArtistCard";
import GraphicEQ, { EQ_DEFAULT } from "./GraphicEQ";
import { useState, useEffect, useRef, useCallback } from "react";
import { DeckState } from "../audio/engine-rodio";
import { query } from "../db/client";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
import { fetchArt } from "./UpNext";
import { getLocalArt } from "../lib/albumArt";

interface Props {
  deck: DeckState | null;
  label: string;
  deckId: "A" | "B" | "C";
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onVolume: (v: number) => void;
  onDragStart?: (e: React.MouseEvent) => void;
  bpm?: number | null;
  introEndSec?: number | null; // from DB auto-cue
}

function fmt(sec: number): string {
  if (sec <= 0) return "0:00";
  return Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
}



export default function OnAirDeck({ deck, label, deckId, onPlay, onPause, onResume, onStop, onVolume, onDragStart, bpm, introEndSec }: Props) {
  const { stationId } = useActiveStation();
  const [blink, setBlink] = useState(false);
  const [categoryColor, setCategoryColor] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState<string | null>(null);

  // ── EQ state ─────────────────────────────────────────────────
  const [eqOpen,  setEqOpen]  = useState(false);
  const [eqBands, setEqBands] = useState<number[]>(EQ_DEFAULT);
  const eqActive = eqBands.some(g => Math.abs(g) > 0.05);
  const eqKey = `eq_deck_${deckId}`;

  // Deck values — must be declared before any useEffect that references them
  const status = deck?.status || "idle";
  const title  = deck?.title  || "";
  const artist = deck?.artist || "";
  const pos    = deck?.positionSec  || 0;
  const dur    = deck?.durationSec  || 0;
  const vol    = deck?.volume ?? 1;


  // Look up category color when track changes
  useEffect(() => {
    if (!title) { setCategoryColor(null); setCategoryName(null); return; }
    queryScoped<{ color: string; name: string; code: string }>(
      `SELECT c.color, c.name, c.code FROM songs s
       LEFT JOIN categories c ON c.id = s.category_id
       WHERE s.title = ? AND s.file_path IS NOT NULL
       LIMIT 1`,
      [title],
      stationId,
      { skipScoping: true }
    ).then(rows => {
      setCategoryColor(rows[0]?.color || null);
      setCategoryName(rows[0]?.name || rows[0]?.code || null);
    }).catch(() => {});
  }, [title]);

  // ── EQ load from DB on mount ─────────────────────────────────
  useEffect(() => {
    query<{ value: string }>(
      "SELECT value FROM station_config_kv WHERE key=?", [eqKey]
    ).then(rows => {
      if (rows[0]?.value) {
        try { setEqBands(JSON.parse(rows[0].value)); } catch {}
      }
    }).catch(() => {});
  }, [eqKey]);

  // ── EQ save + send to engine ──────────────────────────────────
  const handleEqChange = useCallback((bands: number[]) => {
    setEqBands(bands);
    (window as any).ether.stationConfigKv.upsertByKey(stationId, eqKey, JSON.stringify(bands));
    // Send to native audio engine (audioSetEq added in native addon)
    try {
      const w = window as any;
      if (w.ether?.audio?.setEq) w.ether.audio.setEq(deckId, bands);
    } catch {}
  }, [stationId, eqKey, deckId]);

  const remaining = Math.max(0, dur - pos);
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;

  const isPlaying = status === "playing";

  // ── Album artwork (iTunes song entity — 60×60 thumb + idle bg) ────────────
  const [albumArtUrl, setAlbumArtUrl] = useState<string | null>(null);
  const albumArtFetchedFor = useRef<string>("");

  useEffect(() => {
    if (!title) return;
    const key = `${title}::${artist}`;
    if (albumArtFetchedFor.current === key) return;
    albumArtFetchedFor.current = key;
    // Local-first: embedded cover art from the on-air file, iTunes as the fallback.
    (async () => {
      const local = await getLocalArt((deck as any)?.filePath);
      setAlbumArtUrl(local || await fetchArt(title, artist));
    })();
  }, [title, artist]);

  // ── Artist photo (Wikipedia/iTunes artist) for blurred bg ──────────────
  const [artUrl, setArtUrl] = useState<string | null>(null);
  const [artPulse, setArtPulse] = useState(false);
  const [artReady, setArtReady] = useState(false);
  const artLoadedFor = useRef<string>("");

  // When title/artist changes, fetch artwork using smart multi-source strategy
  useEffect(() => {
    if (!title) { setArtUrl(null); setArtReady(false); return; }
    // Cache key is artist — same artist = same photo regardless of track
    const cacheKey = `ether_artist_photo_${(artist||"").toLowerCase().replace(/\s+/g,"_")}_${(title||"").toLowerCase().replace(/\s+/g,"_").slice(0,20)}`;
    if (artLoadedFor.current === (artist || title)) return;
    artLoadedFor.current = artist || title;
    setArtReady(false);

    (async () => {
      // Check cache first
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) { setArtUrl(cached); setArtReady(true); return; }

      try {
        const clean = (s: string) => s
          .replace(/\s*[-–]\s*(remaster(ed)?|re-?master(ed)?|\d{4}\s*remaster(ed)?).*/gi, "")
          .replace(/\s*\(feat\..*?\)/gi, "")
          .replace(/\s*\(ft\..*?\)/gi, "")
          .replace(/\s*[-–]\s*(single|ep|deluxe|expanded|anniversary).*/gi, "")
          .replace(/\s*\(\d{4}\)/g, "")
          .trim();

        const cleanArtist = clean(artist || "");
        const cleanTitle  = clean(title);

        const tryFetch = async (url: string) => {
          try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); }
          catch { return null; }
        };

        let photoUrl: string | null = null;

        // ── Artist photo strategy — Wikipedia first, then Deezer ──
        // Wikipedia: free licensed press photos, clean backgrounds, no key needed
        // All fetches go through local proxy (port 4242) for CORS canvas access
        const PROXY = "http://localhost:4242";

        // ── Artist photo — Wikipedia first, then iTunes ──
        // Note: Deezer removed — blocked by CORS in browser context

        // Strategy 1: Wikipedia — good photos
        if (!photoUrl && cleanArtist) {
          const wikiFormats = [
            cleanArtist.trim().replace(/\s+/g, "_"),
            cleanArtist.trim().replace(/\s+/g, "_").replace(/\.$/, ""),
            cleanArtist.split("/")[0].trim().replace(/\s+/g, "_"),
          ];
          for (const wikiName of wikiFormats) {
            if (photoUrl) break;
            const w = await tryFetch(
              `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiName)}`
            );
            if (!w || w.type === "disambiguation") continue;
            const hasImage = w.originalimage?.source || w.thumbnail?.source;
            const looksLikeMusician =
              w.description?.toLowerCase().match(/sing|music|rap|artist|band|produc|songwrit|dj/) ||
              w.extract?.toLowerCase().match(/sing|music|rap|record|album|song|band/);
            if (hasImage && looksLikeMusician) {
              photoUrl = `${PROXY}/api/img-proxy?url=${encodeURIComponent(w.originalimage?.source || w.thumbnail?.source)}`;
            }
          }
        }

        // Strategy 3: iTunes musicArtist — last resort
        if (!photoUrl && cleanArtist) {
          const q = encodeURIComponent(cleanArtist);
          const d = await tryFetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=musicArtist&limit=5`);
          if (d?.results?.length) {
            const match = d.results.find((r: any) =>
              (r.artistName || "").toLowerCase() === cleanArtist.toLowerCase()
            ) || d.results[0];
            if (match?.artworkUrl100) {
              photoUrl = `${PROXY}/api/img-proxy?url=${encodeURIComponent(
                match.artworkUrl100.replace("100x100bb", "3000x3000bb")
              )}`;
            }
          }
        }

        // If no artist photo found — color backdrop renders, looks intentional

        if (photoUrl) {
          sessionStorage.setItem(cacheKey, photoUrl);
          setArtUrl(photoUrl);
          setArtReady(true);
        } else {
          setArtUrl(null);
        }
      } catch {
        setArtUrl(null);
      }
    })();
  }, [artist]); // key on artist, not title — same artist across tracks = same photo

  // Pulse the artwork in sync with the beat (tied to VU level)
  useEffect(() => {
    if (!isPlaying || !artReady) return;
    const id = setInterval(() => {
      setArtPulse(true);
      setTimeout(() => setArtPulse(false), 180);
    }, 620); // ~97 BPM default pulse
    return () => clearInterval(id);
  }, [isPlaying, artReady]);
  const isPaused = status === "paused";
  const isIdle = !title;
  // Use DB cue point if available, else fall back to 8% heuristic
  const introEnd = introEndSec && introEndSec > 0 ? introEndSec : dur * 0.08;
  const isInIntro = pos < introEnd && isPlaying && dur > 0 && introEnd > 3;
  const isEnding = remaining < 15 && remaining > 0 && isPlaying;
  const isCritical = remaining < 5 && remaining > 0 && isPlaying;
  const showOverlay = isPlaying && dur > 0 && (isInIntro || isEnding);

  useEffect(() => {
    if (isCritical) {
      const id = setInterval(() => setBlink(b => !b), 250);
      return () => clearInterval(id);
    }
    setBlink(false);
  }, [isCritical]);

  // Deck identity colors (top-bar accent when not playing)
  const identityColor = deckId === "A" ? "#008878" : deckId === "C" ? "#203878" : "#1a6040";

  // State-driven colors
  let accent = "#94a3b8";
  let statusLabel = "IDLE";
  let statusColor = "var(--text-tertiary)";
  let topBarColor = identityColor;
  let cardBg = "var(--bg-primary)";
  let cardShadow = "none";

  if (isPlaying) {
    if (isCritical) {
      accent = "var(--accent-red)"; statusLabel = "ENDING"; statusColor = "var(--accent-red)";
      topBarColor = "var(--accent-red)";
      cardBg = "var(--bg-primary)";
      cardShadow = "0 0 12px rgba(248,113,113,0.18)";
    } else if (isEnding) {
      accent = "var(--accent-orange)"; statusLabel = "OUTRO"; statusColor = "var(--accent-orange)";
      topBarColor = "var(--accent-orange)";
      cardShadow = "0 0 12px rgba(251,146,60,0.14)";
    } else {
      accent = "var(--accent-orange)"; statusLabel = "ON AIR"; statusColor = "var(--accent-green)";
      topBarColor = "var(--accent-blue)";
      cardShadow = "0 0 12px rgb(from var(--accent-blue) r g b / 0.18)";
    }
  } else if (isPaused) {
    accent = "var(--accent-amber)"; statusLabel = "PAUSED"; statusColor = "var(--accent-amber)";
    topBarColor = "var(--accent-amber)";
  } else if (title) {
    accent = "var(--text-tertiary)"; statusLabel = "READY"; statusColor = "var(--text-tertiary)";
  }

  // Deck identity colors
  // Skin-aware deck colors — pull from CSS variables so every skin
  // gets its own palette rather than hardcoded hex
  const deckHue = deckId === "A"
    ? "var(--accent-cyan)"
    : deckId === "B"
    ? "var(--accent-green)"
    : "var(--accent-purple)";
  const deckHueRaw = deckId === "A" ? "56,189,248" : deckId === "B" ? "52,211,153" : "167,139,250";
  const deckHueBg = `rgba(${deckHueRaw},0.1)`;
  const deckHueBorder = `rgba(${deckHueRaw},0.25)`;

  // Play button identity styling per deck
  const playBtnBg = isPlaying ? "var(--accent-green)"
    : isPaused ? "var(--accent-cyan)"
    : deckId === "A" ? "#0a3020"
    : deckId === "C" ? "#0a0a28"
    : deckHueBg;
  const playBtnBorder = isPlaying || isPaused ? "none"
    : deckId === "A" ? "1px solid #00a878"
    : deckId === "C" ? "1px solid #2040a0"
    : `1px solid ${deckHueBorder}`;
  const playBtnColor = isPlaying ? "#fff"
    : isPaused ? "var(--accent-cyan)"
    : deckId === "A" ? "#00a878"
    : deckId === "C" ? "#2040a0"
    : deckHue;
  const playBtnLabel = isPlaying ? "PAUSE" : isPaused ? "RESUME" : "PLAY";

  return (
    <div
      className={isPlaying ? "pulse-border" : ""}
      style={{
        "--pulse-rgb": deckHueRaw,
        background: cardBg,
        backdropFilter: isPlaying ? "blur(16px) saturate(1.4)" : "blur(8px)",
        WebkitBackdropFilter: isPlaying ? "blur(16px) saturate(1.4)" : "blur(8px)",
        borderRadius: 0,
        border: "none",
        // When playing, CSS animation owns box-shadow; otherwise use static state shadow
        boxShadow: isPlaying ? undefined : cardShadow,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
        transition: "background 0.4s ease, border-color 0.4s ease",
        fontFamily: "'Inter', system-ui, sans-serif",
      } as React.CSSProperties}
    >

      {/* ── Top accent bar ── */}
      <div style={{
        height: 3,
        background: topBarColor,
        transition: "background 0.3s ease",
        boxShadow: isPlaying ? `0 0 16px ${topBarColor}60` : "none",
        flexShrink: 0,
      }} />

      {/* ── Header: art + track info + countdown ── */}
      <div style={{ padding: "10px 12px 8px", flexShrink: 0, display: "flex", alignItems: "center", gap: 10 }}>

        {/* Drag handle */}
        {onDragStart && (
          <div
            onMouseDown={onDragStart}
            title="Drag to reorder"
            style={{ cursor: "grab", color: "var(--text-tertiary)", display: "flex", alignItems: "center", flexShrink: 0, opacity: 0.3 }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "0.7"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = "0.3"; }}
          >
            <svg width="8" height="12" viewBox="0 0 10 14" fill="currentColor">
              <circle cx="3" cy="2" r="1.2"/><circle cx="7" cy="2" r="1.2"/>
              <circle cx="3" cy="6" r="1.2"/><circle cx="7" cy="6" r="1.2"/>
              <circle cx="3" cy="10" r="1.2"/><circle cx="7" cy="10" r="1.2"/>
            </svg>
          </div>
        )}

        {/* Album art — 56×56 */}
        {title && albumArtUrl && (
          <div style={{
            width: 56, height: 56, flexShrink: 0,
            border: "1px solid rgba(255,255,255,0.06)",
            overflow: "hidden",
            borderRadius: 2,
          }}>
            <img src={albumArtUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          </div>
        )}

        {/* Title + artist */}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            key={title}
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: isIdle ? "var(--text-tertiary)" : "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              letterSpacing: "-0.03em",
              lineHeight: 1.15,
              fontFamily: "'Inter', system-ui, sans-serif",
              fontStyle: isIdle ? "italic" : "normal",
              animation: title ? "deck-slide-in 0.35s cubic-bezier(0.34,1.56,0.64,1) both" : "none",
            }}>
            {title ? (() => {
              const remaster = title.match(/\s*[-–]\s*([\d]{4}\s*remaster(?:ed)?|remaster(?:ed)?|re-?master(?:ed)?.*)/i);
              const cleanTitle = remaster ? title.slice(0, remaster.index).trim() : title;
              const remasterTag = remaster ? remaster[0].replace(/\s*[-–]\s*/, '').trim() : null;
              return (
                <>
                  {cleanTitle}
                  {remasterTag && <span style={{ fontSize: "0.45em", fontWeight: 400, opacity: 0.4, marginLeft: 6 }}>{remasterTag}</span>}
                </>
              );
            })() : "No track loaded"}
          </div>
          <div style={{
            fontSize: 13,
            fontWeight: 400,
            color: "var(--text-secondary)",
            marginTop: 4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            opacity: isIdle ? 0 : 1,
            transition: "opacity 0.2s",
          }}>
            {artist || ""}
          </div>
        </div>

        {/* Countdown — single large timer, right-aligned */}
        <div style={{ flexShrink: 0, textAlign: "right" as const }}>
          <div style={{
            fontFamily: "'DM Mono', 'SF Mono', monospace",
            fontSize: 36,
            fontWeight: 300,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.04em",
            lineHeight: 1,
            color: dur > 0 ? accent : "var(--text-tertiary)",
            transition: "color 0.3s ease",
          }}>
            {dur > 0 ? `\u2212${fmt(remaining)}` : "\u2014:\u2014\u2014"}
          </div>
        </div>

      </div>

      {/* ── Progress bar ── */}
      <div style={{
        margin: "0 12px 8px",
        height: 3,
        background: "var(--bg-tertiary)",
        borderRadius: 0,
        overflow: "hidden",
        flexShrink: 0,
      }}>
        <div style={{
          height: "100%",
          width: dur > 0 ? pct + "%" : "0%",
          background: "var(--accent-cyan)",
          borderRadius: 0,
          transition: "width 0.15s linear",
          boxShadow: isPlaying ? "0 0 6px var(--accent-cyan)" : "none",
        }} />
      </div>

      {/* ── VU Meter — fills available space, borderless hardware aesthetic ── */}
      <div style={{
        flex: 1,
        minHeight: 44,
        position: "relative",
        overflow: "hidden",
        background: "var(--bg-primary)",
      }}>
        {/* Artwork background for standby decks */}
        {!isPlaying && artUrl && artReady && (
          <>
            <img
              src={artUrl}
              alt=""
              style={{
                position: "absolute", inset: 0,
                width: "100%", height: "100%",
                objectFit: "cover",
                opacity: 0.12,
                filter: "blur(8px) saturate(1.4)",
                transform: "scale(1.05)",
                pointerEvents: "none",
              }}
            />
            <div style={{
              position: "absolute", inset: 0,
              background: "linear-gradient(to top, var(--bg-tertiary) 0%, transparent 60%)",
              pointerEvents: "none",
            }} />
          </>
        )}

        <VUMeter deckId={deckId} isPlaying={isPlaying} />

        {/* ── Idle state: animated sine-wave — rendered after VUMeter so it sits on top ── */}
        {isIdle && (
          <>
            <style>{`
              @keyframes idle-bar {
                0%   { height: 3px;  opacity: 0.25; }
                100% { height: 20px; opacity: 0.55; }
              }
              @keyframes idle-art-fade {
                from { opacity: 0; }
                to   { opacity: 0.3; }
              }
            `}</style>
            <div style={{
              position: "absolute", inset: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              pointerEvents: "none",
              zIndex: 2,
              background: "var(--bg-primary)",
            }}>
              {/* Last-played album art — dimmed full-bleed background */}
              {albumArtUrl && (
                <img
                  src={albumArtUrl}
                  alt=""
                  style={{
                    position: "absolute", inset: 0,
                    width: "100%", height: "100%",
                    objectFit: "cover",
                    opacity: 0.3,
                    pointerEvents: "none",
                    animation: "idle-art-fade 0.8s ease both",
                  }}
                />
              )}

              {/* Small deck letter — bottom-right ghost */}
              <span style={{
                position: "absolute", bottom: 8, right: 10,
                fontSize: 48, fontWeight: 800, letterSpacing: "-0.04em",
                color: deckHue, opacity: 0.06,
                fontFamily: "'Syne', sans-serif",
                lineHeight: 1,
              }}>{deckId}</span>

              {/* Pulsing sine-wave bars */}
              <div style={{ display: "flex", gap: 3, alignItems: "center", height: 28 }}>
                {[0.3,0.55,0.75,0.9,1,0.9,0.75,0.55,0.3,0.15,0.3,0.55,0.75,0.9,1,0.9,0.75,0.55,0.3].map((amp, i) => (
                  <div key={i} style={{
                    width: 2,
                    background: `rgba(${deckHueRaw}, 0.5)`,
                    borderRadius: 1,
                    animation: `idle-bar ${1.6 + amp * 0.6}s ease-in-out ${i * 0.07}s infinite alternate`,
                    maxHeight: `${Math.round(amp * 22)}px`,
                    minHeight: 3,
                    height: `${Math.round(amp * 22)}px`,
                  }} />
                ))}
              </div>
            </div>
          </>
        )}

        {/* Countdown overlay */}
        {showOverlay && (
          <div style={{
            position: "absolute", inset: 0, borderRadius: 0,
            overflow: "hidden",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
          }}>
            {/* Semi-transparent background — waveform bleeds through */}
            <div style={{
              position: "absolute", inset: 0,
              background: "var(--bg-secondary)",
              opacity: 0.9,
            }} />
            {/* Full bleed intro countdown */}
            {isInIntro ? (
              <>
                {/* Artist + title at top */}
                {/* Big countdown */}
                <div style={{ position: "relative", zIndex: 1, textAlign: "center" as const }}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 64, fontWeight: 700,
                    color: "var(--text-secondary)",
                    lineHeight: 1,
                    letterSpacing: "-0.06em",
                    transform: artPulse ? "scale(1.05)" : "scale(1)",
                    transition: "transform 0.18s ease-out",
                  }}>
                    {Math.ceil(introEnd - pos)}
                  </div>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.28em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginTop: 2 }}>
                    INTRO
                  </div>
                </div>
              </>
            ) : (
              /* Non-intro overlay — OUTRO/CRITICAL, no art */
              <div style={{
                position: "absolute", inset: 0, borderRadius: 0,
                background: "var(--bg-secondary)",
                opacity: 0.92,
                backdropFilter: "blur(2px)",
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                gap: 2,
              }}>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase" as const, color: isCritical ? "var(--accent-red)" : "var(--accent-orange)", opacity: 0.8 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    OUTRO
                  </span>
                </div>
                <div style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 88, fontWeight: 500,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1, letterSpacing: "-0.05em",
                  color: isCritical ? "var(--accent-red)" : "var(--accent-orange)",
                  opacity: isCritical && blink ? 0.4 : 1,
                  transition: "opacity 0.1s",
                }}>
                  {Math.ceil(remaining)}
                </div>
                <div style={{ fontSize: 8, fontWeight: 500, letterSpacing: "0.1em", color: "var(--text-tertiary)" }}>seconds remaining</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── EQ panel — slides up from bottom ── */}
      <div style={{
        maxHeight: eqOpen ? 130 : 0,
        overflow: "hidden",
        transition: "max-height 0.25s cubic-bezier(0.4,0,0.2,1)",
        flexShrink: 0,
      }}>
        <GraphicEQ bands={eqBands} onChange={handleEqChange} label="EQ" />
      </div>

      {/* ── Controls ── */}
      <div style={{
        padding: "10px 16px 14px",
        borderTop: "1px solid rgba(255,255,255,0.04)",
        background: "var(--bg-tertiary)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexShrink: 0,
      }}>
        {/* STOP */}
        <button
          onClick={onStop}
          style={{
            width: 36, height: 36,
            borderRadius: 0,
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-secondary)",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 10,
            flexShrink: 0,
            transition: "all 0.15s ease",
          }}
          title="Stop"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <rect x="0" y="0" width="10" height="10" rx="1.5"/>
          </svg>
        </button>

        {/* PLAY / PAUSE / RESUME */}
        <button
          onClick={isPlaying ? onPause : isPaused ? onResume : onPlay}
          style={{
            flex: 1,
            height: 36,
            borderRadius: 0,
            background: playBtnBg,
            border: playBtnBorder,
            color: playBtnColor,
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            gap: 6,
            fontSize: 11, fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            transition: "all 0.15s ease",
            boxShadow: isPlaying ? `0 2px 8px ${playBtnBg}50` : "none",
          }}
        >
          {isPlaying ? (
            <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
              <rect x="0" y="0" width="3.5" height="12" rx="1"/>
              <rect x="6.5" y="0" width="3.5" height="12" rx="1"/>
            </svg>
          ) : isPaused ? (
            <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
              <polygon points="0,0 10,6 0,12"/>
            </svg>
          ) : (
            <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
              <polygon points="0,0 10,6 0,12"/>
            </svg>
          )}
          {playBtnLabel}
        </button>

        {/* EQ toggle */}
        <button
          onClick={() => setEqOpen(o => !o)}
          title={eqOpen ? "Close EQ" : "Open graphic EQ"}
          style={{
            width: 36, height: 36,
            borderRadius: 0,
            background: eqOpen ? "rgb(from var(--accent-blue) r g b / 0.18)" : "var(--bg-secondary)",
            border: `1px solid ${eqOpen ? "var(--accent-blue)" : "var(--border-secondary)"}`,
            color: eqOpen ? "#8060e0" : "var(--text-tertiary)",
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexDirection: "column" as const,
            gap: 2,
            flexShrink: 0,
            transition: "all 0.15s ease",
            position: "relative" as const,
          }}
        >
          <span style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: "0.06em" }}>EQ</span>
          {/* Active dot */}
          {eqActive && (
            <div style={{
              position: "absolute",
              top: 3, right: 3,
              width: 4, height: 4, borderRadius: "50%",
              background: "#c07820",
              boxShadow: "0 0 4px #c07820",
            }} />
          )}
        </button>

      </div>
    </div>
  );
}
