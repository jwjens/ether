// StandaloneDecksPanel.tsx — all-inclusive decks widget for secondary monitor
// Reads deck_configs from DB, renders every enabled deck in a horizontal row.
// Music/video decks → OnAirDeck (polls audio state independently)
// Mic/guest decks   → MicDeck (own Web Audio context)
// Cart/desk decks   → skipped (no standalone equivalent)

import { useState, useEffect } from "react";
import type { DeckState } from "../audio/engine-rodio";
import type { DeckConfig, DeckType } from "./DeckConfigurator";
import OnAirDeck from "./OnAirDeck";
import MicDeck from "./MicDeck";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
import { computeDeckRole, type DeckRole } from "../lib/deckRole";

// ── Per-deck audio state poller ───────────────────────────────

const toDeckState = (d: any): DeckState | null => d ? ({
  status:      d.status      ?? "idle",
  title:       d.title       ?? "",
  artist:      d.artist      ?? "",
  filePath:    d.filePath    ?? "",
  positionSec: d.positionSec ?? 0,
  durationSec: d.durationSec ?? 0,
  volume:      d.volume      ?? 1,
} as DeckState) : null;

function MusicDeckPanel({ slot }: { slot: string }) {
  const [deck, setDeck] = useState<DeckState | null>(null);
  const [role, setRole] = useState<DeckRole>("third");
  const id = slot as "A" | "B" | "C";

  useEffect(() => {
    let handle: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const raw = await (window as any).ether.audio.getState();
        const s: any = typeof raw === "string" ? JSON.parse(raw) : raw;
        const all = { A: toDeckState(s.deckA), B: toDeckState(s.deckB), C: toDeckState(s.deckC) };
        if (all[id]) setDeck(all[id]);
        setRole(computeDeckRole(id, all));
      } catch {}
      handle = setTimeout(poll, 100);
    }
    poll();
    return () => clearTimeout(handle);
  }, [slot]);

  return (
    <OnAirDeck
      deck={deck}
      label={`Deck ${slot}`}
      deckId={id}
      role={role}
      onPlay={()  => (window as any).ether.audio.play(slot)}
      onPause={()  => (window as any).ether.audio.pause(slot)}
      onResume={()  => (window as any).ether.audio.play(slot)}
      onStop={()  => (window as any).ether.audio.stop(slot)}
      onVolume={(v) => (window as any).ether.audio.setVolume(slot, v)}
    />
  );
}

// ── Main panel ────────────────────────────────────────────────

export default function StandaloneDecksPanel() {
  const { stationId, isReady } = useActiveStation();
  const [configs, setConfigs] = useState<DeckConfig[]>([]);

  useEffect(() => {
    if (!isReady) return;
    // station_id scoping: Strategy B (refactored from ether.db.query to standard queryScoped path)
    queryScoped<any>("SELECT slot, type, label, color, enabled FROM deck_configs ORDER BY slot", [], stationId)
      .then((rows: any[]) => {
        const SLOT_ORDER = ["A", "B", "C", "D", "E", "F"];
        const sorted = [...rows].sort(
          (a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot)
        );
        setConfigs(
          sorted
            .filter(r => r.enabled === 1 || r.enabled === true)
            .map(r => ({ ...r, enabled: true, type: r.type as DeckType }))
        );
      })
      .catch(() => {
        // Fallback: show A/B/C if DB not ready
        setConfigs([
          { slot: "A", type: "music", label: "Deck A", color: "#34d399", enabled: true },
          { slot: "B", type: "music", label: "Deck B", color: "#34d399", enabled: true },
          { slot: "C", type: "music", label: "Deck C", color: "#34d399", enabled: true },
        ]);
      });
  }, [isReady, stationId]);

  if (configs.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#404050", fontSize: 12 }}>
        Loading deck configuration…
      </div>
    );
  }

  return (
    <div style={{
      display: "flex",
      flex: 1,
      height: "100%",
      overflow: "hidden",
      gap: 0,
    }}>
      {configs.map((cfg, i) => {
        const type = cfg.type as DeckType;
        const isLast = i === configs.length - 1;
        return (
          <div
            key={cfg.slot}
            style={{
              flex: 1,
              minWidth: 0,
              borderRight: isLast ? "none" : "1px solid #1a1a28",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {type === "mic" || type === "guest" ? (
              <MicDeck />
            ) : (["music", "video"].includes(type) && ["A","B","C"].includes(cfg.slot)) ? (
              <MusicDeckPanel slot={cfg.slot} />
            ) : (
              // cart / desk / unknown — show a placeholder
              <div style={{
                flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
                flexDirection: "column", gap: 6,
                background: "#0a0a10", color: "#303040",
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em" }}>{cfg.label.toUpperCase()}</div>
                <div style={{ fontSize: 9, opacity: 0.5 }}>not available in monitor mode</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
