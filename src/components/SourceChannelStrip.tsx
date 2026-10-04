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

import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { useMicInputs, useInputDevices, micStateWords, openMicPreferences } from "../hooks/useMicInputs";
import { useRemoteLink, rxWords, linkNotFed, openLinkPreferences } from "../hooks/useRemoteLink";
import LinkPairPicker from "./LinkPairPicker";
import { linkNeedsPatch } from "../lib/linkPairing";
import ConsoleStrip from "./ConsoleStrip";
import { sourceKindMeta, sourceKindOptions, type SourceKind, type DeckConfig } from "./DeckConfigurator";
import { useBoardName } from "../hooks/useBoardName";

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
  /** SET the channel switch (idempotent — the Link's auto-cut uses it: two windows both saying OFF is still OFF,
   *  where two toggles would turn it back ON). The same writer as the ON button. */
  onSetOn?: (on: boolean) => void;
  onPfl?: (on: boolean) => void;
  /** Persist a new patch point for this slot. */
  onKindChange: (kind: SourceKind | "") => void;
  /** DUCK — when this channel has audio, the programme drops under it and rises back after.
   *  Persisted on the channel's own row (deck_configs.duck, v43) and pushed to the engine. */
  duck: boolean;
  onDuckChange: (duck: boolean) => void;
  /** Remove this channel from the board (the − control). */
  onRemove: () => void;
  compact?: boolean;
  /** SLICE 7 — the show this channel is waiting for (the blade's state), and TAKE NOW. */
  pendingShow?: string | null;
  onTakeNow?: () => void;
}

