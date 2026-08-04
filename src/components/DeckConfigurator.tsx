import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useAudioEngine } from "../audio/AudioEngineContext";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

// ── Types ─────────────────────────────────────────────────────

export type DeckType = "music" | "mic" | "guest" | "cart" | "desk" | "video";

export interface DeckConfig {
  slot: string;       // "A" | "B" | "C" | "D" | "E" | "F"
  type: DeckType;
  label: string;
  color: string;
  enabled: boolean;
  purpose?: string;   // If set, deck is always visible regardless of experience mode
}

export interface PlaylistTrack {
  id: number;
  title: string;
  artist: string;
  filePath: string;
  durationMs: number;
}

// Deck slots are defined in the database (electron/main.js seedDeckConfigs).
// Do not hardcode deck lists here. UI code only reads from the database.

// Slot ordering is DATA-DRIVEN — no fixed list, no six-slot ceiling. Slots sort
// naturally (A, B, C … Z, then AA), so a slot added by a plain INSERT lands in the right
// place with no code change. The old `["A".."F"].indexOf()` sorted any unknown slot to
// -1, silently placing it first.
export function compareSlots(a: { slot: string }, b: { slot: string }): number {
  return String(a.slot).localeCompare(String(b.slot), undefined, { numeric: true, sensitivity: "base" });
}

const TYPE_META: Record<DeckType, { label: string; icon: string; color: string; desc: string }> = {
  music:  { label: "Music",        icon: "🎵", color: "#34d399", desc: "Play tracks from library or playlist" },
  mic:    { label: "Mic",          icon: "🎙",  color: "#ef4444", desc: "Live microphone input channel" },
  guest:  { label: "Guest",        icon: "👤",  color: "var(--accent-blue)", desc: "Remote guest audio (WebRTC)" },
  cart:   { label: "Cart",         icon: "⚡",  color: "#fbbf24", desc: "Hot-key sound effects & stingers" },
  desk:   { label: "Desk",         icon: "🎛️",  color: "#a78bfa", desc: "Producer desk — carts, jingles & production tools" },
  video:  { label: "Video Studio", icon: "🎥",  color: "var(--accent-blue)", desc: "Live video camera, streaming & recording — spans 3 decks" },
};

// ── useDeckConfig ─────────────────────────────────────────────
// Reads from and writes to the deck_configs SQLite table.
// The DB is seeded with all 6 slots (A-F) on every app startup
// in electron/main.js before the window loads — they can never
// disappear regardless of what UI code does.
export function useDeckConfig() {
  const { stationId, isReady } = useActiveStation();
  const [configs, setConfigs] = useState<DeckConfig[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isReady) return;
    // Depends on stationId: switching station must RE-READ that station's decks. With
    // [isReady] alone the list loaded at mount persisted across switches, so a station
    // could show another station's deck layout.
    queryScoped<{ slot: string; type: string; label: string; color: string; enabled: number; purpose: string }>(
      "SELECT slot, type, label, color, enabled, COALESCE(purpose,'') as purpose FROM deck_configs ORDER BY slot",
      [], stationId
    ).then(rows => {
      const sorted = [...rows].sort(compareSlots);
      setConfigs(sorted.map(r => ({ ...r, type: r.type as DeckType, enabled: r.enabled === 1 })));
      setError(null);
    }).catch(e => {
      console.error("[DeckConfig] Failed to load from DB:", e);
      setError(String(e?.message || e));
    });
  }, [isReady, stationId]);

  const save = async (next: DeckConfig[]) => {
    // Every write is INSPECTED. This used to fire and forget, then update the UI
    // unconditionally — so on a station with no rows the panel showed the new layout
    // while the database received nothing, and the failure was invisible.
    const results = await Promise.all(next.map(async c => {
      const res = await (window as any).ether.deckConfigs.updateBySlot(stationId, c.slot, {
        type: c.type, label: c.label, color: c.color,
        enabled: c.enabled ? 1 : 0, purpose: c.purpose || "",
      });
      return { slot: c.slot, res };
    }));
    const failed = results.filter(r => r.res && r.res.ok === false);
    if (failed.length) {
      const msg = `Could not save ${failed.length} deck slot(s): ` +
        failed.map(f => `${f.slot} (${f.res.error || "unknown error"})`).join(", ");
      console.error("[DeckConfig]", msg);
      setError(msg);
      throw new Error(msg);       // the caller decides what to show; never a silent success
    }
    setError(null);
    setConfigs([...next].sort(compareSlots));
  };

  const enabled = useMemo(() => configs.filter(c => c.enabled), [configs]);
  return { configs, save, enabled };
}

