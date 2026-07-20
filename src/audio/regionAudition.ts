// regionAudition — the ONE shared region-audition mechanic, worn by BOTH imaging surfaces: the Reel
// Splitter push-up and the StudioPro DAW chop-and-send (per CLAUDE.md: "one region engine, two surfaces,
// never a copy"). Plays a [start,end) window of a decoded buffer through a throwaway BufferSource on a
// self-contained AudioContext — it NEVER touches the on-air engine/decks (broadcast is unaffected).

/** Audition a region of a decoded buffer. Returns the source so the caller can .stop() it. onEnded fires
 *  when the window finishes on its own. Clamps to a 20ms floor so a zero-length selection still ticks. */
export function auditionRegion(
  ctx: AudioContext,
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  onEnded?: () => void,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  if (onEnded) src.onended = onEnded;
  src.start(0, Math.max(0, startSec), Math.max(0.02, endSec - startSec));
  return src;
}
