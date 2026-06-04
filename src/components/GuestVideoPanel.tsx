import { useState, useEffect, useRef, useCallback } from "react";

interface GuestVideoState {
  id: string;
  name: string;
  status: "connecting" | "connected" | "dropped";
  hasVideo: boolean;
  stream?: MediaStream;
  muted: boolean;
  hidden: boolean;
  level: number; // 0-1 audio level
}

interface Props {
  guests: { id: string; name: string; status: string; hasVideo?: boolean }[];
  onClose: () => void;
}

export default function GuestVideoPanel({ guests: guestProps, onClose }: Props) {
  const [pos, setPos] = useState({ x: window.innerWidth - 500, y: 80 });
  const [size, setSize] = useState({ w: 460, h: 340 });
  const [minimized, setMinimized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });
  const resizeStart = useRef({ mx: 0, my: 0, ow: 0, oh: 0 });
  const [resizing, setResizing] = useState(false);
  const animRefs = useRef<Record<string, number>>({});

  const [guests, setGuests] = useState<GuestVideoState[]>([]);

  // Sync guests from props
  useEffect(() => {
    setGuests(prev => {
      const next = guestProps
        .filter(g => g.status === "connecting" || g.status === "connected")
        .map(g => {
          const existing = prev.find(p => p.id === g.id);
          return existing ?? {
            id: g.id,
            name: g.name,
            status: g.status as any,
            hasVideo: g.hasVideo ?? false,
            muted: false,
            hidden: false,
            level: 0,
          };
        });
      return next;
    });
  }, [guestProps]);

  // Simulate audio levels for connected guests
  useEffect(() => {
    guests.forEach(g => {
      if (g.status === "connected" && !animRefs.current[g.id]) {
        const tick = () => {
          setGuests(prev => prev.map(p => p.id === g.id ? {
            ...p,
            level: p.status === "connected" ? Math.min(1, Math.max(0, 0.1 + Math.random() * 0.7 + Math.sin(Date.now() / 300 + p.id.charCodeAt(0)) * 0.15)) : 0,
          } : p));
          animRefs.current[g.id] = requestAnimationFrame(tick);
        };
        animRefs.current[g.id] = requestAnimationFrame(tick);
      }
    });
    return () => { Object.values(animRefs.current).forEach(cancelAnimationFrame); animRefs.current = {}; };
  }, [guests.map(g => g.id + g.status).join()]);

  // Window drag
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: pos.x, oy: pos.y };
  }, [pos]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => setPos({ x: Math.max(0, dragStart.current.ox + e.clientX - dragStart.current.mx), y: Math.max(0, dragStart.current.oy + e.clientY - dragStart.current.my) });
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragging]);

  // Resize
  const startResize = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setResizing(true); resizeStart.current = { mx: e.clientX, my: e.clientY, ow: size.w, oh: size.h }; };
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => setSize({ w: Math.max(320, resizeStart.current.ow + e.clientX - resizeStart.current.mx), h: Math.max(200, resizeStart.current.oh + e.clientY - resizeStart.current.my) });
    const onUp = () => setResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [resizing]);

  const connected = guests.filter(g => g.status === "connected");
  const connecting = guests.filter(g => g.status === "connecting");

  return (
    <div style={{
      position: "fixed" as const,
      left: pos.x, top: pos.y,
      width: minimized ? 280 : size.w,
      height: "auto",
      maxHeight: minimized ? undefined : "80vh",
      zIndex: 11500,
      borderRadius: 0,
      background: "linear-gradient(160deg, rgba(14,14,22,0.97) 0%, rgba(8,8,14,0.98) 100%)",
      border: "1px solid rgba(255,255,255,0.07)",
      boxShadow: "0 24px 80px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.05)",
      display: "flex", flexDirection: "column" as const,
      overflow: "hidden",
      fontFamily: "'Inter', system-ui, sans-serif",
      userSelect: dragging ? "none" : "auto" as any,
    }}>

      {/* Title bar */}
      <div onMouseDown={startDrag} style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", borderBottom: minimized ? "none" : "1px solid rgba(255,255,255,0.05)", cursor: "grab", flexShrink: 0, userSelect: "none" }}>
        {/* Lights */}
        <div style={{ display: "flex", gap: 5 }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: "rgba(255,95,87,0.2)", border: "0.5px solid rgba(255,95,87,0.3)" }} />
          <button onClick={() => setMinimized(m => !m)} style={{ width: 10, height: 10, borderRadius: "50%", background: "#ffbd2e", border: "none", cursor: "pointer", padding: 0 }} title={minimized ? "Expand" : "Minimize"} />
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: "rgba(255,255,255,0.07)" }} />
        </div>

        <div style={{ flex: 1, paddingLeft: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: "rgba(255,255,255,0.8)", letterSpacing: "0.04em", textTransform: "uppercase" as const, fontFamily: "'Syne', sans-serif" }}>Guests</span>
            {connected.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "1px 7px", borderRadius: 0, background: "rgba(52,211,153,0.12)", border: "1px solid rgba(52,211,153,0.2)" }}>
                <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#34d399", animation: "guestBlink 2s ease-in-out infinite" }} />
                <span style={{ fontSize: 9, fontWeight: 800, color: "#34d399", letterSpacing: "0.08em" }}>{connected.length} LIVE</span>
              </div>
            )}
            {connecting.length > 0 && (
              <span style={{ fontSize: 9, color: "rgba(251,191,36,0.7)" }}>{connecting.length} joining...</span>
            )}
          </div>
        </div>

        <button onMouseDown={e => e.stopPropagation()} onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.18)", fontSize: 15, cursor: "pointer", padding: "0 2px", transition: "color 0.15s" }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.7)"}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.18)"}
        >×</button>
      </div>

      {/* Content */}
      {!minimized && (
        <div style={{ flex: 1, padding: 10, display: "flex", flexDirection: "column" as const, gap: 8, overflowY: "auto", minHeight: 0 }}>
          {guests.length === 0 ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 10 }}>
              <div style={{ width: 44, height: 44, borderRadius: 0, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>👥</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.3)" }}>No guests yet</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.15)", textAlign: "center" as const }}>Invite guests from the Guests tab in Podcast Studio</div>
            </div>
          ) : (
            <div style={{
              flex: 1, display: "grid",
              gridTemplateColumns: guests.length === 1 ? "1fr" : guests.length <= 4 ? "1fr 1fr" : "1fr 1fr 1fr",
              gap: 8, minHeight: 0,
            }}>
              {guests.map((g, i) => {
                const tile = (
                  <GuestTile key={g.id} guest={g}
                    onMute={() => setGuests(p => p.map(x => x.id === g.id ? { ...x, muted: !x.muted } : x))}
                    onHide={() => setGuests(p => p.map(x => x.id === g.id ? { ...x, hidden: !x.hidden } : x))}
                  />
                );
                // 3 guests: third card spans both columns
                if (guests.length === 3 && i === 2) {
                  return <div key={g.id} style={{ gridColumn: "1 / -1" }}>{tile}</div>;
                }
                return tile;
              })}
            </div>
          )}
        </div>
      )}

      {/* Resize handle */}
      {!minimized && (
        <div onMouseDown={startResize} style={{ position: "absolute" as const, bottom: 0, right: 0, width: 18, height: 18, cursor: "se-resize", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
            <path d="M9 1L1 9M5 1L1 5M9 5L5 9" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
      )}

      <style>{`
        @keyframes guestBlink { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes connecting-pulse { 0%,100%{opacity:0.4} 50%{opacity:1} }
      `}</style>
    </div>
  );
}

