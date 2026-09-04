import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useAudioEngine } from "../audio/AudioEngineContext";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
// The on-screen Console is where an operator looks when something did not go where they expected.
import { consoleLog } from "./MasterOutput";

// ── Types ─────────────────────────────────────────────────────

// "jukebox" (2026-08-17) is a SOURCE you patch into a deck, like a mic — the public request jukebox's
// audio. It is only offerable on slots D/E/F: station automation enumerates ["A","B","C"] and nothing
// else (audiod/engine.js:521, :604, :648, :905, :1698 …), so a jukebox on D/E/F is a deck rotation
// structurally cannot touch. Offering it on A/B/C would put the public and the scheduler on the same
// deck. docs/jukebox-deck-source-design-2026-08-17.md
export type DeckType = "music" | "mic" | "guest" | "cart" | "desk" | "video" | "jukebox" | "source";

// ── SOURCE channels (slice 2, 2026-08-22) ──────────────────────────────────────────────────────
// A SOURCE channel is a console strip whose input you PICK, the way a Wheatstone bus selector does.
// `type: "source"` says the strip is a source channel; `kind` says what is patched into it.
//
// The real dividing line is NOT mic-vs-rest, it is FILE sources vs STREAMED sources
// (docs/aux-channel-ducker-announcements-design-2026-08-21.md §A.6):
//   · file    — the engine loads a path and plays it. Works today.
//   · stream  — samples arrive from a device or a network endpoint. Needs a PCM-in path the engine
//               does not have. Mic and network are ONE build, and that build is Phase 2.
// Phase 2 entries are shown DISABLED rather than hidden: a door that says "not yet" beats a door
// that is not there.
export type SourceKind = "jukebox" | "announcement" | "jingle" | "cart" | "mic" | "network";

export interface SourceKindMeta {
  kind: SourceKind;
  label: string;
  /** "file" works today; "stream" needs the Phase 2 capture path. */
  family: "file" | "stream";
  /** What the operator is told on the strip — honest about what does and does not play yet. */
  state: string;
}

export const SOURCE_KINDS: SourceKindMeta[] = [
  { kind: "jukebox",      label: "Jukebox",              family: "file",
    state: "Public request wall — patched and playing" },
  { kind: "announcement", label: "Announcement",         family: "file",
    state: "Patched. Announcement playout arrives in a later slice — nothing fires yet." },
  { kind: "jingle",       label: "Sweeper",              family: "file",
    // The `kind` VALUE stays "jingle": it is a persisted deck-config key, not a label. Changing a
    // stored key for cosmetics is how a config silently stops matching, and the daemon's channel
    // resolver accepts both 'jingle' and 'sweeper' so an existing install needs no re-dial.
    //
    // NO LONGER "(hand-fired)". Until 2026-09-03 the automated seam sweeper was hardcoded to the
    // literal "CART" slot and never read deck_configs, so this entry genuinely could not carry the
    // log's sweepers — and the state line said so. The fire path now resolves the dialled
    // channel(s) on every fire, so the qualifier and that sentence would both be false.
    state: "Sweepers air on this channel — the log's seam sweepers and hand-fired imaging alike." },
  // CARTS ARE NOT SWEEPERS, and this entry is what finally separates them (Jeff, 2026-09-01).
  //
  //   A SWEEPER is programmed to play DURING ROTATION — armed and fired automatically at a song
  //   seam by the daemon's _jingleTick, bridging the crossfade. It is part of the log.
  //   A CART is a SOUND-EFFECTS RACK — hand-fired, punch-through, never scheduled, never in
  //   rotation.
  //
  // Both used to drive the one native "CART" channel, so a cart fired while a sweeper was bridging
  // a seam clobbered it — the daemon _stop()s and _load()s that channel as part of its bridge
  // lifecycle, and neither side knew about the other. Patching carts onto an ordinary aux deck is
  // what ends that: the sweeper keeps the overlay bus it is built around, and carts move off it.
  { kind: "cart",         label: "Cart / SFX rack",      family: "file",
    state: "Hand-fired sound effects, on this channel instead of the sweeper's overlay bus." },
  // Mic is a STREAM source but is NOT Phase 2: MicChannel has done getUserMedia + Web Audio per slot
  // since 52d33bb (own device, meter, cue). SourceChannelStrip enables it explicitly; only Network
  // below is still gated on the engine capture path.
  { kind: "mic",          label: "Mic (device…)",        family: "stream",
    state: "Live microphone on this channel — pick the device on the strip." },
  { kind: "network",      label: "Network (IP / Zephyr / AoIP)", family: "stream",
    state: "Needs the engine capture path — Phase 2." },
];