// ── Deck Configurator Panel ───────────────────────────────────

interface Props {
  onClose: () => void;
  onApply: (configs: DeckConfig[]) => void;
}

export default function DeckConfigurator({ onClose, onApply }: Props) {
  const engine = useAudioEngine();
  // Deck slots are defined in the database. Do not hardcode deck lists here.
  const { configs: dbConfigs, save } = useDeckConfig();
  const [configs, setConfigs] = useState<DeckConfig[]>([]);

  // Sync local editing state from DB once loaded
  useEffect(() => {
    if (dbConfigs.length > 0 && configs.length === 0) setConfigs(dbConfigs);
  }, [dbConfigs]);

  const enabled = configs.filter(c => c.enabled);
  const musicCount = enabled.filter(c => c.type === "music").length;
  const micCount = enabled.filter(c => c.type === "mic").length;
  const guestCount = enabled.filter(c => c.type === "guest").length;
  const cartCount = enabled.filter(c => c.type === "cart").length;
  const deskCount = enabled.filter(c => c.type === "desk").length;
  const videoCount = enabled.filter(c => c.type === "video").length;

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
      label: type === "mic" ? "Mic" : type === "guest" ? `Guest ${p.filter(x => x.type === "guest" && x.slot !== slot).length + 1}` : type === "desk" ? "Desk" : `Deck ${slot}`,
    } : c));
  };

  const apply = async () => {
    await save(configs);
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
        width: 680, maxHeight: "80vh", borderRadius: 0,
        background: "var(--bg-secondary)", border: "1px solid var(--border-secondary)",
        boxShadow: "0 32px 80px rgba(0,0,0,0.5)",
        display: "flex", flexDirection: "column" as const,
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 4 }}>Live Assist</div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", fontFamily: "'Newsreader', Georgia, serif", marginBottom: 4 }}>Configure Decks</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Choose up to 6 decks. Mix music, mic, guest, and cart channels however you need.</div>
        </div>

        {/* Summary pills */}
        <div style={{ padding: "12px 24px", borderBottom: "1px solid var(--border-primary)", display: "flex", gap: 8, flexShrink: 0 }}>
          {([["music", musicCount], ["mic", micCount], ["guest", guestCount], ["cart", cartCount], ["desk", deskCount], ["video", videoCount]] as [DeckType, number][]).map(([type, count]) => (
            <div key={type} style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "4px 10px", borderRadius: 0,
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
                borderRadius: 0, border: `1px solid ${c.color}40`,
                background: `${c.color}08`,
                overflow: "hidden", transition: "all 0.2s",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
                  {/* Slot badge */}
                  <div style={{
                    width: 32, height: 32, borderRadius: 0, flexShrink: 0,
                    background: c.color,
                    border: `1px solid ${c.color}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontFamily: "'Newsreader', Georgia, serif", fontSize: 13, fontWeight: 800,
                    color: "#000",
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
                              label: type === "mic" ? "Mic" : type === "guest" ? `Guest ${p.filter(g => g.type === "guest" && g.slot !== c.slot).length + 1}` : type === "cart" ? `Cart ${p.filter(g => g.type === "cart" && g.slot !== c.slot).length + 1}` : type === "desk" ? "Desk" : `Deck ${x.slot}`,
                            } : x);
                          });
                        }}
                        disabled={!c.enabled && enabled.length >= 6}
                        style={{
                          display: "flex", alignItems: "center", gap: 4,
                          padding: "5px 10px", borderRadius: 0,
                          background: c.type === type ? `${TYPE_META[type].color}20` : "var(--bg-secondary)",
                          border: `1px solid ${c.type === type ? TYPE_META[type].color + "50" : "var(--border-primary)"}`,
                          color: c.type === type ? TYPE_META[type].color : "var(--text-tertiary)",
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
                      width: 40, height: 22, borderRadius: 0, border: "none",
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

                {/* Type description + Purpose */}
                <div style={{ padding: "0 14px 10px", paddingLeft: 58, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" as const }}>
                    <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{TYPE_META[c.type].desc}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
                      <span style={{ fontSize: 9, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as const }}>Purpose</span>
                      <select
                        value={c.purpose || ""}
                        onChange={e => setConfigs(p => p.map(x => x.slot === c.slot ? { ...x, purpose: e.target.value } : x))}
                        style={{ fontSize: 10, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", borderRadius: 0, padding: "2px 6px", cursor: "pointer" }}
                        title="Decks with a purpose are always visible regardless of experience mode"
                      >
                        <option value="">— none (follows mode)</option>
                        <option value="music">Music</option>
                        <option value="mic">Mic Input</option>
                        <option value="cart">Cart / SFX</option>
                        <option value="phone">Phone Line</option>
                        <option value="guest">Guest Feed</option>
                        <option value="video">Video Studio</option>
                        <option value="custom">Custom</option>
                      </select>
                    </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "16px 24px", borderTop: "1px solid var(--border-primary)", display: "flex", gap: 10, flexShrink: 0 }}>
          <button onClick={async () => {
            // Deck slots are defined in the database. Do not hardcode deck lists here.
            const result = await (window as any).ether.invoke("deck-configs:reset");
            if (result?.data) {
              const fresh = result.data.map((r: any) => ({ ...r, type: r.type as DeckType, enabled: r.enabled === 1 }));
              setConfigs(fresh);
              onApply(fresh);
              onClose();
            }
          }} style={{ padding: "11px 14px", borderRadius: 0, background: "none", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const }}>
            Reset Default
          </button>
          <button onClick={onClose} style={{ flex: 1, padding: "11px", borderRadius: 0, background: "none", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={apply} style={{ flex: 2, padding: "11px", borderRadius: 0, background: "var(--accent-cyan)", border: "none", color: "#000", fontSize: 12, fontWeight: 800, cursor: "pointer", letterSpacing: "0.02em" }}>
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
  const engine = useAudioEngine();
  const { stationId, isReady } = useActiveStation();
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [currentIdx, setCurrentIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [search, setSearch] = useState("");
  const [library, setLibrary] = useState<PlaylistTrack[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);

  useEffect(() => {
    if (!isReady) return;
    queryScoped<PlaylistTrack>("SELECT id, title, artist, file_path as filePath, duration_ms as durationMs FROM songs ORDER BY artist, title LIMIT 200", [], stationId)
      .then(rows => setLibrary(rows))
      .catch(() => {});
  }, [isReady]);

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
            <button onClick={() => playIdx(Math.max(0, (currentIdx ?? 0) - 1))} style={{ width: 28, height: 28, borderRadius: 0, background: "var(--bg-tertiary)", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 12 }}>⏮</button>
            <button
              onClick={() => { if (playing) { engine.getDeck(deckSlot)?.pause(); setPlaying(false); } else if (currentIdx !== null) { engine.getDeck(deckSlot)?.play(); setPlaying(true); } else if (tracks.length > 0) { playIdx(0); } }}
              style={{ width: 36, height: 28, borderRadius: 0, background: color, border: "none", color: "#000", cursor: "pointer", fontSize: 13, fontWeight: 700 }}
            >{playing ? "⏸" : "▶"}</button>
            <button onClick={() => playIdx((currentIdx ?? -1) + 1)} style={{ width: 28, height: 28, borderRadius: 0, background: "var(--bg-tertiary)", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 12 }}>⏭</button>
            <button onClick={() => setShowLibrary(p => !p)} style={{ height: 28, padding: "0 10px", borderRadius: 0, background: showLibrary ? color : "var(--bg-tertiary)", border: "none", color: showLibrary ? "#000" : "var(--text-secondary)", cursor: "pointer", fontSize: 10, fontWeight: 600 }}>
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
                style={{ width: "100%", padding: "5px 8px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 11, outline: "none", boxSizing: "border-box" as const }}
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
  /** slot_number in cart_slots — the DB's identity for this tile, and the wall's ordering. */
  slot: number;
  label: string;
  filePath?: string;
  color: string;
  playing: boolean;
}

// ── CART WALL SIZING — derived, never hardcoded at a use site ─────────────────────────────────────
// Every count below is a named constant so the wall can grow without a rebuild. The 18-slot literal
// that used to live here (and a matching `18` in ProducerDesk, and a slice(0, 8) in the strip render)
// was the ceiling this replaces.
export const CART_SLOT_COUNT = 64;        // the full wall
export const CART_STRIP_COUNT = 24;       // the bottom push-up strip — 3 rows of 8
export const CART_STRIP_ROWS = 3;         // rows VISIBLE in the push-up before it scrolls (all 64 render)
export const CART_ROW = 8;                // tiles per row at full width

// HOTKEYS: the first CART_STRIP_COUNT slots only — three keyboard rows, no bank/shift modifier, no
// modes (Jeff, 2026-07-31). Slots beyond that are click- and MIDI-only and keep hotkey NULL, which is
// exactly what the cart_slots.hotkey column stores.
const CART_HOTKEYS = [
  "1","2","3","4","5","6","7","8",
  "Q","W","E","R","T","Y","U","I",
  "A","S","D","F","G","H","J","K",
];
const cartHotkey = (slot: number): string => CART_HOTKEYS[slot] ?? "";
/** Stable per-slot identity. The DB keys by slot_number; the UI keeps using `key` internally. */
const cartKeyFor = (slot: number): string => cartHotkey(slot) || `c${slot + 1}`;
const CART_COLORS = ["#ef4444","#f97316","#fbbf24","#34d399","var(--accent-blue)","#a78bfa","#ec4899","#14b8a6","#6366f1","#84cc16"];

/** The default wall for a station that has never had one — labels only, no audio. */
function defaultCarts(): CartSlot[] {
  return Array.from({ length: CART_SLOT_COUNT }, (_, i) => ({
    key: cartKeyFor(i), slot: i, label: `Cart ${i + 1}`,
    color: CART_COLORS[i % CART_COLORS.length], playing: false,
  }));
}

interface CartProps {
  deckSlot: string;
  compact?: boolean;
  variant?: "grid" | "strip"; // "strip" = single row of 8 square carts + side VU
}

export function BoutiqueCartWall({ deckSlot, compact, variant }: CartProps) {
  const engine = useAudioEngine();
  // Carts ALWAYS fire on the dedicated cart channel (native mixer slot "CART") — never
  // an assignable deck (A–F may be a mic/guest/video). It's summed to master, so carts
  // play out over the music regardless of how the decks are configured. deckSlot is now
  // only a label/positioning hint.
  const CART_CHANNEL = "CART";
  const { stationId } = useActiveStation();
  const [carts, setCarts] = useState<CartSlot[]>(defaultCarts);

  // ── PERSISTENCE (2026-07-31) ────────────────────────────────────────────────────────────────────
  // Before this, the wall lived entirely in React state seeded from a constant: every assignment died
  // on unmount, never mind restart. The `cart_slots` table, its sync registration and the full
  // cartSlots IPC surface were all ALREADY BUILT — nothing was wired to them, and main.js:55 pointed at
  // a `CartWall.tsx` that does not exist. (docs/cart-persistence-trace-2026-07-31.md)
  //
  // Station-scoped by slot_number, so each station has its own wall — a park station's carts are not
  // the Christmas station's. Rows carry uuid/station_uuid and are registered in synced-tables, so a
  // wall built here follows the account to another machine like everything else.
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const rows = await (window as any).ether?.cartSlots?.list?.(stationId);
        if (stop) return;
        const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
        // No rows for this station → first run. Seed the defaults in memory only; a slot is written
        // when the operator actually puts something in it, so an untouched wall stays absent from the DB.
        if (!list.length) { setCarts(defaultCarts()); return; }
        const byslot = new Map(list.map(r => [Number(r.slot_number), r]));
        setCarts(defaultCarts().map(c => {
          const r = byslot.get(c.slot);
          return r ? { ...c, label: r.title || c.label, filePath: r.file_path || undefined, color: r.color || c.color } : c;
        }));
      } catch { /* IPC absent (dev/browser) — the in-memory default wall still works */ }
    })();
    return () => { stop = true; };
  }, [stationId]);

  /** Write one slot through the SAME upsert the Producer Desk already uses. Best-effort: a failed save
   *  must never swallow the operator's action — the tile still updates and the console says why. */
  const persistSlot = useCallback(async (c: CartSlot) => {
    try {
      await (window as any).ether?.cartSlots?.upsertBySlotNumber?.(stationId, c.slot, {
        title: c.label, file_path: c.filePath ?? null, color: c.color, hotkey: cartHotkey(c.slot),
      });
    } catch (e) { console.warn("[cart] slot", c.slot, "did not save:", e); }
  }, [stationId]);

  /** Mutate one slot in state AND persist it — the single path every editor goes through, so no
   *  future editor can change a cart without saving it. */
  const updateSlot = useCallback((key: string, patch: Partial<CartSlot>) => {
    setCarts(prev => {
      const next = prev.map(c => (c.key === key ? { ...c, ...patch } : c));
      const changed = next.find(c => c.key === key);
      if (changed) void persistSlot(changed);
      return next;
    });
  }, [persistSlot]);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const playingKeyRef = useRef<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [vu, setVu] = useState(0);

  // Drive the playing flash + countdown off the cart deck's REAL state (not a fixed
  // timeout), and the VU off the audio levels — so a fired cart flashes for its true
  // length, shows time remaining, and you can see audio moving.
  useEffect(() => {
    const ether = (window as any).ether;
    const lv = ether?.audio?.onLevels?.((l: { a?: number; b?: number; c?: number; cart?: number }) => {
      setVu(l.cart ?? 0);
    });
    const id = setInterval(() => {
      if (!playingKeyRef.current) return;
      const st = engine.getDeck(CART_CHANNEL)?.getState();
      if (st?.status === "playing") {
        setRemainingMs(Math.max(0, ((st.durationSec || 0) - (st.positionSec || 0)) * 1000));
      } else {
        playingKeyRef.current = null;
        setRemainingMs(0);
        setCarts(p => p.map(c => c.playing ? { ...c, playing: false } : c));
      }
    }, 200);
    return () => { clearInterval(id); if (lv) ether?.audio?.offLevels?.(lv); };
  }, [engine]);

  const fmtRemain = (ms: number) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

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
      await engine.loadToDeck(CART_CHANNEL, cart.filePath, cart.label, "");
      engine.getDeck(CART_CHANNEL)?.play();
      playingKeyRef.current = key;
      setCarts(p => p.map(c => ({ ...c, playing: c.key === key }))); // flash clears when the deck stops (effect)
    } catch {}
  };

  const handleDrop = (e: React.DragEvent, key: string) => {
    e.preventDefault();
    const label = e.dataTransfer.getData("text/plain");
    const filePath = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    updateSlot(key, { ...(label ? { label } : {}), filePath });   // persisted
    setDragOver(null);
  };

  const editLabel = (key: string) => {
    const cart = carts.find(c => c.key === key);
    const newLabel = prompt("Cart label:", cart?.label);
    if (newLabel) updateSlot(key, { label: newLabel });   // persisted
  };

  const assignCart = async (key: string) => {
    const f = await (window as any).ether.dialog.openFile({ multiple: false, title: "Select audio", filters: [{ name: "Audio", extensions: ["mp3","flac","ogg","wav","m4a","aac"] }] });
    if (!f) return;
    const fp = Array.isArray(f) ? f[0] : f;
    const label = (fp.split(/[\\/]/).pop() || fp).replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
    updateSlot(key, { label, filePath: fp });   // persisted
  };

  /** Empty a slot — clears the audio and restores the default label, persisted like any other edit. */
  const clearCart = (key: string) => {
    const c = carts.find(x => x.key === key);
    if (!c) return;
    updateSlot(key, { label: `Cart ${c.slot + 1}`, filePath: undefined });
  };

  // Exactly CART_STRIP_ROWS rows visible before the strip scrolls. The tiles are square and CART_ROW
  // across, so the height that shows 3 full rows is a function of the container's WIDTH, not of the
  // dock height — which is user-resizable and shared with the library/calendar/jingles panels, so it
  // must not be commandeered here. Measured, never hardcoded: a fixed px height would show 3 rows at
  // one window size and 2.4 at another.
  const STRIP_GAP = 6;
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [stripViewportH, setStripViewportH] = useState<number | null>(null);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth;
      if (!w) return;
      const tile = (w - STRIP_GAP * (CART_ROW - 1)) / CART_ROW;          // square edge
      setStripViewportH(Math.round(tile * CART_STRIP_ROWS + STRIP_GAP * (CART_STRIP_ROWS - 1)));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [variant]);

  // Strip layout: SQUARE carts, CART_ROW across, scrolling vertically. Lives docked below the decks
  // (decks-width), pushing them up — see App.tsx decksPanel.
  //
  // Was `carts.slice(0, CART_ROW)` in a single flex row, so the push-up could only ever reach the
  // first 8 of a 64-slot wall and the other 56 were unreachable from the main window. Now it renders
  // the SAME carts as the full wall in the same 8-across grid; the extra rows sit below and scroll.
  if (variant === "strip") {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "stretch", gap: 6, padding: "8px 10px", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <style>{`@keyframes ether-cart-flash { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
        <div ref={stripRef} style={{
          flex: 1, minWidth: 0, overflowY: "auto" as const,
          // 3 rows visible; rows 4+ are reachable by scrolling. All 64 render.
          height: stripViewportH ?? undefined, maxHeight: stripViewportH ?? undefined,
          display: "grid", gridTemplateColumns: `repeat(${CART_ROW}, 1fr)`, gap: STRIP_GAP,
          alignContent: "start",
        }}>
        {carts.map(cart => (
          <div
            key={cart.key}
            onClick={() => { if (cart.filePath) fireCart(cart.key); else assignCart(cart.key); }}
            onDoubleClick={() => editLabel(cart.key)}
            onDragOver={e => { e.preventDefault(); setDragOver(cart.key); }}
            onDragLeave={() => setDragOver(null)}
            onDrop={e => handleDrop(e, cart.key)}
            title={cart.filePath ? cart.label : "Empty — click to assign"}
            style={{
              // Grid owns the width now (CART_ROW columns); the tile only holds its square ratio.
              aspectRatio: "1", minWidth: 0,
              borderRadius: 4,
              background: cart.playing ? cart.color + "22" : dragOver === cart.key ? `${cart.color}14` : cart.filePath ? `${cart.color}0c` : "var(--bg-tertiary)",
              border: `1px solid ${cart.playing ? cart.color + "90" : dragOver === cart.key ? cart.color + "50" : cart.filePath ? cart.color + "30" : "var(--border-primary)"}`,
              boxShadow: cart.playing ? `0 0 10px ${cart.color}55` : "none",
              animation: cart.playing ? "ether-cart-flash 0.9s ease-in-out infinite" : undefined,
              cursor: "pointer", transition: "all 0.1s",
              position: "relative" as const, overflow: "hidden",
              display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center",
              textAlign: "center" as const, padding: 4, gap: 3,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: cart.playing || cart.filePath ? cart.color : "var(--text-tertiary)" }}>{cart.key}</span>
            <span style={{
              fontSize: 9, fontWeight: cart.filePath ? 700 : 400, lineHeight: 1.2,
              color: cart.playing ? cart.color : cart.filePath ? "var(--text-primary)" : "var(--text-tertiary)",
              overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const,
              fontStyle: cart.filePath ? "normal" : "italic", wordBreak: "break-word" as const, maxWidth: "100%",
            }}>{cart.filePath ? cart.label : "Empty"}</span>
            {cart.playing && remainingMs > 0 && (
              <span style={{ position: "absolute" as const, bottom: 3, fontSize: 9, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: cart.color }}>{fmtRemain(remainingMs)}</span>
            )}
          </div>
        ))}
        </div>
        {/* VU meter — side */}
        <div style={{ width: 14, alignSelf: "stretch", flexShrink: 0, display: "flex", flexDirection: "column" as const, padding: "2px 0" }}>
          <div style={{ flex: 1, background: "var(--bg-tertiary)", borderRadius: 2, overflow: "hidden", display: "flex", alignItems: "flex-end" }}>
            <div style={{ width: "100%", height: `${Math.min(100, Math.round(vu * 100))}%`, background: vu > 0.85 ? "#ef4444" : vu > 0.6 ? "#fbbf24" : "#4ade80", transition: "height 0.08s linear" }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" as const, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Header — hidden in compact to save space */}
      {!compact && (
        <div style={{ padding: "10px 14px 8px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {/* No "Cart Wall · Deck X" title: carts always fire on the dedicated CART channel and sum
              to master, so naming a deck here was wrong as well as noise. No "press key / drop audio"
              subtext either — the tiles are the affordance. The loaded counter stays; it is the one
              thing the strip tells you that a tile cannot. */}
          <div />
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
              onClick={() => { if (cart.filePath) { fireCart(cart.key); } else { assignCart(cart.key); } }}
              onDoubleClick={() => editLabel(cart.key)}
              onDragOver={e => { e.preventDefault(); setDragOver(cart.key); }}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => handleDrop(e, cart.key)}
              style={{
                padding: "5px 8px",
                borderRadius: 0,
                background: cart.playing ? cart.color : cart.filePath ? `${cart.color}15` : "var(--bg-tertiary)",
                border: `1px solid ${cart.playing ? cart.color : cart.filePath ? cart.color + "40" : "var(--border-primary)"}`,
                cursor: "pointer",
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
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <style>{`@keyframes ether-cart-flash { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
        {/* CART_ROW tiles across, filling left-to-right then top-to-bottom: 1-8 on row 1, 9-16 on
            row 2, and so on. Grid's default row-wise flow gives that ordering; the column count is
            CART_ROW (8) so the wall stays consistent with the strip and can widen in one place. */}
        <div style={{
          flex: 1, padding: 12, overflowY: "auto" as const,
          display: "grid", gridTemplateColumns: `repeat(${CART_ROW}, 1fr)`, gap: 8,
          alignContent: "start",
        }}>
        {carts.map(cart => (
          <div
            key={cart.key}
            onClick={() => { if (cart.filePath) { fireCart(cart.key); } else { assignCart(cart.key); } }}
            onDoubleClick={() => editLabel(cart.key)}
            onDragOver={e => { e.preventDefault(); setDragOver(cart.key); }}
            onDragLeave={() => setDragOver(null)}
            onDrop={e => handleDrop(e, cart.key)}
            style={{
              borderRadius: 0,
              background: cart.playing ? cart.color + "22" : dragOver === cart.key ? `${cart.color}14` : cart.filePath ? `${cart.color}0c` : "var(--bg-tertiary)",
              border: `1px solid ${cart.playing ? cart.color + "80" : dragOver === cart.key ? cart.color + "50" : cart.filePath ? cart.color + "28" : "var(--border-primary)"}`,
              cursor: "pointer",
              transition: "all 0.1s",
              boxShadow: cart.playing ? `0 0 10px ${cart.color}55` : "none",
              animation: cart.playing ? "ether-cart-flash 0.9s ease-in-out infinite" : undefined,
              position: "relative" as const,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column" as const,
              aspectRatio: "1",
            }}
          >
            {/* 4px color strip */}
            <div style={{ height: 4, background: cart.filePath ? cart.color : "var(--border-primary)", flexShrink: 0, opacity: cart.playing ? 1 : 0.7 }} />

            {/* Name row */}
            {/* Right padding was 22px to clear the key badge; with the badge gone the name gets the
                full tile width. */}
            <div style={{ flex: 1, display: "flex", alignItems: "center", padding: "2px 6px", minWidth: 0 }}>
              <span style={{
                fontSize: 12, fontWeight: cart.filePath ? 700 : 400, lineHeight: 1.3,
                color: cart.playing ? cart.color : cart.filePath ? "var(--text-primary)" : "var(--text-tertiary)",
                overflow: "hidden",
                display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const,
                fontStyle: cart.filePath ? "normal" : "italic",
                wordBreak: "break-word" as const,
              }}>
                {cart.filePath ? cart.label : "Empty"}
              </span>
            </div>

            {/* Countdown — bottom-left, while this cart is playing */}
            {cart.playing && remainingMs > 0 && (
              <div style={{ position: "absolute" as const, bottom: 3, left: 6, fontSize: 9, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: cart.color }}>
                {fmtRemain(remainingMs)}
              </div>
            )}

            {/* No key badge. The 1-8 / Q-W-E / c25 labels are gone from the tile — a tile is a
                square you click. Hotkeys still fire the first 24 slots; they are just not printed
                on the face. cart.key remains the internal per-slot identity (cartKeyFor). */}
          </div>
        ))}
        </div>

        {/* VU meter — right side, shows cart audio level */}
        <div style={{ width: 18, flexShrink: 0, padding: "12px 8px 12px 0", display: "flex", flexDirection: "column" as const }}>
          <div style={{ flex: 1, background: "var(--bg-tertiary)", borderRadius: 2, overflow: "hidden", display: "flex", alignItems: "flex-end" }}>
            <div style={{
              width: "100%",
              height: `${Math.min(100, Math.round(vu * 100))}%`,
              background: vu > 0.85 ? "#ef4444" : vu > 0.6 ? "#fbbf24" : "#4ade80",
              transition: "height 0.08s linear",
            }} />
          </div>
          <div style={{ fontSize: 7, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-tertiary)", textAlign: "center" as const, marginTop: 4 }}>VU</div>
        </div>
      </div>
      )}
    </div>
  );
}
