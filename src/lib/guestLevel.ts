// src/lib/guestLevel.ts — the GUEST strip's meter (dead-controls item 24). The board listened for 'ether:guest-level' and
// nothing ever sent it, so the meter could never move. Show+'s WebRTC layer (useWebRTCGuests in ShowPlus.tsx), which
// holds each guest's audio, now measures it and sends one level per guest ~10 times a second, to every window.

/** The board slot of the i-th guest: E, F, G… — the inverse of ShowPlus's slotToIndex, the mapping the strip's ON and
 *  fader already use. */
export const guestSlot = (index: number) => String.fromCharCode("E".charCodeAt(0) + index);

/** Byte frequency data (AnalyserNode.getByteFrequencyData) → 0..1, the same reading Show+'s own guest meters show. A
 *  muted guest reads 0: muted, nothing of that guest reaches the show. */
export function guestLevelFrom(buf: ArrayLike<number>, muted: boolean): number {
  if (muted || !buf || buf.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  return Math.min(1, sum / buf.length / 128);
}

export const GUEST_LEVEL_EVERY_MS = 100;
