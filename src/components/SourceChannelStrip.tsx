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

import { useMemo, useState, useEffect, useRef } from "react";
import ConsoleStrip from "./ConsoleStrip";
import { SOURCE_KINDS, sourceKindMeta, deckLetter, type SourceKind, type DeckConfig } from "./DeckConfigurator";
import { canHostJukebox, isSweeperKind } from "./DeckConfigurator";

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
  // Jeff, 2026-09-02: "all device inputs discoverable should be in the one dropdown source list".
  // So the dropdown does NOT offer an abstract "Mic" that then makes you pick a device on a second
  // control — it offers the DEVICES THEMSELVES, by their real names (Realtek, Communications, a
  // Focusrite, a Behringer). Picking one patches this channel to that input. The dropdown stays put,
  // so the channel can be patched back to Announcement or a cart at any time: the first attempt at
  // this replaced the whole strip with a mic panel and stranded the operator with no way back.
  const MIC_PREFIX = "mic:";
  const deviceKey = `ether_mic_device_${config.slot}`;
  const [micDeviceId, setMicDeviceId] = useState<string>(() => {
    try { return localStorage.getItem(deviceKey) || ""; } catch { return ""; }
  });
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  // PRE-FADER level for a patched input. It cannot come from the audio:levels IPC like every other
  // channel: a Web Audio capture never reaches the Rust engine, so the engine has no slot to report.
  // Measured here from the stream itself, and fed to ConsoleStrip as its `level` prop.
  const [micLevel, setMicLevel] = useState(0);

  // enumerateDevices() returns EMPTY LABELS until the page has been granted capture once — the list
  // would read "Input 1 / Input 2" instead of the device names, which is the whole point here. One
  // throwaway getUserMedia unlocks the labels, then it is stopped immediately (AudioDevices.tsx does
  // the same). Re-runs on devicechange so plugging in an interface shows up without a restart.
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        let ds = await navigator.mediaDevices.enumerateDevices();
        if (ds.some(d => d.kind === "audioinput" && !d.label)) {
          try {
            const s = await navigator.mediaDevices.getUserMedia({ audio: true });
            s.getTracks().forEach(tr => tr.stop());
            ds = await navigator.mediaDevices.enumerateDevices();
          } catch { /* denied — fall through with whatever labels exist */ }
        }
        if (!stop) setInputs(ds.filter(d => d.kind === "audioinput" && d.deviceId));
      } catch { /* no device API — the file sources still work */ }
    };
    load();
    navigator.mediaDevices?.addEventListener?.("devicechange", load);
    return () => { stop = true; navigator.mediaDevices?.removeEventListener?.("devicechange", load); };
  }, []);

  // Capture — the same path MicChannel has used since 52d33bb: own stream, own AudioContext, browser
  // DSP off (AEC/AGC/NS), output through a gain node the channel's ON and fader drive. Runs only
  // while this channel is patched to an input, and is torn down on unpatch or device change.
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef    = useRef<AudioContext | null>(null);
  const gainRef   = useRef<GainNode | null>(null);
  const rafRef    = useRef(0);
  const isOnRef   = useRef(isOn);
  const volRef    = useRef(volume);
  useEffect(() => { isOnRef.current = isOn; }, [isOn]);
  useEffect(() => { volRef.current = volume; }, [volume]);

  useEffect(() => {
    if (config.kind !== "mic" || !micDeviceId) return;
    let cancelled = false;
    navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: micDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    }).then(stream => {
      if (cancelled) { stream.getTracks().forEach(tr => tr.stop()); return; }
      streamRef.current = stream;
      const ctx = new AudioContext(); ctxRef.current = ctx;
      const src  = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain(); gainRef.current = gain;
      gain.gain.value = isOnRef.current ? volRef.current : 0;
      // PRE-FADER tap: the analyser hangs off the SOURCE, not off the gain, so the meter shows the
      // mic even with the channel off or the fader down — which is what a pre-fader meter is for
      // (you set gain before you open the channel). Same placement MicChannel uses.
      const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
      src.connect(analyser);
      src.connect(gain);
      gain.connect(ctx.destination);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / data.length / 255;
        setMicLevel(Math.min(1, avg * 3));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }).catch(e => console.error(`[source ${config.slot}] input capture failed:`, e));
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(tr => tr.stop()); streamRef.current = null;
      ctxRef.current?.close().catch(() => {}); ctxRef.current = null; gainRef.current = null;
      setMicLevel(0);
    };
  }, [config.kind, micDeviceId, config.slot]);

  // ON + fader drive the output gate, exactly as they do for any other channel.
  useEffect(() => { if (gainRef.current) gainRef.current.gain.value = isOn ? volume : 0; }, [isOn, volume]);

  const micDeviceLabel = inputs.find(d => d.deviceId === micDeviceId)?.label || "";


  // Jukebox is offerable only where it can actually be routed. Automation enumerates A/B/C and
  // nothing else, so the jukebox has always been restricted to the aux slots; the new engine slots
  // (S1..) are not wired to it yet. Offering it where it cannot play would be exactly the decorative
  // control this strip exists to avoid — so it is disabled with the reason, never silently missing.
  const options = useMemo(() => SOURCE_KINDS.map(k => {
    if (k.kind === "jukebox" && !canHostJukebox(config.slot)) {
      return { ...k, disabled: true, why: `Jukebox routes on D/E/F only — not ${config.slot}` };
    }
    // MIC IS NOT PHASE 2. Its capture path already exists and always has — MicChannel does
    // getUserMedia + Web Audio per slot (own device, meter), built by 52d33bb and
    // still rendered from App for decks typed "mic". What was missing was the DOOR: board slice 2
    // made SOURCE the way to patch a channel, and this gate gr(e)yed mic out with everything else in
    // the stream family, so an operator who patched by SOURCE could no longer reach a mic that works.
    // Network stays disabled — it genuinely has no path.
    if (k.family === "stream" && k.kind !== "mic") {
      return { ...k, disabled: true, why: "Phase 2 — needs the engine capture path" };
    }
    return { ...k, disabled: false, why: "" };
  }), [config.slot]);

  // A patched input names itself on the channel — "Focusrite", not "Mic".
  const label = (config.kind === "mic" && micDeviceLabel) ? micDeviceLabel
    : meta ? meta.label : `SOURCE ${deckLetter(config.slot)}`;

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
          value={config.kind === "mic" && micDeviceId ? MIC_PREFIX + micDeviceId : (config.kind || "")}
          onChange={e => {
            const v = e.target.value;
            if (v.startsWith(MIC_PREFIX)) {
              const id = v.slice(MIC_PREFIX.length);
              setMicDeviceId(id);
              try { localStorage.setItem(deviceKey, id); } catch { /* ignore */ }
              if (config.kind !== "mic") onKindChange("mic");
              return;
            }
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
          {/* The abstract "Mic (device…)" entry is gone — the devices below ARE the mic entries. */}
          {options.filter(o => o.kind !== "mic").map(o => (
            <option key={o.kind} value={o.kind} disabled={o.disabled}>
              {o.label}{o.disabled ? " ·  not yet" : ""}
            </option>
          ))}
          {inputs.length > 0 && (
            <optgroup label="INPUT DEVICES">
              {inputs.map(d => (
                <option key={d.deviceId} value={MIC_PREFIX + d.deviceId}>
                  {d.label || "Audio input"}
                </option>
              ))}
            </optgroup>
          )}
        </select>

        {/* DUCK — the one control §B.6 exposes today. Threshold, attack, hold, release and depth
            are implemented with the design's defaults but have no tuning UI yet, so this says ON/OFF
            and nothing more. A control that implied tunability it does not have would be the same
            defect as the AUTO-DUCK button this replaces. */}
        {/* NO DUCK CONTROL ON A SWEEPER CHANNEL. A sweeper joins the programme bus, and only a
            SOURCE-bus slot can arm the ducker (native/src/audio.rs, the arming branch is gated on
            the slot's kind). That is A.8's guarantee — a sweeper must never duck the song it is
            sweeping into — and it is structural, not a setting. Rendering a toggle that the engine
            will never honour is the honest-UI defect this project treats as a bug. */}
        {isSweeperKind(config.kind) ? (
          <div style={{
            fontSize: 8, lineHeight: 1.25, color: "var(--text-tertiary)",
            border: "1px solid var(--border-primary)", padding: "3px 4px", borderRadius: 2,
            textAlign: "center" as const,
          }}>
            SWEEPERS RIDE WITH THE MUSIC — never duck it
          </div>
        ) : (
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
        )}

      </div>

      {/* ── the channel itself ──────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <ConsoleStrip
          label={label}
          color="#8868D8"
          volume={volume}
          // deckId makes ConsoleStrip drive its meter from the audio:levels IPC and explicitly hide
          // the level-prop meter (ConsoleStrip.tsx:425, display: deckId ? "none" : ...). A patched
          // input has no engine slot to report, so for mic we withhold deckId and feed `level`
          // instead. Every other source kind keeps the IPC meter exactly as before.
          deckId={config.kind === "mic" ? undefined : config.slot}
          level={config.kind === "mic" ? micLevel : undefined}
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