// ONE ALPHABET. Storage and the Rust engine still say "S1".."S5" for the slots added by slice 1
// (native/src/audio.rs:632 "S1" => Some(7), SOURCE_IDS, and the deck_configs PK (station_id, slot)),
// but an operator should never meet a second naming series: decks are A, B, C, D, E, F, G, H, I...
// This maps the stored id to the letter shown EVERYWHERE — board strip and aux monitor row — so a
// deck is called the same thing in both places. Renaming the stored ids is a separate change: it
// needs a Rust constant change plus a deck_configs migration, and is not worth risking inside a UI
// pass. S1 -> G because F is the last of the original letters.
export const deckLetter = (slot: string): string => {
  const m = /^S(\d+)$/.exec(String(slot || ""));
  if (!m) return String(slot || "");
  const n = Number(m[1]);
  return n >= 1 ? String.fromCharCode("F".charCodeAt(0) + n) : String(slot);
};

/** Is this channel dialled to sweepers?
 *
 *  Both stored values: 'jingle' is the key the Sweeper entry has always persisted and predates
 *  'sweeper', so an existing install matches with no re-dial and no migration. Renaming a stored key
 *  for cosmetics is how a config silently stops matching.
 *
 *  A sweeper channel is the ONE source kind that joins the programme bus rather than the aux bus —
 *  it sums with the music, is ducked with it, and is heard on the station monitor, exactly as slot 6
 *  always was. Carts are NOT sweepers and never take this path: a cart is a hand-fired rack on an
 *  aux channel. */
export const isSweeperKind = (k?: string | null) => k === "sweeper" || k === "jingle";

export const sourceKindMeta = (k?: string | null) =>
  SOURCE_KINDS.find(s => s.kind === k) || null;

/** Slots a SOURCE channel may occupy: the existing aux decks first, then the new engine slots. */
export const SOURCE_SLOTS = ["D", "E", "F", "S1", "S2", "S3", "S4", "S5"] as const;

/** Slots the jukebox source may be assigned to. Not a preference — see the note above. */
export const JUKEBOX_SLOTS = ["D", "E", "F"] as const;
export const canHostJukebox = (slot: string) => (JUKEBOX_SLOTS as readonly string[]).includes(String(slot).toUpperCase());

