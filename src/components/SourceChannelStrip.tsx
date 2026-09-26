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
import { useActiveStation } from "../hooks/useActiveStation";
import { useMicInputs, useInputDevices, micStateWords, openMicPreferences } from "../hooks/useMicInputs";
import ConsoleStrip from "./ConsoleStrip";
import { SOURCE_KINDS, sourceKindMeta, deckLetter, type SourceKind, type DeckConfig } from "./DeckConfigurator";
import { canHostJukebox } from "./DeckConfigurator";

interface Props {
  config: DeckConfig;
  /** Fader position 0..1 for this slot. */
  volume: number;
  onVolumeChange: (v: number) => void;
  /** CHANNEL SWITCH — controlled by the board, not by this strip.
   *
   *  It was internal state until the legacy jukebox branch was retired. That branch carried the
   *  jukebox's channel cut, which is persisted in station_config_kv and DEFAULTS OFF on purpose —
   *  "a public jukebox must not become audible because someone assigned a deck". Local state here
   *  would have defaulted a public jukebox to ON at every launch. The owner of the state is the
   *  board; this strip only renders it. */
  isOn: boolean;
  onToggleOn: () => void;
  onPfl?: () => void;
  /** Persist a new patch point for this slot. */
  onKindChange: (kind: SourceKind | "") => void;
  /** DUCK — when this channel has audio, the programme drops under it and rises back after.
   *  Persisted on the channel's own row (deck_configs.duck, v43) and pushed to the engine. */
  duck: boolean;
  onDuckChange: (duck: boolean) => void;
  /** Remove this channel from the board (the − control). */
  onRemove: () => void;
  compact?: boolean;
}

