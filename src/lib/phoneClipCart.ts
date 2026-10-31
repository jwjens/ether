// src/lib/phoneClipCart.ts — Phone Desk → send to CART (dead-controls item 4).
//
// The CART target dispatched 'ether:phone-clip' and nothing listened, so a phone clip sent to CART went nowhere. It now
// goes through the cart wall's own path: the clip is copied into the catalogue (copy-on-import — a phone clip was
// written to the app-data folder, which does not travel), then written to the FIRST EMPTY cart slot of the active station
// with cartSlots.upsertBySlotNumber — the same upsert the wall's editors use — and the wall reloads ('ether:cart-slots-
// changed'). A full wall is said, never overwritten.

export interface CartRow { slot_number: number; file_path?: string | null }

/** The first slot number (0-based) with no audio, or null when every one of `total` slots has audio. */
export function firstEmptyCartSlot(rows: CartRow[], total: number): number | null {
  const used = new Set(rows.filter(r => r && String(r.file_path || "").trim()).map(r => Number(r.slot_number)));
  for (let i = 0; i < total; i++) if (!used.has(i)) return i;
  return null;
}

export interface PhoneCartDeps {
  stationId: number | null;
  total: number;
  list: (stationId: number) => Promise<any>;
  importIntoLibrary: (p: string) => Promise<string | null>;
  upsert: (stationId: number, slot: number, payload: { title: string; file_path: string }) => Promise<any>;
  notify: () => void;
}

/** → { ok, slot?, message } */
export async function sendClipToCart(filePath: string, title: string, d: PhoneCartDeps): Promise<{ ok: boolean; slot?: number; message: string }> {
  if (d.stationId == null) return { ok: false, message: "No station is active, so there is no cart wall to put the clip on." };
  const res = await d.list(d.stationId);
  const rows: CartRow[] = Array.isArray(res) ? res : (res?.rows ?? []);
  const slot = firstEmptyCartSlot(rows, d.total);
  if (slot == null) return { ok: false, message: `Every cart (all ${d.total}) has audio. Clear one on the cart wall, then send again.` };
  const lib = await d.importIntoLibrary(filePath);
  if (!lib) return { ok: false, message: "The clip was not added to the catalogue, so no cart was changed." };
  const r = await d.upsert(d.stationId, slot, { title, file_path: lib });
  if (r && r.ok === false) return { ok: false, message: `The cart was not saved: ${r.error || "unknown error"}` };
  d.notify();
  return { ok: true, slot, message: `Sent to Cart ${slot + 1}.` };
}