export interface DeckConfig {
  slot: string;       // "A" | "B" | "C" | "D" | "E" | "F" | "S1".."S5"
  type: DeckType;
  label: string;
  color: string;
  enabled: boolean;
  purpose?: string;   // If set, deck is always visible regardless of experience mode
  /** SOURCE channels only — what is patched in. Empty for every other deck type. */
  kind?: SourceKind | "";
  /** Phase 2 — device id for Mic, endpoint for a network source. Stored from day one, unused now. */
  address?: string | null;
  /** SOURCE channels only — does audio on this channel duck the programme? Default off.
   *  A preference, not the rule: only SOURCE slots can duck at all, enforced in Rust by the slot's
   *  kind, so arming a rotation deck stores a setting that can never fire. */
  duck?: boolean;
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
  // A SOURCE channel is added from the board with +, not from this panel — it appears here only so
  // the type map is total. Its input is chosen on the strip itself.
  source: { label: "Source",       icon: "🎚",  color: "#8868D8", desc: "Console channel with a source dropdown — jukebox, announcement, hand-fired jingle" },
  mic:    { label: "Mic",          icon: "🎙",  color: "#ef4444", desc: "Live microphone input channel" },
  guest:  { label: "Guest",        icon: "👤",  color: "var(--accent-blue)", desc: "Remote guest audio (WebRTC)" },
  cart:   { label: "Cart",         icon: "⚡",  color: "#fbbf24", desc: "Hot-key sound effects & stingers" },
  desk:   { label: "Desk",         icon: "🎛️",  color: "#a78bfa", desc: "Producer desk — carts, jingles & production tools" },
  video:  { label: "Video Studio", icon: "🎥",  color: "var(--accent-blue)", desc: "Live video camera, streaming & recording — spans 3 decks" },
  jukebox:{ label: "Jukebox",      icon: "🎶",  color: "#8868D8", desc: "Public request jukebox — mix it like any source; automation never touches this deck" },
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
    queryScoped<{ slot: string; type: string; label: string; color: string; enabled: number; purpose: string; kind: string; address: string | null; duck: number }>(
      "SELECT slot, type, label, color, enabled, COALESCE(purpose,'') as purpose, COALESCE(kind,'') as kind, address, COALESCE(duck,0) as duck FROM deck_configs ORDER BY slot",
      [], stationId
    ).then(rows => {
      const sorted = [...rows].sort(compareSlots);
      setConfigs(sorted.map(r => ({ ...r, type: r.type as DeckType, enabled: r.enabled === 1, kind: (r.kind || "") as any, duck: r.duck === 1 })));
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
        // SLICE 2 — the patch point travels with every save, so a source channel keeps what it is
        // patched to across a reload. address is written even while unused so Phase 2 needs no
        // migration.
        kind: c.kind || "", address: c.address ?? null, duck: c.duck ? 1 : 0,
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
      label: type === "mic" ? "Mic" : type === "jukebox" ? "Jukebox" : type === "guest" ? `Guest ${p.filter(x => x.type === "guest" && x.slot !== slot).length + 1}` : type === "desk" ? "Desk" : `Deck ${slot}`,
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
                    {/* Jukebox is offered on D/E/F only — automation owns A/B/C and must never share a
                        deck with the public request jukebox. See canHostJukebox and the DeckType note. */}
                    {(Object.keys(TYPE_META) as DeckType[])
                      .filter(type => type !== "jukebox" || canHostJukebox(c.slot))
                      .map(type => (
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
                              label: type === "mic" ? "Mic" : type === "jukebox" ? "Jukebox" : type === "guest" ? `Guest ${p.filter(g => g.type === "guest" && g.slot !== c.slot).length + 1}` : type === "cart" ? `Cart ${p.filter(g => g.type === "cart" && g.slot !== c.slot).length + 1}` : type === "desk" ? "Desk" : `Deck ${x.slot}`,
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

// ── SQUARE TILES — why this is measured and not `aspect-ratio: 1` ──────────────────────────────────
// A grid item defaults to `align-items: stretch`, so its height is dictated by its ROW, and
// `aspect-ratio` only sizes a box when the cross axis is `auto`. Both cart grids live in a tall
// `flex: 1` container, so the rows stretched and every tile rendered as a tall RECTANGLE — aspect-ratio
// never got a say. (Reported with a screenshot, 2026-08-04.)
//
// The fix is to stop asking: measure the grid's own content width, divide by the column count, and set
// `gridAutoRows` to that pixel value. Row height then EQUALS column width, so every cell is a true
// square regardless of how tall its container is, and the grid scrolls instead of stretching.
// Measured, never hardcoded — the same width maths has to survive any window size or dock height.
function useSquareGrid(cols: number, gap: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [tile, setTile] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      // clientWidth of the GRID itself: it carries no padding (the padding lives on the scroll
      // parent), and it already excludes any scrollbar the parent took.
      const w = el.clientWidth;
      if (!w) return;
      setTile(Math.max(36, Math.floor((w - gap * (cols - 1)) / cols)));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cols, gap]);
  return { ref, tile };
}

/** Square tiles with a column count DERIVED from the available width.
 *
 *  The full wall hardcoded 8 columns, which is right for a pop-out or a full-width panel and wrong for
 *  a deck slot: `App.tsx:4026` renders this same wall inside a `flex:1, minWidth:120` column, so 8
 *  columns left 8-20px tiles — 64 unusable buttons. Fixing that by slicing the list would create a
 *  second data path; fixing it by scrolling would just stack more cramped tiles.
 *
 *  So: fit as many columns as the width allows at a MINIMUM USABLE TILE SIZE, capped at maxCols. A
 *  wide surface still lands on maxCols (pop-out and docked panel are unchanged); a narrow deck slot
 *  lands on 2-4 real squares. One layout, no slicing, all 64 still reachable by scrolling. */
function useSquareGridAuto(gap: number, minTile: number, maxCols: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ tile: number; cols: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth;
      if (!w) return;
      const cols = Math.max(1, Math.min(maxCols, Math.floor((w + gap) / (minTile + gap))));
      setBox({ cols, tile: Math.max(minTile, Math.floor((w - gap * (cols - 1)) / cols)) });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [gap, minTile, maxCols]);
  return { ref, tile: box?.tile ?? null, cols: box?.cols ?? maxCols };
}

const CART_WALL_GAP = 8;
const CART_STRIP_GAP = 6;
/** Smallest tile that is still a usable click target with a readable label. */
const CART_MIN_TILE = 64;
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
  // NO deckSlot. It used to be here and it was a trap: callers passed one (the popout passed "C", a
  // MUSIC deck), the wall ignored it for audio and fired into the hardcoded "CART" channel, and the
  // prop's existence implied a routing that did not happen. The wall resolves its own channel from
  // the patched deck config now, so there is nothing for a caller to get wrong.
  compact?: boolean;
  variant?: "grid" | "strip"; // "strip" = single row of 8 square carts + side VU
}

export function BoutiqueCartWall({ compact, variant }: CartProps) {
  const engine = useAudioEngine();
  const { stationId } = useActiveStation();
  const { configs: deckCfgs } = useDeckConfig();

  // ── WHERE A CART ACTUALLY SOUNDS ───────────────────────────────────────────────────────────────
  //
  // The wall took a `deckSlot` prop and then ignored it for audio, firing into the hardcoded "CART"
  // channel instead — the one the seam sweeper also drives. So a deck could be configured as a cart
  // channel on any slot and the audio still came out somewhere else, and a hand-fired cart could cut
  // off a sweeper mid-seam. The config was honoured everywhere except where the sound went.
  //
  // Now it resolves the slot the operator patched: an enabled SOURCE channel with kind "cart", or a
  // deck typed "cart". First match by slot order, so the choice is stable rather than whichever row
  // the query happened to return.
  //
  // FALLBACK TO "CART" when nothing is patched, deliberately (Jeff's ruling). The bottom-bar CARTS
  // panel and the popout open a wall whether or not anyone has configured a cart channel, and a rack
  // that silently does nothing is worse than one on the legacy bus. This keeps the change
  // non-breaking for every install that never patches one.
  const CART_CHANNEL = useMemo(() => {
    const patched = deckCfgs.find(c => c.enabled && c.type === "source" && c.kind === "cart")
                 || deckCfgs.find(c => c.enabled && c.type === "cart");
    return patched ? patched.slot : "CART";
  }, [deckCfgs]);
  // ── RESOLVED AT EVERY FIRE, NEVER CACHED ───────────────────────────────────────────────────────
  //
  // CART_CHANNEL above is a useMemo over the deck configs this component read WHEN IT MOUNTED, and
  // useDeckConfig reads deck_configs once per station and never re-reads. So moving the input
  // selector did not reach the wall: carts kept firing at whichever deck was dialled to Cart at
  // mount. It works, then the operator re-dials and it goes silent — with nothing to say why.
  //
  // The deck is read FRESH on every click. It is a button press, not an audio-thread path: one small
  // station-scoped query costs nothing next to being wrong about where a cart sounds. EVERY channel
  // dialled to Cart, not the first — how many the operator uses is their choice, not this function's.
  const resolveFireChannels = useCallback(async (): Promise<string[]> => {
    try {
      const r: any = await (window as any).ether?.deckConfigs?.list?.(stationId);
      const rows: any[] = (r && r.rows) || (Array.isArray(r) ? r : []);
      const dialed = rows
        .filter(c => c && c.enabled && String(c.type) === "source" && String(c.kind || "") === "cart")
        .map(c => String(c.slot));
      if (dialed.length) return dialed;
      // Dialled nowhere. Falling back keeps the rack audible, but the operator must be told that the
      // audio did NOT go where the board says — silence-by-configuration they cannot see is the
      // defect this whole path keeps producing.
      consoleLog("error", `[CART] no channel is dialled to Cart / SFX rack — firing on ${CART_CHANNEL}. Set a deck's input to Cart / SFX rack.`);
    } catch (e) {
      consoleLog("error", `[CART] could not read the deck config (${(e as any)?.message || e}) — firing on ${CART_CHANNEL}`);
    }
    return [CART_CHANNEL];
  }, [stationId, CART_CHANNEL]);

  // Where the cart currently playing actually went. Stop addresses THAT, not whatever the selector
  // says a moment later — otherwise moving a selector mid-cart strands it with no tile to stop it.
  const playingChannelsRef = useRef<string[]>([]);

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

  // ── CART LEVEL, on the cart panel itself ────────────────────────────────────────────────────────
  // Carts fire on the dedicated CART channel (BusState slot 6). Its only fader used to live on the
  // mixer strip labelled "SWEEPERS" — so from any cart surface there was no way to see or set the level
  // of the thing you were firing, and a cart could be inaudible with nothing on the cart panel to say
  // so. The VU sat next to it reading 0 (peaks are POST-fader, audio.rs:1051-1056) with no control to
  // explain why. This is that control, beside the meter, in every cart surface.
  // Seeded from the deck's REAL volume, not assumed — the renderer must not invent a value the engine
  // does not hold (the jingleVol default-to-1 desync is exactly that mistake).
  const [cartVol, setCartVol] = useState(1);
  useEffect(() => {
    const st = (engine.getDeck(CART_CHANNEL) as any)?.getState?.();
    if (typeof st?.volume === "number") setCartVol(st.volume);
  }, [engine]);
  const applyCartVol = (v: number) => {
    setCartVol(v);
    try { (engine.getDeck(CART_CHANNEL) as any)?.setVolume?.(v); } catch { /* engine not ready */ }
  };

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
      // THE DECK IT WAS FIRED ON. Watching the mount-time memo meant polling a deck the cart was not
      // on: it read idle, cleared playingKeyRef, and the next press fired again instead of stopping.
      // The cart is still playing while ANY channel it fired on is; the countdown follows the longest.
      const chans = playingChannelsRef.current.length ? playingChannelsRef.current : [CART_CHANNEL];
      const live = chans
        .map(ch => engine.getDeck(ch)?.getState())
        .filter(st => st && st.status === "playing") as any[];
      if (live.length) {
        setRemainingMs(Math.max(0, ...live.map(st => ((st.durationSec || 0) - (st.positionSec || 0)) * 1000)));
      } else {
        playingKeyRef.current = null;
        playingChannelsRef.current = [];
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

  // FIRE / STOP TOGGLE. Click a loaded cart to fire it; click it again while it is playing and it
  // stops immediately. A cart could previously be started and not stopped, which on a live board is
  // the wrong half of a control: the operator who fires a 30-second bed by mistake had no way to end
  // it except waiting for it.
  //
  // Stop goes through the engine's ORDINARY stop path for the cart channel — engine.getDeck(...).stop()
  // → audio_stop — so there is no fade, no crossfade, and nothing else on the board is touched. The
  // next fire calls loadToDeck again, so it always starts from the top; stopping cannot leave the
  // cart parked halfway through.
  //
  // EVERY LOCAL TRIGGER SHARES THIS. The tile click (all three cart layouts) and the keyboard letter
  // both call fireCart, so a cart behaves identically however it is triggered — the toggle lives in
  // the one function rather than being re-implemented per surface.
  const fireCart = async (key: string) => {
    const cart = carts.find(c => c.key === key);
    if (!cart?.filePath) return;
    // Already playing THIS cart → stop it. Read the deck rather than trusting the flag: the poll
    // effect clears playing state on its own beat, so the deck is the authority on what is audible.
    if (playingKeyRef.current === key) {
      // PAUSE, NOT STOP. The cart button plays a file and silences a file — it must never touch the
      // channel. `stop()` is audio_stop, whose Rust arm empties the slot outright (`source = None`,
      // `path = ""`, `active = false`, `frames_played = 0`), so pressing a cart a second time was
      // tearing down the operator's deck. Pause only sets `paused = true`: the mixer skips the slot
      // so the file goes quiet immediately, and the channel — its patch, its fader, its ON — is left
      // exactly as the operator set it. The next fire reloads from the top anyway, so nothing is
      // resumed mid-file.
      for (const ch of playingChannelsRef.current) {
        try { engine.getDeck(ch)?.pause(); } catch (e) { console.error(`[cart] pause failed on ${ch}:`, e); }
      }
      playingKeyRef.current = null;
      playingChannelsRef.current = [];
      setRemainingMs(0);
      setCarts(p => p.map(c => (c.playing ? { ...c, playing: false } : c)));
      return;
    }
    // The operator pressed it, so it fires. A failure on one channel is REPORTED and the rest still
    // fire — this whole block used to sit in `catch {}`, which produced the load line in the console
    // and then absolute silence: no error, no refusal, no clue.
    const chans = await resolveFireChannels();
    consoleLog("audio", `[CART] "${cart.label}" → ${chans.join("+")}`);
    for (const ch of chans) {
      try {
        await engine.loadToDeck(ch, cart.filePath, cart.label, "");
        await engine.getDeck(ch)?.play();
      } catch (e) {
        console.error(`[cart] "${cart.label}" on ${ch}:`, e);
      }
    }
    playingChannelsRef.current = chans;
    playingKeyRef.current = key;
    setCarts(p => p.map(c => ({ ...c, playing: c.key === key }))); // flash clears when the deck stops (effect)
  };

  // ── RIGHT-CLICK → DELETE ────────────────────────────────────────────────────────────────────
  // Clearing a slot had no route at all: a cart could be assigned and relabelled but never emptied.
  // No confirmation — re-adding a file is a click, and a confirm on a cheap reversible action is
  // just another thing to dismiss. It empties the SLOT only; the file on disk is untouched.
  const [cartMenu, setCartMenu] = useState<{ key: string; x: number; y: number } | null>(null);

  const deleteCart = (key: string) => {
    // If the slot being cleared is the one playing, stop it first — otherwise the cart keeps
    // sounding with no tile left to stop it from.
    if (playingKeyRef.current === key) {
      // Same rule when the slot being cleared is the one sounding: silence the file, leave the deck.
      for (const ch of playingChannelsRef.current) {
        try { engine.getDeck(ch)?.pause(); } catch (e) { console.error(`[cart] pause failed on ${ch}:`, e); }
      }
      playingKeyRef.current = null;
      playingChannelsRef.current = [];
      setRemainingMs(0);
    }
    updateSlot(key, { filePath: "", label: "", playing: false } as any);   // persisted
    setCartMenu(null);
  };

  // Dismiss on Escape or any click outside the popup.
  useEffect(() => {
    if (!cartMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCartMenu(null); };
    const onDown = () => setCartMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [cartMenu]);

  const handleDrop = (e: React.DragEvent, key: string) => {
    e.preventDefault();
    const label = e.dataTransfer.getData("text/plain");
    const filePath = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    updateSlot(key, { ...(label ? { label } : {}), filePath });   // persisted
    setDragOver(null);
  };

  // ── RENAMING A CART — inline on the tile ───────────────────────────────────────────────────────
  //
  // This was `prompt("Cart label:")`, which ELECTRON DOES NOT IMPLEMENT: Chromium's prompt is
  // removed, it returns nothing, the `if` never fired and the function did nothing at all. No error,
  // no dialog — the click simply looked ignored. So renaming a cart had never worked, on any layout,
  // by any gesture: the right-click item and the double-click both landed on the same dead call.
  // (The same dead call is in nine other places — see docs/backlog.md.)
  //
  // The label edits in place instead: Enter commits, Escape cancels, blur commits. It writes through
  // the same updateSlot every other cart editor uses, so it persists by the one path, and it is
  // rendered from ONE helper so all three tile layouts get it rather than three copies drifting.
  //
  // The label ONLY. Nothing here touches filePath — renaming a cart never renames or moves audio.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const editLabel = (key: string) => {
    const cart = carts.find(c => c.key === key);
    setEditDraft(cart?.label || "");
    setEditingKey(key);
  };
  const commitEdit = useCallback(() => {
    setEditingKey(prev => {
      if (prev) {
        const v = editDraft.trim();
        // An empty box is a cancel, not a way to erase the name — a nameless tile is unreadable.
        if (v) updateSlot(prev, { label: v });   // persisted
      }
      return null;
    });
  }, [editDraft, updateSlot]);

  /** The tile's label, or its editor. One implementation, used by every layout. */
  const cartLabelContent = (cart: CartSlot) => editingKey !== cart.key
    ? (cart.filePath ? cart.label : "Empty")
    : (
      <input
        autoFocus
        value={editDraft}
        onChange={e => setEditDraft(e.target.value)}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
          else if (e.key === "Escape") { e.preventDefault(); setEditingKey(null); }
        }}
        onBlur={commitEdit}
        // The tile itself fires the cart on click and opens the menu on right-click; while the
        // editor is open those gestures belong to the text box.
        onClick={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
        onContextMenu={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        style={{
          font: "inherit", color: "var(--text-primary)", width: "100%", minWidth: 0,
          background: "var(--bg-primary)", border: "1px solid var(--accent-teal)",
          borderRadius: 2, padding: "1px 3px", outline: "none", textAlign: "inherit" as const,
        }}
      />
    );

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

  // Square tiles for both grids — see useSquareGrid above for why aspect-ratio cannot do this job.
  // Wall: columns derived from width, capped at CART_ROW. Wide surfaces (pop-out, docked cart panel)
  // still get 8; a narrow deck slot gets fewer, bigger squares instead of 64 cramped ones.
  const wallGrid  = useSquareGridAuto(CART_WALL_GAP, CART_MIN_TILE, CART_ROW);
  const stripGrid = useSquareGrid(CART_ROW, CART_STRIP_GAP);
  // The push-up shows exactly CART_STRIP_ROWS rows before scrolling. That height is derived from the
  // measured square edge, so it stays 3 full rows at any window size — and it leaves the dock height
  // (user-resizable, shared with the library/calendar/jingles panels) alone.
  const stripViewportH = stripGrid.tile
    ? stripGrid.tile * CART_STRIP_ROWS + CART_STRIP_GAP * (CART_STRIP_ROWS - 1)
    : null;

  // Strip layout: SQUARE carts, CART_ROW across, scrolling vertically. Lives docked below the decks
  // (decks-width), pushing them up — see App.tsx decksPanel.
  //
  // Was `carts.slice(0, CART_ROW)` in a single flex row, so the push-up could only ever reach the
  // first 8 of a 64-slot wall and the other 56 were unreachable from the main window. Now it renders
  // the SAME carts as the full wall in the same 8-across grid; the extra rows sit below and scroll.
  // ── ONE MENU, RENDERED BY EVERY LAYOUT ─────────────────────────────────────────────────────────
  //
  // This lived inside the full-wall return only, while the tiles in ALL THREE layouts set cartMenu.
  // So right-clicking a tile in the CARTS push-up (variant="strip") fired the handler, set the
  // state, and rendered nothing — the menu existed in one layout and not another, which is the same
  // "two lists that disagree" shape as the board enumeration. Built once here and rendered by each
  // return, so a layout cannot have tiles without their menu.
  const cartMenuNode = !cartMenu ? null : (
      <div
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        style={{
          position: "fixed", left: cartMenu.x, top: cartMenu.y, zIndex: 4000,
          background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
          boxShadow: "0 6px 20px rgba(0,0,0,0.5)", padding: 4, minWidth: 120,
        }}
      >
        <div style={{ fontSize: 9, color: "var(--text-tertiary)", padding: "2px 6px 4px", letterSpacing: "0.06em",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>
          {carts.find(c => c.key === cartMenu.key)?.label || cartMenu.key}
        </div>
        {/* RENAME — the same editor double-click opens. It was reachable ONLY by double-click,
            which is not a discoverable gesture on a button that also fires audio: an operator who
            tried it heard the cart play. The right-click menu is where a tile's edit actions
            belong, so both live here and double-click keeps working for anyone used to it. */}
        <button
          onClick={() => { const k = cartMenu.key; setCartMenu(null); editLabel(k); }}
          style={{
            width: "100%", textAlign: "left", padding: "5px 8px", cursor: "pointer",
            background: "transparent", border: "1px solid transparent", color: "var(--text-primary)",
            fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-tertiary)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
        >RENAME…</button>
        {/* REPLACE — delete-then-click works, but replacing the audio is the thing an operator
            actually wants and it should not take two gestures and an empty tile in between. */}
        <button
          onClick={() => { const k = cartMenu.key; setCartMenu(null); void assignCart(k); }}
          style={{
            width: "100%", textAlign: "left", padding: "5px 8px", cursor: "pointer",
            background: "transparent", border: "1px solid transparent", color: "var(--text-primary)",
            fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-tertiary)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
        >REPLACE FILE…</button>
        <div style={{ height: 1, background: "var(--border-primary)", margin: "3px 0" }} />
        <button
          onClick={() => deleteCart(cartMenu.key)}
          style={{
            width: "100%", textAlign: "left", padding: "5px 8px", cursor: "pointer",
            background: "transparent", border: "1px solid transparent", color: "#ef4444",
            fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "#ef444414"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
        >DELETE</button>
      </div>
  );

  if (variant === "strip") {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "stretch", gap: 6, padding: "8px 10px", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <style>{`@keyframes ether-cart-flash { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
        {/* Scroll parent holds the height; the GRID inside is what gets measured. */}
        <div style={{
          flex: 1, minWidth: 0, overflowY: "auto" as const, alignSelf: "flex-start",
          height: stripViewportH ?? undefined, maxHeight: stripViewportH ?? undefined,
        }}>
        <div ref={stripGrid.ref} style={{
          display: "grid", gridTemplateColumns: `repeat(${CART_ROW}, 1fr)`, gap: CART_STRIP_GAP,
          gridAutoRows: stripGrid.tile ? `${stripGrid.tile}px` : undefined,   // row height = column width
          alignContent: "start",
        }}>
        {carts.map(cart => (
          <div
            key={cart.key}
            onClick={() => { if (cart.filePath) fireCart(cart.key); else assignCart(cart.key); }}
            onContextMenu={e => { if (!cart.filePath) return; e.preventDefault(); e.stopPropagation(); setCartMenu({ key: cart.key, x: e.clientX, y: e.clientY }); }}
            onDoubleClick={() => editLabel(cart.key)}
            onDragOver={e => { e.preventDefault(); setDragOver(cart.key); }}
            onDragLeave={() => setDragOver(null)}
            onDrop={e => handleDrop(e, cart.key)}
            title={cart.filePath ? (cart.playing ? cart.label + " — click to STOP" : cart.label + " — click to fire, right-click to delete") : "Empty — click to assign"}
            style={{
              // No aspectRatio: the grid's row height IS the column width (gridAutoRows), so the tile
              // is square by construction and stretch fills a square cell.
              minWidth: 0, minHeight: 0,
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
            {/* STOP GLYPH — a playing tile says how to END it, not just that it is running.
                Absolute so it never reflows the label; pointerEvents none so the whole tile stays
                one click target. */}
            {cart.playing && (
              <span aria-hidden style={{
                position: "absolute", top: 3, right: 4, zIndex: 2, pointerEvents: "none",
                fontSize: 9, lineHeight: 1, color: cart.color, opacity: 0.95,
                textShadow: "0 0 4px rgba(0,0,0,0.6)",
              }}>■</span>
            )}
            {/* NO HOTKEY GLYPH. The number was the biggest thing on a tile and it is not what the
                operator is looking for — the NAME is. The key still fires the cart from the
                keyboard; it just stops competing with the label for the space. */}
            <span style={{
              fontSize: 13, fontWeight: cart.filePath ? 800 : 400, lineHeight: 1.2,
              color: cart.playing ? cart.color : cart.filePath ? "var(--text-primary)" : "var(--text-tertiary)",
              overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const,
              fontStyle: cart.filePath ? "normal" : "italic", wordBreak: "break-word" as const, maxWidth: "100%",
            }}>{cartLabelContent(cart)}</span>
            {cart.playing && remainingMs > 0 && (
              <span style={{ position: "absolute" as const, bottom: 3, fontSize: 9, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: cart.color }}>{fmtRemain(remainingMs)}</span>
            )}
          </div>
        ))}
        </div>
        </div>
        {/* CART LEVEL + VU — the fader for the channel these tiles fire on, beside its meter. */}
        <div style={{ display: "flex", gap: 4, alignSelf: "stretch", flexShrink: 0, padding: "2px 0" }}>
          <input type="range" min={0} max={1} step={0.01} value={cartVol}
            onChange={e => applyCartVol(parseFloat(e.target.value))}
            title={`Cart level — ${Math.round(cartVol * 100)}%`}
            style={{ writingMode: "vertical-lr" as any, direction: "rtl" as any, width: 16, padding: 0, margin: 0, accentColor: "#14e0c8", cursor: "pointer" }} />
          <div style={{ width: 14, display: "flex", flexDirection: "column" as const }}>
            <div style={{ flex: 1, background: "var(--bg-tertiary)", borderRadius: 2, overflow: "hidden", display: "flex", alignItems: "flex-end" }}>
              <div style={{ width: "100%", height: `${Math.min(100, Math.round(vu * 100))}%`, background: vu > 0.85 ? "#ef4444" : vu > 0.6 ? "#fbbf24" : "#4ade80", transition: "height 0.08s linear" }} />
            </div>
          </div>
        </div>
        {cartMenuNode}
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
              onContextMenu={e => { if (!cart.filePath) return; e.preventDefault(); e.stopPropagation(); setCartMenu({ key: cart.key, x: e.clientX, y: e.clientY }); }}
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
              {/* STOP GLYPH — inline here: this tile is a flex row, not a positioned box. */}
              {cart.playing && <span aria-hidden style={{ fontSize: 8, lineHeight: 1, color: "#000", flexShrink: 0 }}>■</span>}
              <span style={{ fontSize: 12, fontWeight: cart.filePath ? 800 : 400, color: cart.playing ? "#000" : cart.filePath ? "var(--text-primary)" : "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1, fontStyle: cart.filePath ? "normal" : "italic" }}>
                {cartLabelContent(cart)}
              </span>
            </div>
          ))}
        </div>
      ) : (
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <style>{`@keyframes ether-cart-flash { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
        {/* CART_ROW tiles across, filling left-to-right then top-to-bottom: 1-8 on row 1, 9-16 on
            row 2, and so on. Grid's default row-wise flow gives that ordering; the column count is
            CART_ROW (8) so the wall stays consistent with the strip and can widen in one place.
            Scroll parent carries the padding and the overflow; the GRID inside is what gets measured
            for square rows. */}
        <div style={{ flex: 1, minHeight: 0, padding: 12, overflowY: "auto" as const }}>
        <div ref={wallGrid.ref} style={{
          display: "grid", gridTemplateColumns: `repeat(${wallGrid.cols}, 1fr)`, gap: CART_WALL_GAP,
          gridAutoRows: wallGrid.tile ? `${wallGrid.tile}px` : undefined,   // row height = column width
          alignContent: "start",
        }}>
        {carts.map(cart => (
          <div
            key={cart.key}
            onClick={() => { if (cart.filePath) { fireCart(cart.key); } else { assignCart(cart.key); } }}
            onContextMenu={e => { if (!cart.filePath) return; e.preventDefault(); e.stopPropagation(); setCartMenu({ key: cart.key, x: e.clientX, y: e.clientY }); }}
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
              // No aspectRatio — gridAutoRows makes the row exactly as tall as the column is wide,
              // so the stretched tile IS a square. aspect-ratio lost to align-items:stretch here.
              minWidth: 0, minHeight: 0,
            }}
          >
            {/* 4px color strip */}
            {/* STOP GLYPH — see the square-tile layout above. */}
            {cart.playing && (
              <span aria-hidden style={{
                position: "absolute", top: 4, right: 5, zIndex: 2, pointerEvents: "none",
                fontSize: 10, lineHeight: 1, color: cart.color, opacity: 0.95,
                textShadow: "0 0 4px rgba(0,0,0,0.6)",
              }}>■</span>
            )}
            <div style={{ height: 4, background: cart.filePath ? cart.color : "var(--border-primary)", flexShrink: 0, opacity: cart.playing ? 1 : 0.7 }} />

            {/* Name row */}
            {/* Right padding was 22px to clear the key badge; with the badge gone the name gets the
                full tile width. */}
            <div style={{ flex: 1, display: "flex", alignItems: "center", padding: "2px 6px", minWidth: 0 }}>
              <span style={{
                fontSize: 16, fontWeight: cart.filePath ? 800 : 400, lineHeight: 1.25,
                color: cart.playing ? cart.color : cart.filePath ? "var(--text-primary)" : "var(--text-tertiary)",
                overflow: "hidden",
                display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const,
                fontStyle: cart.filePath ? "normal" : "italic",
                wordBreak: "break-word" as const,
              }}>
                {cartLabelContent(cart)}
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
        </div>

        {/* CART LEVEL + VU — right side. The fader sets the CART channel (slot 6) these tiles fire on;
            the meter reads the same channel post-fader, so they move together. */}
        <div style={{ flexShrink: 0, padding: "12px 8px 12px 4px", display: "flex", gap: 6 }}>
          <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "center" }}>
            <input type="range" min={0} max={1} step={0.01} value={cartVol}
              onChange={e => applyCartVol(parseFloat(e.target.value))}
              title={`Cart level — ${Math.round(cartVol * 100)}%`}
              style={{ flex: 1, writingMode: "vertical-lr" as any, direction: "rtl" as any, width: 18, padding: 0, margin: 0, accentColor: "#14e0c8", cursor: "pointer" }} />
            <div style={{ fontSize: 7, fontWeight: 800, letterSpacing: "0.08em", color: "var(--text-tertiary)", textAlign: "center" as const, marginTop: 4 }}>
              {Math.round(cartVol * 100)}
            </div>
          </div>
          <div style={{ width: 18, display: "flex", flexDirection: "column" as const }}>
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
      </div>
      )}

      {/* DELETE popup — anchored to the cart that was right-clicked. Fixed-position so it is not
          clipped by the wall's own scroll container. mousedown on the window dismisses it, so the
          popup stops propagation on its own mousedown to survive its own click. */}
      {cartMenuNode}
    </div>
  );
}
