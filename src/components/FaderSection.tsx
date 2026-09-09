// FaderSection.tsx — THE BOARD. One implementation, rendered by the dashboard and by its own window.
//
// WHY THIS FILE EXISTS. There were two deck implementations. The dashboard rendered this section
// inline inside LivePanel — A/B/C on ConsoleStrip, D/E/F on SourceChannelStrip with their assignment
// dropdowns, DUCK, meters, ON and PFL, the + that adds a channel, then MasterOutput. The Decks
// pop-out rendered StandaloneDecksPanel, a months-old widget that predates source channels entirely
// and drew "not available in monitor mode" over D/E/F. Same class as the two cart walls: two
// implementations of one thing, and the second one silently the wrong one.
//
// Jeff: "That's the component the dashboard already renders. Lift that, don't rebuild it, and don't
// keep two." So this is a LIFT — the dashboard's own JSX, moved, not a reimplementation — and
// StandaloneDecksPanel is deleted.
//
// IT OWNS ITS BOARD STATE, WHICH IS WHAT LETS IT RENDER IN TWO WINDOWS AT ONCE:
//   · deck_configs via useDeckConfig(), which re-reads on the deck_configs:changed broadcast, so a
//     channel added with + in one window appears in the other.
//   · the ON lamp derived from deck_configs.channel_on (v58). It used to be useState({}) while an
//     effect asserted it downward into the engine — a WRITER of the channel cut with no store, so two
//     windows would each assert their own default and fight. Both windows now read one row.
//   · the six source-channel writers (add / kind / duck / on / remove), which are pure functions of
//     deckConfigs + saveDeckConfigs + engine and had exactly one consumer each.
//   · the jukebox channel's cut and fader, persisted in station_config_kv, default OFF.
//
// WHAT IT TAKES AS PROPS is deliberately only what it cannot resolve for itself: the three rotation
// deck states (whose owner subscribes to the engine), and two view flags.
//
// THE GUEST STRIP'S EVENTS CROSS WINDOWS (dispatchCrossWindow). They were window-scoped
// `window.dispatchEvent`, which reaches nobody from a second window — a control that renders and does
// nothing, the exact defect this arc closes. No guest deck is enabled on any station today, so this
// is a landmine defused rather than a break repaired.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { DeckState } from "../audio/engine-rodio";
import { useAudioEngine } from "../audio/AudioEngineContext";
import { useActiveStation } from "../hooks/useActiveStation";
import { useDeckConfig } from "./DeckConfigurator";
import type { DeckConfig, DeckType, SourceKind } from "./DeckConfigurator";
import ConsoleStrip from "./ConsoleStrip";
import SourceChannelStrip from "./SourceChannelStrip";
import MicChannel from "./MicChannel";
import MasterOutput from "./MasterOutput";
import { InlineProducerDesk } from "./ProducerDesk";
import VideoStudio from "./ShowPlus";
import { BoutiqueCartWall } from "./DeckConfigurator";
import { computeDeckRole } from "../lib/deckRole";
import { boardSlots } from "../lib/boardSlots";
import { dispatchCrossWindow } from "../lib/crossWindowEvent";

export interface FaderSectionProps {
  deckA: DeckState | null;
  deckB: DeckState | null;
  deckC: DeckState | null;
  /** Narrows MasterOutput exactly as the dashboard does when the cart dock is open. */
  showCarts?: boolean;
  /** Master meter collapse. A per-window VIEW preference, not board state — a window may legitimately
   *  show it collapsed while the dashboard shows it open, so it is not persisted to the row. */
  masterCollapsed?: boolean;
  onToggleMasterCollapsed?: () => void;
  /** Passed through to the producer-desk strip. */
  nowPlaying?: any;
  /** Below this width the mic strip drops out to give the music decks room, unless a guest is up. */
  narrow?: boolean;
}