export default function SourceChannelStrip({
  config, volume, isOn, onVolumeChange, onToggleOn, onPfl, onKindChange, duck, onDuckChange, onRemove, compact,
}: Props) {
  const meta = sourceKindMeta(config.kind);

  // ── INPUT DEVICES IN THE SOURCE LIST ──────────────────────────────────────────────────────────
  // Jeff, 2026-09-02: "all device inputs discoverable should be in the one dropdown source list". Still true —
  // but since the mic became an ENGINE input (docs/dsp-mic-in-engine.md, 2026-09-26) the devices listed are the
  // ENGINE's (this computer's inputs as the audio engine sees them), and picking one PATCHES the engine: the mic
  // then reaches air, the meter, the channel EQ and the ducker like every channel. The browser capture that used
  // to run here (getUserMedia → the default output, never on air) is gone. The input NUMBER, the input GAIN and
  // the live state are in Preferences → Audio → Mic Inputs; the strip shows the state and links there.
  const MIC_PREFIX = "mic:";
  const { stationId } = useActiveStation();
  const mic = useMicInputs(stationId);
  const { devices } = useInputDevices();
  const patch = mic.patches[config.slot];
  const micState = mic.states[config.slot];
  const isMic = config.kind === "mic";
  const words = micStateWords(micState, !!patch);
  const [patchErr, setPatchErr] = useState<string | null>(null);
  const patchTo = async (device: string | null) => {
    setPatchErr(null);
    const r = await mic.setPatch(config.slot, device ? { device, channel: patch?.channel ?? 1, gainDb: patch?.gainDb ?? 0 } : null);
    if (!r.ok) setPatchErr(r.reason || "not applied");
  };

  // Jukebox is offerable only where it can actually be routed. Automation enumerates A/B/C and
  // nothing else, so the jukebox has always been restricted to the aux slots; the new engine slots
  // (S1..) are not wired to it yet. Offering it where it cannot play would be exactly the decorative
  // control this strip exists to avoid — so it is disabled with the reason, never silently missing.
  const options = useMemo(() => SOURCE_KINDS.map(k => {
    if (k.kind === "jukebox" && !canHostJukebox(config.slot)) {
      return { ...k, disabled: true, why: `Jukebox routes on D/E/F only — not ${config.slot}` };
    }
    // MIC is an ENGINE input since 2026-09-26 (docs/dsp-mic-in-engine.md). Network stays disabled — it genuinely
    // has no path yet.
    if (k.family === "stream" && k.kind !== "mic") {
      return { ...k, disabled: true, why: "Phase 2 — needs the engine capture path" };
    }
    return { ...k, disabled: false, why: "" };
  }), [config.slot]);

  // A patched input names itself on the channel — "Focusrite", not "Mic".
  const label = (isMic && patch) ? patch.device
    : meta ? meta.label : `SOURCE ${deckLetter(config.slot)}`;
  const TONE: Record<string, string> = { ok: "var(--accent-green)", warn: "var(--accent-amber, #f59e0b)", bad: "var(--accent-red, #ef4444)", off: "var(--text-tertiary)" };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      {/* ── the patch point ─────────────────────────────────────────────────────────────────── */}
      <div style={{ padding: "4px 6px 2px", display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{
            fontSize: 8, fontWeight: 700, letterSpacing: "0.12em",
            color: "var(--text-tertiary)", flex: 1, minWidth: 0,
          }}>
            SOURCE {deckLetter(config.slot)}
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
          value={isMic ? (patch ? MIC_PREFIX + patch.device : "mic") : (config.kind || "")}
          onChange={e => {
            const v = e.target.value;
            if (v.startsWith(MIC_PREFIX)) {
              if (!isMic) onKindChange("mic");
              patchTo(v.slice(MIC_PREFIX.length));
              return;
            }
            if (v === "mic") { if (!isMic) onKindChange("mic"); return; }
            // leaving the mic: unpatch the input so the engine closes it and the slot is free for the new source
            if (isMic && patch) patchTo(null);
            onKindChange(v as SourceKind | "");
          }}
          aria-label={`Source for channel ${deckLetter(config.slot)}`}
          style={{
            width: "100%", fontSize: 10, padding: "3px 4px", borderRadius: 2,
            background: "var(--bg-tertiary)", color: "var(--text-primary)",
            border: "1px solid var(--border-primary)", cursor: "pointer",
          }}
        >
          <option value="">— no source —</option>
          {options.filter(o => o.kind !== "mic").map(o => (
            <option key={o.kind} value={o.kind} disabled={o.disabled}>
              {o.label}{o.disabled ? " ·  not yet" : ""}
            </option>
          ))}
          {/* a mic channel whose input is not (yet) patched */}
          <option value="mic">Mic — pick an input…</option>
          {patch && !devices?.some(d => d.name === patch.device) && (
            <option value={MIC_PREFIX + patch.device}>{patch.device} (not connected)</option>
          )}
          {(devices || []).length > 0 && (
            <optgroup label="INPUT DEVICES (this computer)">
              {(devices || []).map(d => (
                <option key={d.name} value={MIC_PREFIX + d.name}>{d.name}</option>
              ))}
            </optgroup>
          )}
        </select>

        {/* THE MIC'S STATE — the engine's, said in words; the input number and gain live in Preferences. */}
        {isMic && (
          <button onClick={openMicPreferences}
            title={`${words.text}${micState?.reason ? ` — ${micState.reason}` : ""}. Input number, gain and live state: Preferences → Audio → Mic Inputs.`}
            style={{ width: "100%", padding: "2px 4px", borderRadius: 2, cursor: "pointer", fontSize: 8, fontWeight: 700,
                     letterSpacing: "0.04em", textAlign: "left", background: "var(--bg-tertiary)",
                     border: `1px solid ${words.tone === "bad" ? TONE.bad : "var(--border-primary)"}`, color: TONE[words.tone],
                     overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            ● {patch ? `IN ${patch.channel} · ${patch.gainDb >= 0 ? "+" : ""}${patch.gainDb} dB · ${words.text}` : "no input — Preferences → Audio"}
          </button>
        )}
        {patchErr && <div style={{ fontSize: 8, color: TONE.bad }}>⚠ {patchErr}</div>}

        {/* DUCK — the one control §B.6 exposes today. Threshold, attack, hold, release and depth
            are implemented with the design's defaults but have no tuning UI yet, so this says ON/OFF
            and nothing more. A control that implied tunability it does not have would be the same
            defect as the AUTO-DUCK button this replaces. */}
        {/* THE DUCKER IS ALWAYS AVAILABLE, WHATEVER THE SOURCE IS.

            Jeff, 2026-09-14: "there is no specific deck/fader for anything the drop-down source menu
            is for the user to decide what input goes there just like a wheatstone board the ducker
            option should always be available whether its a sweeper announcement cart jukebox doesnt
            matter but the user would most likely have ducker off on a deck/fader they have sweeper
            on." And: "deck e should never be dedicated to sweepers."

            WHAT WAS HERE. On a sweeper-kinded channel this hid the toggle and printed "SWEEPERS RIDE
            WITH THE MUSIC — never duck it", on the reasoning that the engine could not duck from that
            slot so a control would be dishonest. Two things wrong with that. The channel is GENERIC —
            the dropdown is the operator's choice of what feeds this fader, not a fact about the
            hardware — so deciding its controls from its current selection is the wrong model. And the
            behaviour it promised was not happening: the duck flag on that channel was ON at -34 dB and
            was cutting the lyrics off the end and start of songs, with no way to reach it from the
            screen because this had removed the only control.

            A control taken off the screen does not stop the behaviour. It stops the operator fixing it. */}
        <button
          onClick={() => onDuckChange(!duck)}
          role="switch"
          aria-checked={duck}
          title={duck
            ? "Audio on this channel ducks the programme under it, and it rises back when the channel goes quiet"
            : "Ducking off — this channel mixes over the programme at full level"}
          style={{
            width: "100%", padding: "3px 4px", borderRadius: 2, cursor: "pointer",
            fontSize: 8, fontWeight: 700, letterSpacing: "0.08em",
            background: duck ? "rgb(from var(--accent-cyan) r g b / 0.12)" : "var(--bg-tertiary)",
            border: `1px solid ${duck ? "rgb(from var(--accent-cyan) r g b / 0.45)" : "var(--border-primary)"}`,
            color: duck ? "var(--accent-cyan)" : "var(--text-tertiary)",
          }}
        >
          {duck ? "DUCK ON" : "DUCK OFF"}
        </button>

      </div>

      {/* ── the channel itself ──────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <ConsoleStrip
          label={label}
          color="#8868D8"
          volume={volume}
          // deckId makes ConsoleStrip meter this slot's PRE-FADER engine tap (Slice 2 meter bus) — a MIC too,
          // since it is an engine input. A mic that is not live (unpatched, not connected, lost, digital
          // silence) draws NOT FED rather than a flat zero: its silence is a fault, not a level.
          deckId={config.slot}
          meterNotFed={isMic && words.tone !== "ok"}
          // Read this slot's OWN level, on any slot letter — D/E/F today, S1..S5 once the pool fills.
          sourceChannel
          // ON COLOUR — the same two colours every other channel uses, via the same code path.
          //
          // ConsoleStrip derives "engaged" from `isOn && isPlaying` (ConsoleStrip.tsx:262/278/289).
          // Passing the deck's TRANSPORT status as isPlaying read inverted here: deckMap covers A/B/C
          // only, so a source slot's status is always false and the strip showed OFF while the channel
          // was on. An operator reads channel state by colour, so a wrong one is a hazard, not a
          // cosmetic bug.
          //
          // The CART and JUKEBOX channels already solved this: pass isOn={true} and let isPlaying
          // carry the CHANNEL SWITCH. Same shape here — no new prop, no special case in the shared
          // component.
          isOn={true}
          isPlaying={isOn}
          onVolumeChange={onVolumeChange}
          onToggleOn={onToggleOn}
          onPfl={onPfl}
          compact={compact}
          hideLabel={false}
        />
      </div>
    </div>
  );
}