// ── Guest Tile ────────────────────────────────────────────────

function GuestTile({ guest, onMute, onHide }: { guest: GuestVideoState; onMute: () => void; onHide: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showControls, setShowControls] = useState(false);

  useEffect(() => {
    if (videoRef.current && guest.stream) videoRef.current.srcObject = guest.stream;
  }, [guest.stream]);

  const isConnecting = guest.status === "connecting";
  const hasLiveVideo = guest.hasVideo && guest.status === "connected" && !guest.hidden && guest.stream;
  const NUM_BARS = 16;

  return (
    <div
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
      style={{
        borderRadius: 0, overflow: "hidden", position: "relative" as const,
        background: isConnecting ? "rgba(251,191,36,0.05)" : "rgba(255,255,255,0.04)",
        border: `1px solid ${isConnecting ? "rgba(251,191,36,0.2)" : guest.status === "connected" ? "rgba(52,211,153,0.15)" : "rgba(255,255,255,0.07)"}`,
        transition: "border-color 0.3s",
        minHeight: 120,
        display: "flex", flexDirection: "column" as const,
      }}
    >
      {/* Video or placeholder */}
      {hasLiveVideo ? (
        <video ref={videoRef} autoPlay playsInline muted={guest.muted} style={{ width: "100%", flex: 1, objectFit: "cover", display: "block" }} />
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 8, padding: 16 }}>
          {isConnecting ? (
            <>
              <div style={{ width: 36, height: 36, borderRadius: "50%", border: "2px solid rgba(251,191,36,0.4)", borderTopColor: "#fbbf24", animation: "spin 0.8s linear infinite" }} />
              <div style={{ fontSize: 11, color: "rgba(251,191,36,0.7)", fontWeight: 600 }}>Joining...</div>
            </>
          ) : (
            <>
              {/* Avatar circle */}
              <div style={{
                width: 44, height: 44, borderRadius: "50%",
                background: `linear-gradient(135deg, rgba(96,64,192,0.3), rgba(167,139,250,0.3))`,
                border: "1px solid rgba(255,255,255,0.1)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18, fontWeight: 700, color: "rgba(255,255,255,0.8)",
              }}>
                {guest.name.charAt(0).toUpperCase()}
              </div>
              {/* Mini VU bars */}
              <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 20 }}>
                {Array.from({ length: NUM_BARS }).map((_, i) => {
                  const threshold = i / NUM_BARS;
                  const lit = !guest.muted && guest.level > threshold;
                  const color = i >= NUM_BARS - 2 ? "#ef4444" : i >= NUM_BARS - 5 ? "#fbbf24" : "#34d399";
                  const h = i < 5 ? 6 : i < 10 ? 10 : 16;
                  return <div key={i} style={{ width: 3, height: h, borderRadius: 0.5, background: lit ? color : "rgba(255,255,255,0.06)", transition: "background 0.04s" }} />;
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Name + status bar */}
      <div style={{ padding: "6px 10px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: isConnecting ? "#fbbf24" : guest.status === "connected" ? "#34d399" : "#ef4444", boxShadow: guest.status === "connected" ? "0 0 5px #34d399" : "none", animation: isConnecting ? "connecting-pulse 1s ease-in-out infinite" : "none" }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.8)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{guest.name}</span>
          {guest.hasVideo && !guest.hidden && <span style={{ fontSize: 9, color: "rgba(96,64,192,0.6)" }}>📷</span>}
        </div>

        {/* Controls — show on hover */}
        <div style={{ display: "flex", gap: 4, opacity: showControls && guest.status === "connected" ? 1 : 0, transition: "opacity 0.15s" }}>
          <button onClick={onMute} title={guest.muted ? "Unmute" : "Mute"} style={{ width: 22, height: 22, borderRadius: 0, background: guest.muted ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.06)", border: "none", cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center", color: guest.muted ? "#ef4444" : "rgba(255,255,255,0.5)" }}>
            {guest.muted ? "🔇" : "🎤"}
          </button>
          {guest.hasVideo && (
            <button onClick={onHide} title={guest.hidden ? "Show video" : "Hide video"} style={{ width: 22, height: 22, borderRadius: 0, background: guest.hidden ? "rgba(251,191,36,0.15)" : "rgba(255,255,255,0.06)", border: "none", cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {guest.hidden ? "👁" : "📷"}
            </button>
          )}
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
