// Remote Link pairing, renderer side (Jeff's ruling, 2026-10-04: the link key is never copied or typed by hand).

/** The backend's code alphabet: no 0/O, 1/I/L (ether-backend src/lib/link-pairing.js). */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** What the receiver has typed so far → shown as XXXX-XXXX while typing. Anything outside the alphabet is dropped. */
export function formatCodeTyping(input: string): string {
  const s = [...String(input || "").toUpperCase()].filter(ch => CODE_ALPHABET.includes(ch)).join("").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}
export const codeComplete = (formatted: string) => formatted.replace("-", "").length === 8;

/** Does THIS fader need patching into this machine's engine? A fader whose source is Link always is — whether the
 *  pick happened before the Link settings loaded or the kind arrived by sync from the other computer. Never steals the
 *  station's Link from another fader (one Link input per station). */
export function linkNeedsPatch(a: { isLink: boolean; cfgLoaded: boolean; daemon: boolean; slot: string; inputSlot: string | null }): boolean {
  return a.isLink && a.cfgLoaded && a.daemon && a.inputSlot == null;
}