export default function FaderSection({
  deckA, deckB, deckC,
  showCarts = false,
  masterCollapsed = false,
  onToggleMasterCollapsed,
  nowPlaying,
  narrow = false,
}: FaderSectionProps) {
  const engine = useAudioEngine();
  const { stationId, stationUuid } = useActiveStation();
  const { configs: deckConfigs, save: saveDeckConfigs } = useDeckConfig();

  // ── WHICH SLOTS ARE ON THE BOARD ────────────────────────────────────────────────────────────
  // Configuration decides ORDER and LABEL. The engine decides EXISTENCE: anything it is carrying and
  // the config does not mention is appended, so a slot cannot be on air without a strip, a fader, a
  // cut and a meter. The rule lives in src/lib/boardSlots.ts so it is a test rather than a habit.
  const [engineSlots, setEngineSlots] = useState<string[]>([]);
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.audio?.onLevels) return;
    const h = ether.audio.onLevels((lvl: any) => {
      if (stationUuid && lvl?.stationUuid && lvl.stationUuid !== stationUuid) return;
      const decks: any[] = Array.isArray(lvl?.decks) ? lvl.decks : [];
      const live = decks.filter(d => d && (d.source_present || d.active)).map(d => String(d.id));
      setEngineSlots(prev => (prev.length === live.length && prev.every((x, i) => x === live[i]) ? prev : live));
    });
    return () => ether.audio.offLevels?.(h);
  }, [stationUuid]);

  const configuredOrder = useMemo(
    () => (deckConfigs && deckConfigs.length ? deckConfigs.filter(c => c.enabled).map(c => c.slot) : ["A", "B", "C"]),
    [deckConfigs]);
  const hasGuestDeck = !!deckConfigs?.some(c => c.enabled && c.type === "guest");
  const activeDeckOrder = useMemo(() => {
    const raw = boardSlots(configuredOrder as any, engineSlots) as string[];
    return (narrow && !hasGuestDeck) ? raw.filter(s => s !== "mic") : raw;
  }, [JSON.stringify(configuredOrder), JSON.stringify(engineSlots), narrow, hasGuestDeck]);

  // ── THE ON LAMP READS THE ROW (v58) ─────────────────────────────────────────────────────────
  // Derived, never held: this component renders in two windows and unstored state asserted downward
  // is two writers with no arbiter. See scripts/migrate-channel-on-phase-sync-58.js.
  const srcChannelOn = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const c of deckConfigs || []) if (c.type === "source") m[c.slot] = c.channelOn ?? true;
    return m;
  }, [deckConfigs]);

  // Assert the cut DOWNWARD. The lamp was a claim, not a reading: a channel nobody had pressed showed
  // ON with the engine never told, and a cart re-dialled onto it played into a slot whose cut had
  // never been asserted. Because what is asserted is now the STORED value, two windows assert the
  // same thing. The jukebox is excluded — its cut is persisted separately and defaults OFF.
  useEffect(() => {
    if (!deckConfigs || !deckConfigs.length) return;
    for (const c of deckConfigs) {
      if (c.type !== "source" || !c.enabled) continue;
      if (c.kind === "jukebox") continue;
      const on = srcChannelOn[c.slot] ?? true;
      try { engine.getDeck(c.slot)?.setMuted(!on); } catch { /* engine not up yet */ }
    }
  }, [deckConfigs, srcChannelOn, engine]);

  // ── THE SIX SOURCE-CHANNEL WRITERS ──────────────────────────────────────────────────────────
  // Each had exactly one consumer — this section — so they live with it. Every one that touches
  // audio does BOTH: persist the row (what survives a restart and what the other window reads) and
  // push to the engine (what makes it true right now).
  const nextFreeSourceSlot = useMemo(() => {
    const used = new Set((deckConfigs || []).filter(c => c.enabled).map(c => c.slot));
    return ["D", "E", "F", "S1", "S2", "S3", "S4", "S5"].find(s => !used.has(s)) || null;
  }, [deckConfigs]);

  const onAddSourceChannel = useCallback(async () => {
    const slot = nextFreeSourceSlot;
    if (!slot) return;
    const existing = (deckConfigs || []).find(c => c.slot === slot);
    const next: DeckConfig = {
      slot, type: "source" as DeckType, label: `Source ${slot}`, color: "#8868D8", enabled: true,
      purpose: existing?.purpose || "", kind: (existing?.kind as any) || "", address: existing?.address ?? null,
    };
    const merged = (deckConfigs || []).some(c => c.slot === slot)
      ? (deckConfigs || []).map(c => (c.slot === slot ? next : c))
      : [...(deckConfigs || []), next];
    try { await saveDeckConfigs(merged); } catch (e) { console.error("[SourceChannel] add failed:", e); }
  }, [deckConfigs, nextFreeSourceSlot, saveDeckConfigs]);

  const onSetSourceKind = useCallback(async (slot: string, kind: SourceKind | "") => {
    const merged = (deckConfigs || []).map(c => (c.slot === slot ? { ...c, kind } : c));
    try { await saveDeckConfigs(merged); } catch (e) { console.error("[SourceChannel] patch failed:", e); }
  }, [deckConfigs, saveDeckConfigs]);

  const onSetSourceDuck = useCallback(async (slot: string, duck: boolean) => {
    const merged = (deckConfigs || []).map(c => (c.slot === slot ? { ...c, duck } : c));
    try { await saveDeckConfigs(merged); } catch (e) { console.error("[SourceChannel] duck save failed:", e); }
    try { await (window as any).ether?.audio?.setDuck?.(stationId, slot, duck); }
    catch (e) { console.error("[SourceChannel] duck push failed:", e); }
  }, [deckConfigs, saveDeckConfigs, stationId]);

  const onSetSourceChannelOn = useCallback(async (slot: string, on: boolean) => {
    try { engine.getDeck(slot)?.setMuted(!on); } catch (e) { console.error("[SourceChannel] cut push failed:", e); }
    const merged = (deckConfigs || []).map(c => (c.slot === slot ? { ...c, channelOn: on } : c));
    try { await saveDeckConfigs(merged); } catch (e) { console.error("[SourceChannel] cut save failed:", e); }
  }, [deckConfigs, saveDeckConfigs, engine]);

  const onRemoveSourceChannel = useCallback(async (slot: string) => {
    const merged = (deckConfigs || []).map(c => (c.slot === slot ? { ...c, enabled: false } : c));
    try { await saveDeckConfigs(merged); } catch (e) { console.error("[SourceChannel] remove failed:", e); }
  }, [deckConfigs, saveDeckConfigs]);

  const canAddSourceChannel = !!nextFreeSourceSlot;

  // ── THE JUKEBOX CHANNEL ─────────────────────────────────────────────────────────────────────
  // Its cut is persisted in station_config_kv and DEFAULTS OFF — a public jukebox must not become
  // audible because someone assigned a deck — so it is excluded from the generic lamp above and owns
  // its own state here.
  const jukeboxSlot = (deckConfigs || []).find(c =>
    c.enabled && (c.type === "jukebox" || (c.type === "source" && c.kind === "jukebox")))?.slot || null;
  const [jukeboxOn, setJukeboxOn] = useState(false);
  const [jukeboxVol, setJukeboxVol] = useState(1);

  useEffect(() => {
    if (!jukeboxSlot || stationId == null) return;
    let stop = false;
    (async () => {
      let on = false;
      try {
        const r: any = await (window as any).ether.stationConfigKv.list(stationId);
        on = ((r && r.rows) || []).find((x: any) => x.key === "jukebox_channel_on")?.value === "1";
      } catch { /* no config yet — stays OFF, the safe direction */ }
      if (stop) return;
      setJukeboxOn(on);
      // Assert BOTH downward: the engine boots un-muted and at its own level.
      try {
        (engine.getDeck(jukeboxSlot as any) as any)?.setMuted?.(!on);
        engine.getDeck(jukeboxSlot as any)?.setVolume(jukeboxVol);
      } catch { /* engine not ready */ }
    })();
    return () => { stop = true; };
  }, [engine, jukeboxSlot, stationId]);

  const toggleJukeboxChannel = () => {
    if (!jukeboxSlot) return;
    setJukeboxOn(prev => {
      const next = !prev;
      try { (engine.getDeck(jukeboxSlot as any) as any)?.setMuted?.(!next); } catch { /* engine not ready */ }
      try { (window as any).ether.stationConfigKv.upsertByKey(stationId, "jukebox_channel_on", next ? "1" : "0"); }
      catch { /* non-fatal */ }
      return next;
    });
  };

  // ── GUEST CHANNELS ──────────────────────────────────────────────────────────────────────────
  // Level is pushed from the WebRTC layer; the toggle and fader are relayed across windows so this
  // section is not a dead control when it renders in one of its own.
  const [consoleGuestOn, setConsoleGuestOn] = useState<Record<string, boolean>>({});
  const [consoleGuestLevel, setConsoleGuestLevel] = useState<Record<string, number>>({});
  useEffect(() => {
    const onLevel = (e: Event) => {
      const d = (e as CustomEvent).detail as { slot: string; level: number };
      if (!d?.slot) return;
      setConsoleGuestLevel(prev => ({ ...prev, [d.slot]: d.level }));
    };
    window.addEventListener("ether:guest-level", onLevel as EventListener);
    return () => window.removeEventListener("ether:guest-level", onLevel as EventListener);
  }, []);

  const toggleMasterCollapsed = onToggleMasterCollapsed || (() => {});

  return (
<div style={{ display: "flex", gap: 0, flex: 1, minHeight: 0, overflow: "hidden" }}>
  {activeDeckOrder.map((slot) => {
    const stored = deckConfigs?.find(d => d.slot === slot);
    // A slot the engine is carrying with no config row is still a CHANNEL. It renders as the
    // generic source strip — selector, fader, ON/PFL, meter — rather than defaulting to a
    // music deck, because "what you dial in is the source; the channel itself is generic".
    // Its patch point cannot be persisted until it has a row (that is the next step in
    // docs/on-air-but-invisible-slot-enumeration-2026-09-03.md); until then it is visible and
    // controllable, which is the state this step exists to guarantee.
    const config = stored || (slot === "mic" ? undefined : {
      slot, type: "source" as DeckType, kind: "" as any, label: slot,
      color: "#8868D8", enabled: true, purpose: "", address: null, duck: false,
    } as DeckConfig);
    const deckType = config?.type || (slot === "mic" ? "mic" : "music");
    const deckMap: Record<string, any> = { A: deckA, B: deckB, C: deckC };
    const deck = deckMap[slot as string];
    const deckColors: Record<string, string> = { A: "var(--deck-a)", B: "var(--deck-b)", C: "var(--deck-c)", D: "#fb923c", E: "#e879f9", mic: "#a855f7" };
    // Rotation decks A/B/C always use the canonical slot color (A blue, B green, C purple)
    // so the faders match the Up Next deck rows + library A/B/C buttons. config.color only
    // carries the deck-TYPE color (every music deck is green), which can't tell A/B/C apart.
    const deckColor = (slot === "A" || slot === "B" || slot === "C")
      ? deckColors[slot]
      : (config?.color || deckColors[slot] || "var(--accent-blue)");

    // SOURCE channel → the strip with the patch-point dropdown (slice 2)
    if (deckType === "source" && config) {
      // deckMap covers A/B/C only, so this is undefined for a source slot — exactly as it is
      // for D/E/F in the fallback branch below. The fader starts at unity and the VU comes
      // from ConsoleStrip's own levels subscription (which DOES cover every slot since
      // 2026-08-18). engine.getDeck() is a command handle, not state.
      const dk = deckMap[slot as string];
      const isJukeboxSrc = config.kind === "jukebox";
      return (
        <div key={slot} style={{ flex: 1, display: "flex", minWidth: 0 }}>
          <SourceChannelStrip
            config={config}
            // A jukebox-patched channel IS the jukebox channel: same persisted cut, same
            // default-OFF, same fader the retired legacy branch drove. Anything else is an
            // ordinary channel. One strip, two owners of state — never two strips.
            volume={isJukeboxSrc ? jukeboxVol : (dk?.volume ?? 1)}
            isOn={isJukeboxSrc ? jukeboxOn : (srcChannelOn[slot] ?? true)}
            onVolumeChange={v => {
              if (isJukeboxSrc) setJukeboxVol(v);
              engine.getDeck(slot)?.setVolume(v);
            }}
            onToggleOn={() => {
              if (isJukeboxSrc) { toggleJukeboxChannel(); return; }
              void onSetSourceChannelOn?.(slot, !(srcChannelOn[slot] ?? true));
            }}
            onKindChange={k => onSetSourceKind?.(slot, k)}
            duck={!!config.duck}
            onDuckChange={d => onSetSourceDuck?.(slot, d)}
            onRemove={() => onRemoveSourceChannel?.(slot)}
          />
        </div>
      );
    }

    // Music decks → ConsoleStrip (fader + VU)
    if (deckType === "music") {
      return (
        <div key={slot} style={{ flex: 1, display: "flex", minWidth: 0 }}>
          <ConsoleStrip
            label={config?.label || `DECK ${slot}`}
            color={deckColor}
            volume={deck?.volume ?? 1}
            deckId={slot}
            hideLabel={["A","B","C"].includes(slot)}
            role={["A","B","C"].includes(slot) ? computeDeckRole(slot as "A"|"B"|"C", { A: deckA, B: deckB, C: deckC }) : "third"}
            isPlaying={deck?.status === "playing"}
            isOn={true}
            onVolumeChange={v => engine.getDeck(slot)?.setVolume(v)}
            // ── DECK ON — the board's start control, and the ONLY one (2026-08-02) ──────────
            // This used to be a solo play/pause: `getDeck(slot).play()` → a RAW audioPlay
            // straight to Rust, outside the advance chain. No serialization, no guards, no stop
            // of the outgoing, no liveDeck update — the out-of-chain start shape that put two
            // decks on air on 2026-07-29. Pressing ON on a cued deck while another played gave
            // you both, caught only by the liveDeck guard after its 7.5s grace.
            //
            // Now: PLAYING → board-style channel OFF (audio off now, not a pause — a real
            // board's ON kills the channel). Otherwise → the serialized, guarded rotate, which
            // starts this deck and stops the outgoing via the deferred Bug-A stop.
            // (docs/auto-xfade-contract-trace-2026-08-02.md)
            onToggleOn={async () => {
              const eng: any = engine;
              if (deck?.status === "playing") {
                if (eng.isDaemonDriven) await eng.deckOff(slot);
                else engine.getDeck(slot)?.stop();
                return;
              }
              if (eng.isDaemonDriven) {
                const r = await eng.deckCrossfade(undefined, slot);
                // Honest feedback: a press the daemon absorbed must not look like it worked.
                if (r && r.ok === false) console.warn(`[deck ${slot}] start not applied: ${r.reason}`);
                return;
              }
              engine.getDeck(slot)?.play();   // in-process: no daemon chain to route through
            }}
          />
        </div>
      );
    }

    // Mic decks → independent MicChannel: own device + capture + meter + output gate per slot.
    // Up to 6 mics, each on a different physical input (device saved per slot).
    if (deckType === "mic" || slot === "mic") {
      return (
        <div key={slot} style={{ flex: 1, display: "flex", minWidth: 0 }}>
          <MicChannel slot={slot} label={config?.label || "MIC"} />
        </div>
      );
    }
    if (deckType === "video") {
      return <div key={slot} style={{ flex: 2, minWidth: 280 }}><VideoStudio embedded /></div>;
    }
    if (deckType === "cart") {
      return <div key={slot} style={{ flex: 1, minWidth: 120 }}><div style={{ height: "100%", background: "var(--bg-secondary)", overflow: "hidden" }}><BoutiqueCartWall /></div></div>;
    }
    if (deckType === "desk") {
      return <div key={slot} style={{ flex: 1, minWidth: 220 }}><InlineProducerDesk episodeTitle={undefined} nowPlaying={nowPlaying} /></div>;
    }
    if (deckType === "guest") {
      const guestIsOn  = consoleGuestOn[slot] ?? false;
      const guestLevel = consoleGuestLevel[slot] ?? 0;
      const guestVol   = consoleGuestLevel[`${slot}_vol`] ?? 1;
      return (
        <div key={slot} style={{ flex: 1, minWidth: 0 }}>
          <ConsoleStrip
            label={config?.label || `GUEST ${slot}`}
            color="#a78bfa"
            volume={guestVol}
            level={guestIsOn ? guestLevel : 0}
            isPlaying={guestIsOn && guestLevel > 0.02}
            isOn={guestIsOn}
            onVolumeChange={v => {
              setConsoleGuestLevel(prev => ({ ...prev, [`${slot}_vol`]: v }));
              dispatchCrossWindow("ether:guest-volume", { slot, volume: v });
            }}
            onToggleOn={() => {
              const next = !guestIsOn;
              setConsoleGuestOn(prev => ({ ...prev, [slot]: next }));
              // Broadcast guest on/off — VideoStudio/Guest WebRTC layer can mute/unmute
              dispatchCrossWindow("ether:guest-toggle", { slot, active: next });
            }}
          />
        </div>
      );
    }

    // (RETIRED 2026-08-22) The legacy `deckType === "jukebox"` strip stood here.
    //
    // The jukebox is a SOURCE you patch in, not a deck type — so it is now one entry in the
    // source dropdown and renders through the SOURCE branch above, which carries the same
    // persisted channel cut and the same default-OFF. Two strips for one routing was the
    // duplication the console model exists to remove.
    //
    // Existing rows were migrated in place (electron/main.js runMigrations: type='jukebox'
    // → type='source', kind='jukebox'), so a station that had deck D as a jukebox keeps its
    // deck, its fader and its remembered ON state. station_config_kv's jukebox_channel_on is
    // station-scoped, not slot-scoped, so the key survives the type change untouched — and
    // the Jukebox window still reads the same truth.

    // Fallback: ConsoleStrip
    return (
      <div key={slot} style={{ flex: 1, minWidth: 0 }}>
        <ConsoleStrip
          label={config?.label || slot}
          color={deckColor}
          volume={deck?.volume ?? 1}
          deckId={slot}
          hideLabel={["A","B","C"].includes(slot)}
          isPlaying={deck?.status === "playing"}
          isOn={true}
          onVolumeChange={v => engine.getDeck(slot)?.setVolume(v)}
          onToggleOn={() => {
            if (deck?.status === "playing") engine.getDeck(slot)?.pause();
            else engine.getDeck(slot)?.play();
          }}
        />
      </div>
    );
  })}
  {/* ── ADD A SOURCE CHANNEL (slice 2) ──────────────────────────────────────────────────
      The console gesture: press +, get a channel, pick its source. It is a UI affordance
      over a FIXED engine slot pool (SLOT_COUNT = 12, slice 1) — nothing about the realtime
      callback changes shape when a channel appears, which is the whole reason this is safe.
      When every source-capable slot is in use the control says so rather than vanishing. */}
  {onAddSourceChannel && (
    <div style={{ display: "flex", alignItems: "stretch", padding: "0 2px" }}>
      <button
        onClick={() => canAddSourceChannel && onAddSourceChannel()}
        disabled={!canAddSourceChannel}
        title={canAddSourceChannel
          ? "Add a source channel — jukebox, announcement or hand-fired jingle"
          : "Every source channel is already on the board"}
        aria-label="Add a source channel"
        style={{
          width: 26, alignSelf: "center", padding: "10px 0",
          background: "var(--bg-tertiary)",
          border: "1px solid var(--border-primary)", borderRadius: 3,
          color: canAddSourceChannel ? "var(--accent-cyan)" : "var(--text-tertiary)",
          fontSize: 15, fontWeight: 700, lineHeight: 1,
          cursor: canAddSourceChannel ? "pointer" : "not-allowed",
          opacity: canAddSourceChannel ? 1 : 0.45,
        }}
      >+</button>
    </div>
  )}
  {/* Master Output — owns its own audio:levels subscription */}
  <MasterOutput
    expanded={!showCarts && !masterCollapsed}
    collapsed={masterCollapsed}
    onToggleCollapsed={toggleMasterCollapsed}
  />
</div>
  );
}
