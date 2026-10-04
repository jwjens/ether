// auxFault — is this strip's slot cut off from the room because the aux output is down? (2026-10-04, OV)
//
// An aux-routed slot (bit n of the meters frame's `auxRouted`: SlotKind::Source — D/E/F, S1..S5) reaches the room
// ONLY through the aux output. Its pre-fader meter is real signal either way, so with the aux down the strip would
// show a healthy level for audio nobody can hear. The strip draws NOT FED with this text instead.
// No aux device chosen is the operator's routing (no device = silence, by ruling) and is not a fault; a frame from
// an engine that predates these fields carries none of them, and nothing changes.
import type { MeterFrameMsg } from "./meterStore";

const STATE_WORDS: Record<string, string> = { opening: "opening", not_found: "not found", failed: "failed" };

export function auxFaultFor(frame: MeterFrameMsg | null | undefined,
                            slotIndex: number | undefined): string | null {
  if (!frame || slotIndex === undefined || slotIndex < 0) return null;
  const { auxState, auxDevice, auxRouted } = frame;
  if (typeof auxRouted !== "number" || !auxDevice || !auxState || auxState === "open" || auxState === "none") return null;
  if (((auxRouted >> slotIndex) & 1) !== 1) return null;
  return `aux output down — "${auxDevice}" ${STATE_WORDS[auxState] ?? auxState}; this channel is not reaching the room`;
}
