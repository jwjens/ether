import { useState, useEffect, useRef } from "react";
import { engine } from "../audio/engine-rodio";
import { query } from "../db/client";

// ── Types ─────────────────────────────────────────────────────

export type DeckType = "music" | "mic" | "guest" | "cart";

export interface DeckConfig {
  slot: string;       // "A" | "B" | "C" | "D" | "E" | "F"
  type: DeckType;
  label: string;
  color: string;
  enabled: boolean;
}

export interface PlaylistTrack {
  id: number;
  title: string;
  artist: string;
  filePath: string;
  durationMs: number;
}

const SLOTS = ["A", "B", "C", "D", "E", "F"];
const TYPE_META: Record<DeckType, { label: string; icon: string; color: string; desc: string }> = {
  music:  { label: "Music",    icon: "🎵", color: "#34d399", desc: "Play tracks from library or playlist" },
  mic:    { label: "Mic",      icon: "🎙",  color: "#ef4444", desc: "Live microphone input channel" },
  guest:  { label: "Guest",    icon: "👤",  color: "#38bdf8", desc: "Remote guest audio (WebRTC)" },
  cart:   { label: "Cart",     icon: "⚡",  color: "#fbbf24", desc: "Hot-key sound effects & stingers" },
};

const DEFAULT_CONFIGS: DeckConfig[] = [
  { slot: "A", type: "music", label: "Deck A", color: "#34d399", enabled: true },
  { slot: "B", type: "music", label: "Deck B", color: "#38bdf8", enabled: true },
  { slot: "C", type: "music", label: "Deck C", color: "#a78bfa", enabled: true },
  { slot: "D", type: "music", label: "Deck D", color: "#f97316", enabled: false },
  { slot: "E", type: "music", label: "Deck E", color: "#ef4444", enabled: false },
  { slot: "F", type: "music", label: "Deck F", color: "#a78bfa", enabled: false },
];

const STORAGE_KEY = "ether_deck_config_v1";