export default function SourceChannelStrip({
  config, volume, isOn, onVolumeChange, onToggleOn, onSetOn, onPfl, onKindChange, duck, onDuckChange, onRemove, compact, pendingShow = null, onTakeNow,
}: Props) {
  const meta = sourceKindMeta(config.kind);
  // ONE NAME PER FADER — the board letter, never the engine slot id (src/lib/boardName.ts).
  const letter = useBoardName()(config.slot);

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

  // ── THE REMOTE LINK (docs/remote-link-design-2026-09-28.md) ─────────────────────────────────────────────
  // A FEED over the network into this fader, like the input selector on a console channel. Picking "Link" stores the
  // patch; the SENDING computer's key line is pasted here (beside the dropdown) and only then is it in the engine
  // (engine first, stored machine-local). ✕ forgets the key — that sender is cut off, this fader alone. Buffer,
  // port and auto-cut live in Preferences → Broadcast → Remote Link; the strip shows the state.
  const link = useRemoteLink(stationId);
  const isLink = config.kind === "link";
  const linkInput = link.cfg?.input && link.cfg.input.slot === config.slot ? link.cfg.input : null;
  const linkRx = link.state?.rx ?? null;
  const linkW = rxWords(linkInput ? linkRx : null, !!linkInput, !!linkInput?.from, linkInput ? link.cfg?.inputRefusal : null);
  const linkTo = async (on: boolean) => {
    setPatchErr(null);
    // Never silently: before 2026-10-04 a pick made before the Link settings loaded returned here and left the fader
    // "set to Link but not patched". The effect below patches as soon as they arrive.
    if (!link.cfg) { if (on) setPatchErr("the Link settings are still loading — it patches as soon as they arrive"); return; }
    const cur = link.cfg.input;
    if (!on) { if (cur && cur.slot === config.slot) { const r = await link.setInput(null); if (!r.ok) setPatchErr(r.reason || "not applied"); } return; }
    const d = link.cfg.defaults;
    const r = await link.setInput({ slot: config.slot, jitterMs: cur?.jitterMs ?? d.jitterMs, port: cur?.port ?? d.port,
                                    autoCut: cur?.autoCut ?? link.cfg.autoCutDefault.autoCut, autoCutSec: cur?.autoCutSec ?? link.cfg.autoCutDefault.autoCutSec });
    if (!r.ok) setPatchErr(r.reason || "not applied");
  };
  /** The fader's key: a pasted line from the sending computer, or null = forget it (cut that sender off). */
  const linkKey = async (line: string | null) => {
    setPatchErr(null);
    if (!linkInput) return;
    const { from: _from, ...rest } = linkInput;
    const r = await link.setInput(line == null ? { ...rest, clearKey: true } : { ...rest, keyLine: line });
    if (!r.ok) setPatchErr(r.reason || "not applied");
  };
  // A FADER WHOSE SOURCE IS LINK IS PATCHED HERE, ALWAYS (2026-10-04) — not only on the dropdown pick. Covers the pick
  // made before the settings loaded, and a kind that arrived by sync from the other computer (the kind syncs; the
  // patch is this machine's). Once per fader per mount, so a refusal is shown rather than retried in a loop.
  const patchTried = useRef<string | null>(null);
  useEffect(() => {
    if (linkInput) { patchTried.current = null; return; }
    if (!linkNeedsPatch({ isLink, cfgLoaded: !!link.cfg, daemon: !!link.cfg?.daemon, slot: config.slot,
                          inputSlot: link.cfg?.input ? link.cfg.input.slot : null })) return;
    if (patchTried.current === config.slot) return;
    patchTried.current = config.slot;
    linkTo(true);
  }, [isLink, link.cfg, linkInput, config.slot]);
  // D4 — AUTO-CUT (off by default, per station, its delay shown in Preferences): lost for autoCutSec → the channel
  // is turned OFF through the ON button's own writer, ONCE per loss, so the remote never returns to air unannounced.
  const cutFor = useRef<number | null>(null);
  useEffect(() => {
    if (!isLink || !linkInput || !linkInput.autoCut || !onSetOn || !linkRx) return;
    const lostMs = linkRx.state === "lost" ? (linkRx.lastPacketAgoMs ?? 0) : 0;
    if (linkRx.state === "receiving") { cutFor.current = null; return; }
    if (lostMs >= linkInput.autoCutSec * 1000 && isOn && cutFor.current !== linkRx.reconnects) {
      cutFor.current = linkRx.reconnects;
      onSetOn(false);
      console.warn(`[LINK] auto-cut: channel ${config.slot} turned OFF after ${Math.round(lostMs / 1000)} s of loss`);
    }
  }, [isLink, linkInput, linkRx, isOn, onSetOn, config.slot]);

  // The SOURCE dropdown's entries — src/lib/sourceKinds.ts, pinned by its test: every source kind is offered on every
  // source slot (operator requirement, 2026-10-04). Only Network is disabled, with its reason, because it has no path.
  const options = useMemo(() => sourceKindOptions(config.slot), [config.slot]);

  // A patched input names itself on the channel — "Focusrite", not "Mic".
  const label = (isMic && patch) ? patch.device
    : (isLink && linkRx?.state === "receiving" && linkRx.sender) ? `LINK · ${linkRx.sender}`
    : meta ? meta.label : `SOURCE ${letter}`;
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
            SOURCE {letter}
          </span>
          <button
            onClick={onRemove}
            title={`Remove source channel ${letter} from the board`}
            aria-label={`Remove source channel ${letter}`}
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
            // the Link: patch it in the engine on the way in, unpatch it on the way out
            if (v === "link") { onKindChange("link"); linkTo(true); return; }
            if (isLink) linkTo(false);
            onKindChange(v as SourceKind | "");
          }}
          aria-label={`Source for channel ${letter}`}
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
        {/* THE LINK'S STATE — the engine's, in words; the key, buffer, port and auto-cut live in Preferences. */}
        {isLink && (
          <button onClick={openLinkPreferences}
            title={`Remote Link: ${linkW.text}${linkRx?.reason ? ` — ${linkRx.reason}` : ""}. Key, buffer, port and auto-cut: Preferences → Broadcast → Remote Link.`}
            style={{ width: "100%", padding: "2px 4px", borderRadius: 2, cursor: "pointer", fontSize: 8, fontWeight: 700,
                     letterSpacing: "0.04em", textAlign: "left", background: "var(--bg-tertiary)",
                     border: `1px solid ${linkW.tone === "bad" ? TONE.bad : "var(--border-primary)"}`, color: TONE[linkW.tone],
                     overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            ● LINK · {linkInput ? linkW.text : "not patched — pick Link again"}
          </button>
        )}
        {/* THE FADER'S KEY — pasted from the sending computer (its Preferences → Broadcast → Remote Link). */}
        {isLink && linkInput && (linkInput.from ? (
          <div style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 8, color: "var(--text-secondary)" }}
               title={`This fader takes the feed of ${linkInput.from.name} only (key #${linkInput.from.keyId}, fingerprint ${linkInput.from.fingerprint} — compare it with the sending computer's screen). ✕ forgets the key: that computer is cut off from this fader.`}>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ← {linkInput.from.name} · key {linkInput.from.fingerprint}
            </span>
            <button onClick={() => linkKey(null)} aria-label={`Forget ${linkInput.from.name}'s key on channel ${letter}`}
              style={{ width: 14, height: 14, lineHeight: "12px", padding: 0, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
                       color: "var(--text-tertiary)", fontSize: 9, cursor: "pointer", borderRadius: 2 }}>✕</button>
          </div>
        ) : (
          // PAIRING (2026-10-04): pick the sending computer on this account, or type a guest's code. The line paste is
          // behind "Advanced" inside the picker.
          <LinkPairPicker link={link} compact label={`channel ${letter}`}
            edit={(() => { const { from: _f, ...rest } = linkInput; return rest; })()} />
        ))}
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
          // THE LINK: nothing arriving (no sender, buffering, lost) draws NOT FED — never a flat zero.
          meterNotFed={(isMic && words.tone !== "ok") || (isLink && (!linkInput || linkNotFed(linkRx)))}
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
          pendingShow={pendingShow}
          onTakeNow={onTakeNow}
        />
      </div>
    </div>
  );
}
