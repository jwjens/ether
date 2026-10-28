// THE PATCH BAY, INPUTS — the rules, pure (step 2 of docs/ether-audio-patch-bay-plan.md).
//
// What feeds a source fader is held in three records, and nowhere else:
//   deck_configs.kind          the fader's SOURCE dropdown on the board ("mic", "link", "cart", …)
//   station_config_kv mic_input_<slot>   which input on THIS computer a mic fader takes (machine-local)
//   station_config_kv link_input         which fader the station's Remote Link feed comes in on (machine-local)
// The board's SOURCE dropdown (SourceChannelStrip) and the Patch Bay's inputs grid both READ those three and both WRITE
// them through the same writers (deck_configs:update-by-slot, mic:set, link:set-input). Neither keeps a copy, so they
// cannot disagree. Jeff (2026-10-28): "The fader SOURCE dropdown on the board stays as it is and must agree with the
// inputs grid." src/lib/inputPatch.test.ts holds the agreement.

export type MicPatchLike = { device: string; channel: number; gainDb: number };

/** A column of the inputs grid: one input channel of one device on this computer (a Park mic is a device with one
 *  channel, "park:<n>"), or the station's Remote Link feed. */
export type InputCol =
  | { kind: "device"; device: string; channel: number }
  | { kind: "link" };

/** What a fader's three records say it is fed by. */
export type FaderInput =
  | { type: "mic"; device: string; channel: number }   // a mic fader with an input patched
  | { type: "mic-unpatched" }                         // set to Mic on the board, no input picked yet
  | { type: "link" }                                  // set to Link, and the station's Link feed is on this fader
  | { type: "link-unpatched" }                        // set to Link, but the Link feed is not on this fader
  | { type: "other"; kind: string }                   // a file source (cart, jukebox, sweeper, announcement…)
  | { type: "none" };                                 // no source

export type FaderRecords = { kind: string; micPatch: MicPatchLike | null | undefined; linkInputSlot: string | null | undefined };

export function faderInput(slot: string, r: FaderRecords): FaderInput {
  if (r.kind === "mic") return r.micPatch ? { type: "mic", device: r.micPatch.device, channel: r.micPatch.channel } : { type: "mic-unpatched" };
  if (r.kind === "link") return r.linkInputSlot === slot ? { type: "link" } : { type: "link-unpatched" };
  if (r.kind) return { type: "other", kind: r.kind };
  return { type: "none" };
}

/** The board's SOURCE dropdown value — the one expression SourceChannelStrip renders its <select> with. */
export const MIC_VALUE_PREFIX = "mic:";
export function stripSourceValue(kind: string, micPatch: MicPatchLike | null | undefined): string {
  return kind === "mic" ? (micPatch ? MIC_VALUE_PREFIX + micPatch.device : "mic") : (kind || "");
}

/** Is this crosspoint connected? */
export function crosspointOn(f: FaderInput, col: InputCol): boolean {
  if (col.kind === "link") return f.type === "link";
  return f.type === "mic" && f.device === col.device && f.channel === col.channel;
}

/** One write, through the board's own writers. Applied in order; a refused step stops the rest. */
export type Step =
  | { op: "mic"; slot: string; patch: MicPatchLike | null }   // mic:set (engine first, stored on ok)
  | { op: "link"; slot: string | null }                        // link:set-input — the feed onto this fader, or off
  | { op: "kind"; slot: string; kind: string };                // deck_configs:update-by-slot {kind}

export type StationRecords = {
  kinds: Record<string, string>;                               // slot → deck_configs.kind
  micPatches: Record<string, MicPatchLike | undefined>;        // slot → mic_input_<slot>
  linkInputSlot: string | null;                                // link_input.slot
};

/** Click on an empty crosspoint: connect `col` to fader `slot`. Engine patches first, the board's kind last, so a
 *  refused patch never leaves the dropdown saying something the engine is not doing. */
export function planConnect(slot: string, col: InputCol, s: StationRecords): Step[] {
  const steps: Step[] = [];
  const kind = s.kinds[slot] || "";
  const mic = s.micPatches[slot];
  if (col.kind === "device") {
    // Leaving the Link on this fader releases it, exactly as the dropdown does.
    if (kind === "link" && s.linkInputSlot === slot) steps.push({ op: "link", slot: null });
    steps.push({ op: "mic", slot, patch: { device: col.device, channel: col.channel, gainDb: mic?.gainDb ?? 0 } });
    if (kind !== "mic") steps.push({ op: "kind", slot, kind: "mic" });
    return steps;
  }
  // The Link: one feed per station, so it moves here from wherever it was.
  if (mic) steps.push({ op: "mic", slot, patch: null });
  steps.push({ op: "link", slot });
  if (kind !== "link") steps.push({ op: "kind", slot, kind: "link" });
  const from = s.linkInputSlot;
  if (from && from !== slot && (s.kinds[from] || "") === "link") steps.push({ op: "kind", slot: from, kind: "" });
  return steps;
}

/** Click on a connected crosspoint: the fader is fed by nothing — the dropdown's "— no source —". */
export function planDisconnect(slot: string, col: InputCol, s: StationRecords): Step[] {
  const steps: Step[] = [];
  if (col.kind === "link") { if (s.linkInputSlot === slot) steps.push({ op: "link", slot: null }); }
  else if (s.micPatches[slot]) steps.push({ op: "mic", slot, patch: null });
  steps.push({ op: "kind", slot, kind: "" });
  return steps;
}

/** The records after `steps` — what the board and the grid will both read next. Used by the agreement test. */
export function applySteps(s: StationRecords, steps: Step[]): StationRecords {
  const n: StationRecords = { kinds: { ...s.kinds }, micPatches: { ...s.micPatches }, linkInputSlot: s.linkInputSlot };
  for (const st of steps) {
    if (st.op === "kind") n.kinds[st.slot] = st.kind;
    else if (st.op === "mic") { if (st.patch) n.micPatches[st.slot] = st.patch; else delete n.micPatches[st.slot]; }
    else n.linkInputSlot = st.slot;
  }
  return n;
}

/** The grid's columns: every input channel of every input device here (Park mics included), the Link, and any patched
 *  device that is NOT here, so it can be seen and disconnected — never hidden. */
export type InputDevice = { name: string; channels: number; label?: string; park?: number };
export type GridCol = InputCol & { label: string; present: boolean };
export function inputColumns(devices: InputDevice[], patched: MicPatchLike[]): GridCol[] {
  const out: GridCol[] = [];
  for (const d of devices) {
    const n = Math.max(1, d.channels || 1);
    for (let c = 1; c <= n; c++) out.push({ kind: "device", device: d.name, channel: c, label: d.label || d.name, present: true });
  }
  for (const p of patched) {
    if (!out.some(c => c.kind === "device" && c.device === p.device && c.channel === p.channel))
      out.push({ kind: "device", device: p.device, channel: p.channel, label: p.device, present: false });
  }
  out.push({ kind: "link", label: "Remote Link", present: true });
  return out;
}