export function useDeckConfig() {
  const [configs, setConfigs] = useState<DeckConfig[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : DEFAULT_CONFIGS;
    } catch { return DEFAULT_CONFIGS; }
  });

  const save = (next: DeckConfig[]) => {
    setConfigs(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const enabled = configs.filter(c => c.enabled);
  return { configs, save, enabled };
}

// ── Deck Configurator Panel ───────────────────────────────────

interface Props {
  onClose: () => void;
  onApply: (configs: DeckConfig[]) => void;
}

export default function DeckConfigurator({ onClose, onApply }: Props) {
  const [configs, setConfigs] = useState<DeckConfig[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : DEFAULT_CONFIGS;
    } catch { return DEFAULT_CONFIGS; }
  });

  const enabled = configs.filter(c => c.enabled);
  const musicCount = enabled.filter(c => c.type === "music").length;
  const micCount = enabled.filter(c => c.type === "mic").length;
  const guestCount = enabled.filter(c => c.type === "guest").length;
  const cartCount = enabled.filter(c => c.type === "cart").length;

  const toggle = (slot: string) => {
    setConfigs(p => p.map(c => {
      if (c.slot !== slot) return c;
      // Max 6 enabled at once
      if (!c.enabled && enabled.length >= 6) return c;
      return { ...c, enabled: !c.enabled };
    }));
  };

  const setType = (slot: string, type: DeckType) => {
    setConfigs(p => p.map(c => c.slot === slot ? {
      ...c, type,
      color: TYPE_META[type].color,
      label: type === "mic" ? "Mic" : type === "guest" ? `Guest ${p.filter(x => x.type === "guest" && x.slot !== slot).length + 1}` : `Deck ${slot}`,
    } : c));
  };

  const apply = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
    onApply(configs);
    onClose();
  };

  return (
    <div style={{
      position: "fixed" as const, inset: 0, zIndex: 10000,
      background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        width: 580, maxHeight: "80vh", borderRadius: 18,
        background: "var(--bg-secondary)", border: "1px solid var(--border-secondary)",
        boxShadow: "0 32px 80px rgba(0,0,0,0.5)",
        display: "flex", flexDirection: "column" as const,
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 4 }}>Live Assist</div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", fontFamily: "'Syne', sans-serif", marginBottom: 4 }}>Configure Decks</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Choose up to 6 decks. Mix music, mic, guest, and cart channels however you need.</div>
        </div>

        {/* Summary pills */}
        <div style={{ padding: "12px 24px", borderBottom: "1px solid var(--border-primary)", display: "flex", gap: 8, flexShrink: 0 }}>
          {([["music", musicCount], ["mic", micCount], ["guest", guestCount], ["cart", cartCount]] as [DeckType, number][]).map(([type, count]) => (
            <div key={type} style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "4px 10px", borderRadius: 20,
              background: count > 0 ? `${TYPE_META[type].color}15` : "var(--bg-tertiary)",
              border: `1px solid ${count > 0 ? TYPE_META[type].color + "30" : "var(--border-primary)"}`,
            }}>
              <span style={{ fontSize: 11 }}>{TYPE_META[type].icon}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: count > 0 ? TYPE_META[type].color : "var(--text-tertiary)" }}>
                {count} {TYPE_META[type].label}
              </span>
            </div>
          ))}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: enabled.length >= 6 ? "var(--accent-red)" : "var(--accent-green)" }} />
            <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>{enabled.length}/6</span>
          </div>
        </div>

        {/* Deck slots */}
        <div style={{ flex: 1, overflowY: "auto" as const, padding: "16px 24px" }}>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
            {configs.map(c => (
              <div key={c.slot} style={{
                borderRadius: 12, border: `1px solid ${c.enabled ? c.color + "40" : "var(--border-primary)"}`,
                background: c.enabled ? `${c.color}08` : "var(--bg-tertiary)",
                overflow: "hidden", transition: "all 0.2s",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
                  {/* Slot badge */}
                  <div style={{
                    width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                    background: c.enabled ? c.color : "var(--bg-secondary)",
                    border: `1px solid ${c.enabled ? c.color : "var(--border-primary)"}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 800,
                    color: c.enabled ? "#000" : "var(--text-tertiary)",
                    transition: "all 0.2s",
                  }}>{c.slot}</div>

                  {/* Type selector */}
                  <div style={{ display: "flex", gap: 4, flex: 1 }}>
                    {(Object.keys(TYPE_META) as DeckType[]).map(type => (
                      <button
                        key={type}
                        onClick={() => {
                          setConfigs(p => {
                            const alreadyEnabled = p.find(x => x.slot === c.slot)?.enabled;
                            const enabledCount = p.filter(x => x.enabled).length;
                            // If not enabled and already at max, do nothing
                            if (!alreadyEnabled && enabledCount >= 6) return p;
                            return p.map(x => x.slot === c.slot ? {
                              ...x,
                              enabled: true,
                              type,
                              color: TYPE_META[type].color,
                              label: type === "mic" ? "Mic" : type === "guest" ? `Guest ${p.filter(g => g.type === "guest" && g.slot !== c.slot).length + 1}` : type === "cart" ? `Cart ${p.filter(g => g.type === "cart" && g.slot !== c.slot).length + 1}` : `Deck ${x.slot}`,
                            } : x);
                          });
                        }}
                        disabled={!c.enabled && enabled.length >= 6}
                        style={{
                          display: "flex", alignItems: "center", gap: 4,
                          padding: "5px 10px", borderRadius: 8, border: "none",
                          background: c.type === type && c.enabled ? `${TYPE_META[type].color}20` : "var(--bg-secondary)",
                          border: `1px solid ${c.type === type && c.enabled ? TYPE_META[type].color + "50" : "var(--border-primary)"}`,
                          color: c.type === type && c.enabled ? TYPE_META[type].color : "var(--text-tertiary)",
                          fontSize: 11, fontWeight: c.type === type ? 700 : 400,
                          cursor: "pointer", transition: "all 0.15s", opacity: !c.enabled && enabled.length >= 6 ? 0.4 : 1,
                        }}
                        title={TYPE_META[type].desc}
                      >
                        <span>{TYPE_META[type].icon}</span>
                        <span>{TYPE_META[type].label}</span>
                      </button>
                    ))}
                  </div>

                  {/* Enable toggle */}
                  <button
                    onClick={() => toggle(c.slot)}
                    style={{
                      width: 40, height: 22, borderRadius: 11, border: "none",
                      background: c.enabled ? c.color : "var(--bg-tertiary)",
                      cursor: enabled.length >= 6 && !c.enabled ? "not-allowed" : "pointer",
                      position: "relative" as const, flexShrink: 0,
                      transition: "background 0.2s", opacity: !c.enabled && enabled.length >= 6 ? 0.4 : 1,
                    }}
                    title={c.enabled ? "Remove deck" : enabled.length >= 6 ? "Maximum 6 decks" : "Add deck"}
                  >
                    <div style={{
                      width: 16, height: 16, borderRadius: "50%", background: "#fff",
                      position: "absolute" as const, top: 3,
                      left: c.enabled ? 21 : 3,
                      transition: "left 0.2s",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                    }} />
                  </button>
                </div>

                {/* Type description */}
                {c.enabled && (
                  <div style={{ padding: "0 14px 10px", paddingLeft: 58 }}>
                    <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{TYPE_META[c.type].desc}</span>
                    {c.type === "music" && (
                      <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}> · Uses queue or standalone playlist</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "16px 24px", borderTop: "1px solid var(--border-primary)", display: "flex", gap: 10, flexShrink: 0 }}>
          <button onClick={() => {
            localStorage.removeItem(STORAGE_KEY);
            onApply([
              { slot: "A", type: "music", label: "Deck A", color: "#34d399", enabled: true },
              { slot: "B", type: "music", label: "Deck B", color: "#38bdf8", enabled: true },
              { slot: "C", type: "music", label: "Deck C", color: "#a78bfa", enabled: true },
            ]);
            onClose();
          }} style={{ padding: "11px 14px", borderRadius: 10, background: "none", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const }}>
            Reset Default
          </button>
          <button onClick={onClose} style={{ flex: 1, padding: "11px", borderRadius: 10, background: "none", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={apply} style={{ flex: 2, padding: "11px", borderRadius: 10, background: "var(--accent-cyan)", border: "none", color: "#000", fontSize: 12, fontWeight: 800, cursor: "pointer", letterSpacing: "0.02em" }}>
            Apply Layout
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Standalone Playlist Player ────────────────────────────────
// For podcasters/venues not pulling from the main radio queue

interface PlaylistProps {
  deckSlot: string;
  color: string;
}

export function PlaylistPlayer({ deckSlot, color }: PlaylistProps) {
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [currentIdx, setCurrentIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [search, setSearch] = useState("");
  const [library, setLibrary] = useState<PlaylistTrack[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);

  useEffect(() => {
    query<PlaylistTrack>("SELECT id, title, artist, file_path as filePath, duration_ms as durationMs FROM songs ORDER BY artist, title LIMIT 200")
      .then(rows => setLibrary(rows))
      .catch(() => {});
  }, []);

  const filtered = search
    ? library.filter(s => `${s.title} ${s.artist}`.toLowerCase().includes(search.toLowerCase()))
    : library;

  const addTrack = (t: PlaylistTrack) => {
    setTracks(p => [...p, t]);
  };

  const removeTrack = (idx: number) => {
    setTracks(p => p.filter((_, i) => i !== idx));
    if (currentIdx !== null && idx <= currentIdx) setCurrentIdx(i => i !== null ? Math.max(0, i - 1) : null);
  };

  const playIdx = async (idx: number) => {
    const t = tracks[idx];
    if (!t) return;
    try {
      await engine.loadToDeck(deckSlot, t.filePath, t.title, t.artist);
      engine.getDeck(deckSlot)?.play();
      setCurrentIdx(idx);
      setPlaying(true);
    } catch {}
  };

  const fmtDur = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const totalMin = Math.round(tracks.reduce((s, t) => s + (t.durationMs || 0), 0) / 60000);

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, height: "100%", fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ padding: "10px 14px 8px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", color, textTransform: "uppercase" as const }}>Playlist · Deck {deckSlot}</div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 1 }}>{tracks.length} tracks · {totalMin} min</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => playIdx(Math.max(0, (currentIdx ?? 0) - 1))} style={{ width: 28, height: 28, borderRadius: 7, background: "var(--bg-tertiary)", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 12 }}>⏮</button>
            <button
              onClick={() => { if (playing) { engine.getDeck(deckSlot)?.pause(); setPlaying(false); } else if (currentIdx !== null) { engine.getDeck(deckSlot)?.play(); setPlaying(true); } else if (tracks.length > 0) { playIdx(0); } }}
              style={{ width: 36, height: 28, borderRadius: 7, background: color, border: "none", color: "#000", cursor: "pointer", fontSize: 13, fontWeight: 700 }}
            >{playing ? "⏸" : "▶"}</button>
            <button onClick={() => playIdx((currentIdx ?? -1) + 1)} style={{ width: 28, height: 28, borderRadius: 7, background: "var(--bg-tertiary)", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 12 }}>⏭</button>
            <button onClick={() => setShowLibrary(p => !p)} style={{ height: 28, padding: "0 10px", borderRadius: 7, background: showLibrary ? color : "var(--bg-tertiary)", border: "none", color: showLibrary ? "#000" : "var(--text-secondary)", cursor: "pointer", fontSize: 10, fontWeight: 600 }}>
              + Add
            </button>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Playlist */}
        <div style={{ flex: 1, overflowY: "auto" as const }}>
          {tracks.length === 0 ? (
            <div style={{ padding: "24px 14px", textAlign: "center" as const, color: "var(--text-tertiary)" }}>
              <div style={{ fontSize: 24, marginBottom: 6 }}>🎵</div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>Empty playlist</div>
              <div style={{ fontSize: 10 }}>Click Add to browse your library</div>
            </div>
          ) : (
            tracks.map((t, i) => (
              <div
                key={i}
                onDoubleClick={() => playIdx(i)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "7px 14px",
                  background: i === currentIdx ? `${color}12` : "none",
                  borderLeft: i === currentIdx ? `2px solid ${color}` : "2px solid transparent",
                  cursor: "default",
                  transition: "all 0.1s",
                }}
              >
                <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", width: 20, textAlign: "right" as const, flexShrink: 0 }}>
                  {i === currentIdx && playing ? "▶" : i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: i === currentIdx ? 700 : 500, color: i === currentIdx ? color : "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{t.title}</div>
                  <div style={{ fontSize: 10, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{t.artist}</div>
                </div>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>{fmtDur(t.durationMs || 0)}</span>
                <button onClick={() => removeTrack(i)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14, opacity: 0.5, padding: "0 2px", flexShrink: 0 }}>×</button>
              </div>
            ))
          )}
        </div>

        {/* Library picker */}
        {showLibrary && (
          <div style={{ width: 220, borderLeft: "1px solid var(--border-primary)", display: "flex", flexDirection: "column" as const }}>
            <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search library..."
                style={{ width: "100%", padding: "5px 8px", borderRadius: 7, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 11, outline: "none", boxSizing: "border-box" as const }}
              />
            </div>
            <div style={{ flex: 1, overflowY: "auto" as const }}>
              {filtered.slice(0, 100).map(t => (
                <div
                  key={t.id}
                  onClick={() => addTrack(t)}
                  style={{ padding: "6px 10px", cursor: "pointer", transition: "background 0.1s" }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "none"}
                >
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{t.title}</div>
                  <div style={{ fontSize: 9, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{t.artist}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Boutique Cart Wall ─────────────────────────────────────────

interface CartSlot {
  key: string;
  label: string;
  filePath?: string;
  color: string;
  playing: boolean;
}

const DEFAULT_CART_KEYS = ["1","2","3","4","5","6","7","8","9","0","Q","W","E","R","T","Y","U","I"];
const CART_COLORS = ["#ef4444","#f97316","#fbbf24","#34d399","#38bdf8","#a78bfa","#ec4899","#14b8a6","#6366f1","#84cc16"];

interface CartProps {
  deckSlot: string;
  compact?: boolean;
}

export function BoutiqueCartWall({ deckSlot, compact }: CartProps) {
  const [carts, setCarts] = useState<CartSlot[]>(
    DEFAULT_CART_KEYS.map((k, i) => ({
      key: k, label: `Cart ${i + 1}`, color: CART_COLORS[i % CART_COLORS.length], playing: false,
    }))
  );
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const cart = carts.find(c => c.key === e.key.toUpperCase());
      if (cart?.filePath) {
        fireCart(cart.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [carts]);

  const fireCart = async (key: string) => {
    const cart = carts.find(c => c.key === key);
    if (!cart?.filePath) return;
    try {
      await engine.loadToDeck(deckSlot, cart.filePath, cart.label, "");
      engine.getDeck(deckSlot)?.play();
      setCarts(p => p.map(c => c.key === key ? { ...c, playing: true } : c));
      setTimeout(() => setCarts(p => p.map(c => c.key === key ? { ...c, playing: false } : c)), 2000);
    } catch {}
  };

  const handleDrop = (e: React.DragEvent, key: string) => {
    e.preventDefault();
    const label = e.dataTransfer.getData("text/plain");
    const filePath = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    setCarts(p => p.map(c => c.key === key ? { ...c, label: label || c.label, filePath } : c));
    setDragOver(null);
  };

  const editLabel = (key: string) => {
    const cart = carts.find(c => c.key === key);
    const newLabel = prompt("Cart label:", cart?.label);
    if (newLabel) setCarts(p => p.map(c => c.key === key ? { ...c, label: newLabel } : c));
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" as const, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Header — hidden in compact to save space */}
      {!compact && (
        <div style={{ padding: "10px 14px 8px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", color: "#fbbf24", textTransform: "uppercase" as const }}>Cart Wall · Deck {deckSlot}</div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 1 }}>Press key or click to fire · Drop audio to assign</div>
          </div>
          <div style={{ fontSize: 9, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>
            {carts.filter(c => c.filePath).length}/{carts.length} loaded
          </div>
        </div>
      )}

      {compact ? (
        /* Compact: single column of carts, scrollable, fits in channel strip */
        <div style={{
          flex: 1, padding: "6px 6px 6px 6px", overflowY: "auto" as const,
          display: "flex", flexDirection: "column" as const, gap: 4,
        }}>
          {carts.slice(0, 9).map(cart => (
            <div
              key={cart.key}
              onClick={() => fireCart(cart.key)}
              onDoubleClick={() => editLabel(cart.key)}
              onDragOver={e => { e.preventDefault(); setDragOver(cart.key); }}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => handleDrop(e, cart.key)}
              style={{
                padding: "5px 8px",
                borderRadius: 7,
                background: cart.playing ? cart.color : cart.filePath ? `${cart.color}15` : "var(--bg-tertiary)",
                border: `1px solid ${cart.playing ? cart.color : cart.filePath ? cart.color + "40" : "var(--border-primary)"}`,
                cursor: cart.filePath ? "pointer" : "default",
                transition: "all 0.1s",
                display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
              }}
            >
              <span style={{ fontSize: 9, fontWeight: 800, fontFamily: "'DM Mono',monospace", color: cart.playing ? "#000" : cart.color, minWidth: 12 }}>{cart.key}</span>
              <span style={{ fontSize: 9, fontWeight: cart.filePath ? 700 : 400, color: cart.playing ? "#000" : cart.filePath ? "var(--text-primary)" : "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1, fontStyle: cart.filePath ? "normal" : "italic" }}>
                {cart.filePath ? cart.label : "Empty"}
              </span>
            </div>
          ))}
        </div>
      ) : (
      <div style={{
        flex: 1, padding: 12, overflowY: "auto" as const,
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8,
        alignContent: "start",
      }}>
        {carts.map(cart => (
          <div
            key={cart.key}
            onClick={() => fireCart(cart.key)}
            onDoubleClick={() => editLabel(cart.key)}
            onDragOver={e => { e.preventDefault(); setDragOver(cart.key); }}
            onDragLeave={() => setDragOver(null)}
            onDrop={e => handleDrop(e, cart.key)}
            style={{
              padding: "10px 10px 8px",
              borderRadius: 10,
              background: cart.playing ? cart.color : dragOver === cart.key ? `${cart.color}20` : cart.filePath ? `${cart.color}10` : "var(--bg-tertiary)",
              border: `1px solid ${cart.playing ? cart.color : dragOver === cart.key ? cart.color + "60" : cart.filePath ? cart.color + "30" : "var(--border-primary)"}`,
              cursor: cart.filePath ? "pointer" : "default",
              transition: "all 0.12s",
              boxShadow: cart.playing ? `0 0 16px ${cart.color}50` : "none",
              animation: cart.playing ? "on-air-breathe 0.8s ease-in-out infinite" : "none",
              position: "relative" as const,
              minHeight: 70,
            }}
          >
            {/* Hotkey badge */}
            <div style={{
              position: "absolute" as const, top: 6, right: 7,
              fontSize: 9, fontWeight: 800, fontFamily: "'DM Mono', monospace",
              color: cart.playing ? "rgba(0,0,0,0.7)" : cart.filePath ? cart.color : "var(--text-tertiary)",
              letterSpacing: "0.06em",
            }}>{cart.key}</div>

            {/* Label */}
            <div style={{
              fontSize: 11, fontWeight: cart.filePath ? 700 : 400,
              color: cart.playing ? "#000" : cart.filePath ? "var(--text-primary)" : "var(--text-tertiary)",
              lineHeight: 1.3, paddingRight: 16,
              fontStyle: cart.filePath ? "normal" : "italic",
            }}>
              {cart.filePath ? cart.label : "Empty"}
            </div>

            {/* Playing indicator */}
            {cart.playing && (
              <div style={{ marginTop: 4, display: "flex", gap: 2, alignItems: "flex-end", height: 12 }}>
                {[0.6, 1, 0.8, 1, 0.6].map((h, i) => (
                  <div key={i} style={{ flex: 1, height: `${h * 100}%`, background: "rgba(0,0,0,0.5)", borderRadius: 1 }} />
                ))}
              </div>
            )}

            {!cart.filePath && (
              <div style={{ marginTop: 4, fontSize: 9, color: "var(--text-tertiary)" }}>Drop audio here</div>
            )}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
