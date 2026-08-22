// SourceChannelStrip — one console channel whose INPUT you pick.
//
// Slice 2 of docs/aux-channel-ducker-announcements-design-2026-08-21.md.
//
// The console model, not a deck-per-feature: a strip with a fader, ON and PFL, plus a SOURCE
// dropdown that says what is patched into it — the way a Wheatstone bus selector works. Every new
// audio source becomes an entry in this dropdown instead of a new row in Configure Decks, which is
// what "stop building a dedicated deck per feature" actually means.
//
// HONEST STATE (the reason this file has a state line at all): the file kinds are selectable now,
// but only the jukebox actually makes sound today. Announcement playout is a later slice and the
// stream kinds need an engine capture path that does not exist (Phase 2). Rather than hide that or
// let the operator infer it from silence, the strip SAYS which it is, underneath the dropdown.
// A control that looks live and is not is the defect this project keeps paying for.

import { useMemo, useState } from "react";
import ConsoleStrip from "./ConsoleStrip";
import { SOURCE_KINDS, sourceKindMeta, type SourceKind, type DeckConfig } from "./DeckConfigurator";
import { canHostJukebox } from "./DeckConfigurator";

interface Props {
  config: DeckConfig;
  /** Fader position 0..1 for this slot. */
  volume: number;
  isPlaying: boolean;
  onVolumeChange: (v: number) => void;
  /** Channel CUT — the board's on/off door. Commands the engine's per-slot mute. */
  onSetMuted: (muted: boolean) => void;
  onPfl?: () => void;
  /** Persist a new patch point for this slot. */
  onKindChange: (kind: SourceKind | "") => void;
  /** Remove this channel from the board (the − control). */
  onRemove: () => void;
  compact?: boolean;
}

export default function SourceChannelStrip({
  config, volume, isPlaying, onVolumeChange, onSetMuted, onPfl, onKindChange, onRemove, compact,
}: Props) {
  const meta = sourceKindMeta(config.kind);

  // CHANNEL ON reflects the last command this strip issued. Stated plainly because it is a real
  // limitation: the engine does not publish a per-slot muted flag to the renderer, so there is
  // nothing to mirror yet. It is not invented state — pressing ON always commands the engine — but
  // if something else muted the slot this would not know. Mirroring engine truth belongs with the
  // slice that gives these channels audio; claiming it now would be the kind of confident-and-wrong
  // indicator this project has paid for before.
  const [isOn, setIsOn] = useState(true);

  // Jukebox is offerable only where it can actually be routed. Automation enumerates A/B/C and
  // nothing else, so the jukebox has always been restricted to the aux slots; the new engine slots
  // (S1..) are not wired to it yet. Offering it where it cannot play would be exactly the decorative
  // control this strip exists to avoid — so it is disabled with the reason, never silently missing.
  const options = useMemo(() => SOURCE_KINDS.map(k => {
    if (k.kind === "jukebox" && !canHostJukebox(config.slot)) {
      return { ...k, disabled: true, why: `Jukebox routes on D/E/F only — not ${config.slot}` };
    }
    if (k.family === "stream") {
      return { ...k, disabled: true, why: "Phase 2 — needs the engine capture path" };
    }
    return { ...k, disabled: false, why: "" };
  }), [config.slot]);

  const label = meta ? meta.label : `SOURCE ${config.slot}`;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      {/* ── the patch point ─────────────────────────────────────────────────────────────────── */}
      <div style={{ padding: "4px 6px 2px", display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{
            fontSize: 8, fontWeight: 700, letterSpacing: "0.12em",
            color: "var(--text-tertiary)", flex: 1, minWidth: 0,
          }}>
            SOURCE {config.slot}
          </span>
          <button
            onClick={onRemove}
            title={`Remove source channel ${config.slot} from the board`}
            aria-label={`Remove source channel ${config.slot}`}
            style={{
              width: 14, height: 14, lineHeight: "12px", padding: 0,
              border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
              color: "var(--text-tertiary)", fontSize: 11, cursor: "pointer", borderRadius: 2,
            }}
          >−</button>
        </div>

        <select
          value={config.kind || ""}
          onChange={e => onKindChange(e.target.value as SourceKind | "")}
          aria-label={`Source for channel ${config.slot}`}
          style={{
            width: "100%", fontSize: 10, padding: "3px 4px", borderRadius: 2,
            background: "var(--bg-tertiary)", color: "var(--text-primary)",
            border: "1px solid var(--border-primary)", cursor: "pointer",
          }}
        >
          <option value="">— no source —</option>
          {options.map(o => (
            <option key={o.kind} value={o.kind} disabled={o.disabled}>
              {o.label}{o.disabled ? " ·  not yet" : ""}
            </option>
          ))}
        </select>

        {/* The honest state line. Never claims audio that cannot happen. */}
        <div style={{
          fontSize: 8, lineHeight: 1.25, minHeight: 20,
          color: meta ? "var(--text-tertiary)" : "var(--text-quaternary, var(--text-tertiary))",
        }}>
          {meta ? meta.state : "Nothing patched — pick a source."}
        </div>
      </div>

      {/* ── the channel itself ──────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <ConsoleStrip
          label={label}
          color="#8868D8"
          volume={volume}
          deckId={config.slot}
          isPlaying={isPlaying}
          isOn={isOn}
          onVolumeChange={onVolumeChange}
          onToggleOn={() => { const next = !isOn; setIsOn(next); onSetMuted(!next); }}
          onPfl={onPfl}
          compact={compact}
          hideLabel={false}
        />
      </div>
    </div>
  );
}
